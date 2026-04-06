"""
Bid optimization engine using linear programming (PuLP).

Objective (minimise, since PuLP minimises):
  Σ_b [ -price[b]·v[b]                   # maximise cleared value
        + λ1·(d_over[b] + d_under[b])·price[b]·DSM_PENALTY_RATE  # DSM penalty cost
        + λ2·ci_width[b]·v[b] ]           # uncertainty penalty

Decision variables:
  v[b]       ≥ 0        volume in MW per block
  d_over[b]  ≥ 0        MW deviation above 1.1×load[b]
  d_under[b] ≥ 0        MW deviation below 0.9×load[b]

Hard constraints:
  Σ v[b] ≤ total_demand_mw          (don't overbuy in aggregate)
  v[b]   ≤ per_block_cap            (no single-block concentration)
  v[b]   ≥ 1.0  (DAM/RTM)          (CERC technical minimum)
  d_over[b]  ≥ v[b] - 1.1·load[b]  (linearise over-deviation)
  d_under[b] ≥ 0.9·load[b] - v[b]  (linearise under-deviation)

λ1, λ2 are derived from strategy risk_tolerance:
  λ1 = (1 - risk_tolerance) × 2.0
  λ2 = (1 - risk_tolerance) × 1.5
"""

import logging

import numpy as np
from pulp import (
    LpProblem,
    LpMinimize,
    LpVariable,
    lpSum,
    PULP_CBC_CMD,
    value as lp_value,
)

from backend.common.config import (
    DSM_PRICE_FLOOR,
    DSM_PRICE_CEILING,
    DSM_DEVIATION_BAND,
    DSM_PENALTY_RATE,
    STRATEGY_PROFILES,
    NUM_BLOCKS,
    BLOCK_DURATION_MIN,
)
from backend.common.schemas import ConstraintViolation

logger = logging.getLogger(__name__)

# Max volume a single block may receive (4× average = 4/96 of daily demand).
# Prevents the LP from dumping all volume into the single cheapest block.
_PER_BLOCK_CAP_FACTOR = 4.0


def validate_constraints(
    block: int, price: float, volume_mw: float, segment: str
) -> list[ConstraintViolation]:
    """Check a single bid against DSM and market constraints."""
    violations = []

    if price < DSM_PRICE_FLOOR:
        violations.append(
            ConstraintViolation(
                block=block,
                field="price",
                value=price,
                limit=DSM_PRICE_FLOOR,
                message=f"Price {price:.2f} below DSM floor {DSM_PRICE_FLOOR}",
            )
        )

    if price > DSM_PRICE_CEILING:
        violations.append(
            ConstraintViolation(
                block=block,
                field="price",
                value=price,
                limit=DSM_PRICE_CEILING,
                message=f"Price {price:.2f} exceeds DSM ceiling {DSM_PRICE_CEILING}",
            )
        )

    if volume_mw < 0:
        violations.append(
            ConstraintViolation(
                block=block,
                field="volume_mw",
                value=volume_mw,
                limit=0.0,
                message="Volume cannot be negative",
            )
        )

    # Technical minimum: 1 MW for DAM/RTM
    if segment in ("DAM", "RTM") and 0 < volume_mw < 1.0:
        violations.append(
            ConstraintViolation(
                block=block,
                field="volume_mw",
                value=volume_mw,
                limit=1.0,
                message=f"Volume {volume_mw:.2f} MW below technical minimum of 1 MW for {segment}",
            )
        )

    return violations


def generate_recommendations(
    forecasts: list[dict],
    strategy: str,
    demand_mw: float,
    segment: str,
    price_offset_override: float | None = None,
    risk_tolerance_override: float | None = None,
    volume_scale_override: float | None = None,
    per_block_cap_factor: float = _PER_BLOCK_CAP_FACTOR,
) -> list[dict]:
    """
    Generate LP-optimised bid recommendations for all 96 blocks.

    Bid price is fixed per block (predicted MCP ± strategy offset × volatility).
    Volume allocation is the LP decision variable, optimised to maximise cleared
    value while penalising DSM deviation risk and forecast uncertainty.
    """
    profile = STRATEGY_PROFILES[strategy]
    price_offset = price_offset_override if price_offset_override is not None else profile["price_offset"]
    risk_tolerance = risk_tolerance_override if risk_tolerance_override is not None else profile["risk_tolerance"]
    volume_scale = volume_scale_override if volume_scale_override is not None else profile["volume_scale"]

    # λ weights: higher risk_tolerance → lower penalty → more aggressive
    lambda1 = (1.0 - risk_tolerance) * 2.0  # DSM penalty weight
    lambda2 = (1.0 - risk_tolerance) * 1.5  # uncertainty (CI width) weight

    # Uniform scheduled load per block (MW) — baseline for DSM deviation check
    load_per_block = demand_mw / NUM_BLOCKS
    per_block_cap = load_per_block * per_block_cap_factor

    # Pre-compute bid prices and CI widths (these are fixed, not LP variables)
    block_data: dict[int, dict] = {}
    for fc in forecasts:
        b = fc["block"]
        pred = fc["predicted_price"]
        vol = fc.get("volatility", pred * 0.1)
        ci_low = fc.get("confidence_low", pred - vol)
        ci_high = fc.get("confidence_high", pred + vol)
        ci_width = max(ci_high - ci_low, 0.0)

        bid_price = pred + price_offset * vol
        bid_price = max(bid_price, DSM_PRICE_FLOOR + 0.01)
        bid_price = min(bid_price, DSM_PRICE_CEILING - 0.01)

        block_data[b] = {
            "pred_price": pred,
            "bid_price": bid_price,
            "ci_width": ci_width,
            "volatility": vol,
        }

    blocks = sorted(block_data.keys())

    # ── Build LP ────────────────────────────────────────────────────────
    prob = LpProblem("bid_optimisation", LpMinimize)

    # Decision variables
    v = {b: LpVariable(f"v_{b}", lowBound=0.0, upBound=per_block_cap) for b in blocks}
    d_over = {b: LpVariable(f"d_over_{b}", lowBound=0.0) for b in blocks}
    d_under = {b: LpVariable(f"d_under_{b}", lowBound=0.0) for b in blocks}

    # Objective: minimise negative cleared value + DSM penalty cost + uncertainty cost
    prob += lpSum(
        -block_data[b]["bid_price"] * v[b]
        + lambda1
        * (d_over[b] + d_under[b])
        * block_data[b]["bid_price"]
        * DSM_PENALTY_RATE
        + lambda2 * block_data[b]["ci_width"] * v[b]
        for b in blocks
    )

    # Constraint 1: total volume ≤ total daily demand × volume_scale
    prob += lpSum(v[b] for b in blocks) <= demand_mw * volume_scale

    for b in blocks:
        load = load_per_block

        # Constraint 2: DSM linearisation — over-deviation auxiliary
        # d_over[b] ≥ v[b] - (1 + DSM_DEVIATION_BAND) × load
        prob += d_over[b] >= v[b] - (1.0 + DSM_DEVIATION_BAND) * load

        # Constraint 3: DSM linearisation — under-deviation auxiliary
        # d_under[b] ≥ (1 - DSM_DEVIATION_BAND) × load - v[b]
        prob += d_under[b] >= (1.0 - DSM_DEVIATION_BAND) * load - v[b]

        # Constraint 4: CERC technical minimum for DAM/RTM
        # Enforce as a lower bound only if demand is large enough to warrant it
        if segment in ("DAM", "RTM") and load_per_block >= 1.0:
            prob += v[b] >= 1.0

    # ── Solve ───────────────────────────────────────────────────────────
    solver = PULP_CBC_CMD(msg=0)  # suppress CBC stdout
    status = prob.solve(solver)

    # Fall back to uniform allocation if LP fails (infeasible / unbounded)
    if status != 1:
        logger.warning(
            "LP solver returned status %s for strategy=%s segment=%s — "
            "falling back to uniform allocation",
            status,
            strategy,
            segment,
        )
        uniform_vol = demand_mw / NUM_BLOCKS
        lp_volumes = {b: uniform_vol for b in blocks}
    else:
        lp_volumes = {b: max(lp_value(v[b]) or 0.0, 0.0) for b in blocks}

    # ── Build response ──────────────────────────────────────────────────
    duration_hours = BLOCK_DURATION_MIN / 60.0
    recommendations = []

    for b in blocks:
        bd = block_data[b]
        vol_mw = round(lp_volumes[b], 1)

        # Apply technical minimum post-solve (can't encode as conditional in LP)
        if segment in ("DAM", "RTM") and 0 < vol_mw < 1.0:
            vol_mw = 1.0

        # DSM penalty estimate for this block (informational, used by UI)
        deviation = abs(vol_mw - load_per_block) / max(load_per_block, 0.01)
        excess_dev = max(0.0, deviation - DSM_DEVIATION_BAND)
        dsm_penalty_est = round(
            excess_dev
            * load_per_block
            * bd["bid_price"]
            * DSM_PENALTY_RATE
            * duration_hours
            * 1000,
            2,
        )

        violations = validate_constraints(b, bd["bid_price"], vol_mw, segment)

        recommendations.append(
            {
                "block": b,
                "segment": segment,
                "price": round(bd["bid_price"], 4),
                "volume_mw": vol_mw,
                "strategy": strategy,
                "dsm_penalty_estimate": dsm_penalty_est,
                "uncertainty_score": round(bd["ci_width"], 4),
                "constraint_violations": [v_.model_dump() for v_ in violations],
            }
        )

    return sorted(recommendations, key=lambda r: r["block"])
