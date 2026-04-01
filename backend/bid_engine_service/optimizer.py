"""
Bid optimization engine using linear programming (PuLP).
Generates volume/price recommendations under DSM constraints per strategy.
"""

import numpy as np
from pulp import LpProblem, LpMinimize, LpVariable, lpSum, PULP_CBC_CMD

from backend.common.config import (
    DSM_PRICE_FLOOR,
    DSM_PRICE_CEILING,
    DSM_DEVIATION_BAND,
    STRATEGY_PROFILES,
    NUM_BLOCKS,
)
from backend.common.schemas import ConstraintViolation


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
) -> list[dict]:
    """
    Generate optimized bid recommendations for all 96 blocks.
    Uses forecasted prices + strategy profile to set price/volume.
    """
    profile = STRATEGY_PROFILES[strategy]
    price_offset = profile["price_offset"]
    volume_scale = profile["volume_scale"]
    risk_tolerance = profile["risk_tolerance"]

    recommendations = []
    total_demand = demand_mw

    # Sort blocks by predicted price (buy low)
    sorted_blocks = sorted(forecasts, key=lambda f: f["predicted_price"])

    # Allocate more volume to cheaper blocks
    prices = np.array([f["predicted_price"] for f in sorted_blocks])
    # Inverse price weighting: cheaper blocks get more volume
    weights = 1.0 / np.clip(prices, 0.1, None)
    weights = weights / weights.sum()

    volume_per_block = weights * total_demand * volume_scale

    block_allocations = {}
    for f, vol in zip(sorted_blocks, volume_per_block):
        block_allocations[f["block"]] = vol

    for fc in forecasts:
        block = fc["block"]
        pred_price = fc["predicted_price"]
        volatility = fc.get("volatility", pred_price * 0.1)

        # Adjust bid price based on strategy
        # Conservative: bid lower to ensure clearing
        # Aggressive: bid higher, willing to risk non-clearing
        bid_price = pred_price + price_offset * volatility
        bid_price = max(bid_price, DSM_PRICE_FLOOR + 0.01)
        bid_price = min(bid_price, DSM_PRICE_CEILING - 0.01)

        vol = max(block_allocations.get(block, total_demand / NUM_BLOCKS), 0)
        # Round to 1 decimal
        vol = round(vol, 1)
        if segment in ("DAM", "RTM") and 0 < vol < 1.0:
            vol = 1.0  # technical minimum

        violations = validate_constraints(block, bid_price, vol, segment)

        recommendations.append(
            {
                "block": block,
                "segment": segment,
                "price": round(bid_price, 4),
                "volume_mw": vol,
                "strategy": strategy,
                "constraint_violations": [v.model_dump() for v in violations],
            }
        )

    return sorted(recommendations, key=lambda r: r["block"])
