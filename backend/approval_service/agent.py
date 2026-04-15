"""Agentic Bid Approval Agent.

Evaluates a bid set across 7 structured checks and produces a verdict that
gates submission.  All logic is deterministic and rule-based — no LLM calls
required — so latency is <5 ms even for 96-block sets.

Check taxonomy
--------------
Hard checks (each weight 25 pts):
  1. coverage            — all 96 blocks have bids
  2. constraint_compliance — zero DSM band / technical-min violations
  3. risk_exposure       — risk alert not triggered
  4. price_ceiling       — no bids at ₹12/kWh ceiling

Soft checks (each weight 10 pts):
  5. forecast_confidence — not too many wide-CI blocks
  6. override_ratio      — manual overrides below 40 %
  7. strategy_alignment  — avg bid price consistent with declared strategy

Verdict logic
-------------
  Hard fails ≥ 2  → REJECTED
  Hard fails == 1 → NEEDS_REVISION
  Soft warns only → APPROVED_WITH_FLAGS
  All pass        → APPROVED

can_submit is True only for APPROVED / APPROVED_WITH_FLAGS.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Literal

logger = logging.getLogger(__name__)

# ── Thresholds ──────────────────────────────────────────────────────────────
COVERAGE_REQUIRED = 96
MAX_OVERRIDE_RATIO = 0.40          # 40 % overrides → warn
CI_WIDTH_RATIO_WARN = 2.5          # CI width > 2.5× predicted → low confidence
CI_POOR_BLOCK_RATIO = 0.20         # 20 % of blocks with poor CI → warn
NEAR_CEILING_RATE = 11.0           # INR/kWh — warn when conservative/balanced
CEILING_RATE = 12.0                # INR/kWh — hard fail at ceiling
CONSERVATIVE_ABOVE_PRED_MAX = 0.10 # conservative bids ≤ pred + 10 %
AGGRESSIVE_BELOW_PRED_MIN = -0.05  # aggressive bids ≥ pred − 5 %


@dataclass
class ApprovalCheck:
    name: str
    category: Literal["hard", "soft"]
    status: Literal["pass", "warn", "fail"]
    message: str
    affected_blocks: list[int] = field(default_factory=list)


def run_approval_agent(
    bids: list[dict],
    forecasts: dict[int, dict],   # block → {predicted_price, confidence_low, confidence_high}
    risk_result: dict | None,
    strategy: str,
    segment: str,
) -> dict:
    """Run all approval checks and return a result dict."""
    checks: list[ApprovalCheck] = []
    bids_by_block = {b["block"]: b for b in bids}

    # ── 1. Coverage ─────────────────────────────────────────────────────────
    covered = set(bids_by_block.keys())
    missing = [b for b in range(1, COVERAGE_REQUIRED + 1) if b not in covered]
    if missing:
        checks.append(ApprovalCheck(
            name="coverage",
            category="hard",
            status="fail",
            message=f"{len(missing)} of 96 blocks missing bids (first few: {missing[:5]}).",
            affected_blocks=missing[:20],
        ))
    else:
        checks.append(ApprovalCheck(
            name="coverage",
            category="hard",
            status="pass",
            message="All 96 blocks have bids.",
        ))

    # ── 2. Constraint compliance ─────────────────────────────────────────────
    violated_blocks = [
        b["block"] for b in bids
        if b.get("constraint_violations")
    ]
    if violated_blocks:
        checks.append(ApprovalCheck(
            name="constraint_compliance",
            category="hard",
            status="fail",
            message=f"{len(violated_blocks)} blocks violate DSM price band or technical minimums.",
            affected_blocks=violated_blocks[:20],
        ))
    else:
        checks.append(ApprovalCheck(
            name="constraint_compliance",
            category="hard",
            status="pass",
            message="No constraint violations — all bids within DSM price band.",
        ))

    # ── 3. Risk exposure ─────────────────────────────────────────────────────
    if risk_result:
        if risk_result.get("alert_triggered"):
            exposure = risk_result.get("total_exposure", 0)
            var95 = risk_result.get("var_95", 0)
            checks.append(ApprovalCheck(
                name="risk_exposure",
                category="hard",
                status="fail",
                message=(
                    f"Risk alert active: total exposure ₹{exposure:,.0f}, "
                    f"VaR@95% ₹{var95:,.0f} exceeds threshold."
                ),
            ))
        else:
            var95 = risk_result.get("var_95", 0)
            checks.append(ApprovalCheck(
                name="risk_exposure",
                category="hard",
                status="pass",
                message=f"Risk within threshold. VaR@95% = ₹{var95:,.0f}.",
            ))
    else:
        checks.append(ApprovalCheck(
            name="risk_exposure",
            category="soft",
            status="warn",
            message="No risk snapshot found. Run risk assessment before submission.",
        ))

    # ── 4. Price ceiling sanity ──────────────────────────────────────────────
    ceiling_blocks = [b["block"] for b in bids if b["price"] >= CEILING_RATE]
    near_ceiling_blocks = [
        b["block"] for b in bids
        if NEAR_CEILING_RATE <= b["price"] < CEILING_RATE
        and strategy in ("conservative", "balanced")
    ]
    if ceiling_blocks:
        checks.append(ApprovalCheck(
            name="price_ceiling",
            category="hard",
            status="fail",
            message=f"{len(ceiling_blocks)} bids at DSM ceiling (₹12/kWh) — submission blocked.",
            affected_blocks=ceiling_blocks[:20],
        ))
    elif near_ceiling_blocks:
        checks.append(ApprovalCheck(
            name="price_ceiling",
            category="soft",
            status="warn",
            message=(
                f"{len(near_ceiling_blocks)} bids ≥ ₹11/kWh with {strategy} strategy. "
                "Review high-price blocks."
            ),
            affected_blocks=near_ceiling_blocks[:20],
        ))
    else:
        checks.append(ApprovalCheck(
            name="price_ceiling",
            category="hard",
            status="pass",
            message="No bids at or near the ₹12/kWh DSM ceiling.",
        ))

    # ── 5. Forecast confidence ───────────────────────────────────────────────
    low_confidence_blocks: list[int] = []
    for b in bids:
        fc = forecasts.get(b["block"])
        if fc:
            ci_width = fc["confidence_high"] - fc["confidence_low"]
            pred = max(fc["predicted_price"], 0.01)
            if ci_width / pred > CI_WIDTH_RATIO_WARN:
                low_confidence_blocks.append(b["block"])

    ci_ratio = len(low_confidence_blocks) / max(len(bids), 1)
    if ci_ratio > CI_POOR_BLOCK_RATIO:
        checks.append(ApprovalCheck(
            name="forecast_confidence",
            category="soft",
            status="warn",
            message=(
                f"{len(low_confidence_blocks)} blocks ({ci_ratio * 100:.0f}%) have wide "
                "confidence intervals (>2.5× predicted price). Forecast uncertainty is high."
            ),
            affected_blocks=low_confidence_blocks[:20],
        ))
    else:
        checks.append(ApprovalCheck(
            name="forecast_confidence",
            category="soft",
            status="pass",
            message=f"Forecast confidence acceptable ({len(low_confidence_blocks)} wide-CI blocks).",
        ))

    # ── 6. Override ratio ────────────────────────────────────────────────────
    overridden = [b for b in bids if b.get("is_overridden")]
    override_ratio = len(overridden) / max(len(bids), 1)
    if override_ratio > MAX_OVERRIDE_RATIO:
        checks.append(ApprovalCheck(
            name="override_ratio",
            category="soft",
            status="warn",
            message=(
                f"{len(overridden)} blocks ({override_ratio * 100:.0f}%) manually overridden. "
                "High override rate reduces AI optimization value."
            ),
            affected_blocks=[b["block"] for b in overridden[:20]],
        ))
    else:
        checks.append(ApprovalCheck(
            name="override_ratio",
            category="soft",
            status="pass",
            message=f"{len(overridden)} overrides ({override_ratio * 100:.0f}%) — within acceptable range.",
        ))

    # ── 7. Strategy alignment ────────────────────────────────────────────────
    if forecasts:
        bid_prices = [b["price"] for b in bids if b["block"] in forecasts]
        pred_prices = [forecasts[b["block"]]["predicted_price"] for b in bids if b["block"] in forecasts]
        if bid_prices and pred_prices:
            avg_bid = sum(bid_prices) / len(bid_prices)
            avg_pred = sum(pred_prices) / len(pred_prices)
            deviation = (avg_bid - avg_pred) / max(avg_pred, 0.01)

            alignment_fail = False
            if strategy == "conservative" and deviation > CONSERVATIVE_ABOVE_PRED_MAX:
                alignment_fail = True
                msg = (
                    f"Conservative strategy but avg bid is {deviation * 100:+.1f}% above forecast. "
                    "Bids appear more aggressive than declared strategy."
                )
            elif strategy == "aggressive" and deviation < AGGRESSIVE_BELOW_PRED_MIN:
                alignment_fail = True
                msg = (
                    f"Aggressive strategy but avg bid is {deviation * 100:+.1f}% below forecast. "
                    "Bids appear more conservative than declared strategy."
                )
            else:
                msg = (
                    f"Strategy alignment OK — avg bid {deviation * 100:+.1f}% vs forecast "
                    f"(strategy: {strategy})."
                )

            checks.append(ApprovalCheck(
                name="strategy_alignment",
                category="soft",
                status="fail" if alignment_fail else "pass",
                message=msg,
            ))

    # ── Score computation ────────────────────────────────────────────────────
    HARD_PTS = {"pass": 25, "warn": 12, "fail": 0}
    SOFT_PTS = {"pass": 10, "warn": 5, "fail": 2}

    hard_checks = [c for c in checks if c.category == "hard"]
    soft_checks = [c for c in checks if c.category == "soft"]
    max_total = len(hard_checks) * 25 + len(soft_checks) * 10 or 1
    raw = (
        sum(HARD_PTS[c.status] for c in hard_checks)
        + sum(SOFT_PTS[c.status] for c in soft_checks)
    )
    score = round(raw / max_total * 100, 1)

    # ── Verdict ──────────────────────────────────────────────────────────────
    hard_fails = [c for c in hard_checks if c.status == "fail"]
    soft_issues = [c for c in soft_checks if c.status in ("warn", "fail")]

    if len(hard_fails) >= 2:
        verdict = "REJECTED"
    elif len(hard_fails) == 1:
        verdict = "NEEDS_REVISION"
    elif soft_issues:
        verdict = "APPROVED_WITH_FLAGS"
    else:
        verdict = "APPROVED"

    can_submit = verdict in ("APPROVED", "APPROVED_WITH_FLAGS")

    # ── Summary ──────────────────────────────────────────────────────────────
    fail_names = [c.name.replace("_", " ") for c in checks if c.status == "fail"]
    warn_names = [c.name.replace("_", " ") for c in checks if c.status == "warn"]

    if verdict == "APPROVED":
        summary = f"All {len(checks)} checks passed. Bid set cleared for submission."
    elif verdict == "APPROVED_WITH_FLAGS":
        summary = (
            f"Approved with {len(soft_issues)} advisory flag(s): {', '.join(warn_names)}. "
            "Submission is permitted — review flagged items before market close."
        )
    elif verdict == "NEEDS_REVISION":
        summary = f"1 critical issue blocks submission: {fail_names[0]}. Revise and re-run."
    else:
        summary = (
            f"{len(hard_fails)} critical issues must be resolved: {', '.join(fail_names)}."
        )

    return {
        "verdict": verdict,
        "score": score,
        "checks": [
            {
                "name": c.name,
                "category": c.category,
                "status": c.status,
                "message": c.message,
                "affected_blocks": c.affected_blocks,
            }
            for c in checks
        ],
        "summary": summary,
        "can_submit": can_submit,
    }
