from typing import Optional
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query, Body
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from common.database import get_db
from common.models import Bid, Forecast, PriceHistory
from common.schemas import (
    BidItem,
    BidRecommendation,
    ConstraintViolation,
)
from common.config import (
    BLOCK_DURATION_MIN,
    DSM_DEVIATION_BAND,
    DSM_PENALTY_RATE,
    NUM_BLOCKS,
    STRATEGY_PROFILES,
)
from .optimizer import generate_recommendations, validate_constraints

router = APIRouter(prefix="/bids", tags=["Bid Engine"])


@router.get("/recommend", response_model=list[BidRecommendation])
async def recommend_bids(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    strategy: str = Query("balanced", pattern=r"^(conservative|balanced|aggressive)$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    demand_mw: float = Query(500.0, ge=0),
    price_offset: Optional[float] = Query(
        default=None, ge=-5.0, le=5.0, description="Override strategy price offset"
    ),
    risk_tolerance: Optional[float] = Query(
        default=None,
        ge=0.0,
        le=1.0,
        description="Override strategy risk tolerance (0=conservative, 1=aggressive)",
    ),
    volume_scale: Optional[float] = Query(
        default=None, ge=0.1, le=3.0, description="Override strategy volume scale"
    ),
    per_block_cap_factor: float = Query(
        default=4.0,
        ge=1.0,
        le=20.0,
        description="Max volume per block as multiple of avg load",
    ),
    lambda1_base: Optional[float] = Query(
        default=None,
        ge=0.1,
        le=50.0,
        description="Override DSM penalty weight base (λ₁). Default from solver_config.",
    ),
    lambda2_base: Optional[float] = Query(
        default=None,
        ge=0.1,
        le=50.0,
        description="Override forecast uncertainty weight base (λ₂). Default from solver_config.",
    ),
    db: AsyncSession = Depends(get_db),
):
    """Generate AI-optimized bid recommendations for all 96 blocks."""
    result = await db.execute(
        select(Forecast)
        .where(Forecast.target_date == target_date, Forecast.segment == segment)
        .order_by(Forecast.created_at.desc())
        .limit(96)
    )
    forecasts = result.scalars().all()
    if not forecasts:
        raise HTTPException(
            400,
            f"No forecasts for {target_date} / {segment}. Run /forecast/predict first.",
        )

    forecast_dicts = [
        {
            "block": f.block,
            "predicted_price": f.predicted_price,
            "confidence_low": f.confidence_low,
            "confidence_high": f.confidence_high,
            "volatility": f.volatility,
        }
        for f in forecasts
    ]

    recs = generate_recommendations(
        forecast_dicts,
        strategy,
        demand_mw,
        segment,
        price_offset_override=price_offset,
        risk_tolerance_override=risk_tolerance,
        volume_scale_override=volume_scale,
        per_block_cap_factor=per_block_cap_factor,
        lambda1_base_override=lambda1_base,
        lambda2_base_override=lambda2_base,
    )
    return [BidRecommendation(**r) for r in recs]


@router.post("/submit")
async def submit_bids(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    strategy: str = Query("balanced", pattern=r"^(conservative|balanced|aggressive)$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    bids: list[BidItem] = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """Submit a set of bids (AI-recommended or trader-edited) for a date/segment."""
    session_id = str(uuid.uuid4())
    all_violations = []

    for item in bids:
        violations = validate_constraints(
            item.block, item.price, item.volume_mw, item.segment
        )
        violation_dicts = [v.model_dump() for v in violations]
        if violations:
            all_violations.extend(violations)

        db.add(
            Bid(
                session_id=session_id,
                target_date=target_date,
                block=item.block,
                segment=item.segment,
                strategy=strategy,
                price=item.price,
                volume_mw=item.volume_mw,
                is_ai_recommended=not item.is_overridden,
                is_overridden=item.is_overridden,
                override_reason=item.override_reason,
                constraint_violations=violation_dicts if violation_dicts else None,
                status="submitted",
            )
        )

    await db.commit()

    return {
        "session_id": session_id,
        "target_date": target_date,
        "segment": segment,
        "bid_count": len(bids),
        "violations": [v.model_dump() for v in all_violations],
        "status": "submitted" if not all_violations else "submitted_with_warnings",
    }


@router.post("/validate")
async def validate_bids(
    bids: list[BidItem] = Body(...),
):
    """Validate bids against constraints without submitting."""
    all_violations = []
    for item in bids:
        violations = validate_constraints(
            item.block, item.price, item.volume_mw, item.segment
        )
        all_violations.extend(violations)

    return {
        "valid": len(all_violations) == 0,
        "violation_count": len(all_violations),
        "violations": [v.model_dump() for v in all_violations],
    }


@router.get("/compare-strategies")
async def compare_strategies(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    demand_mw: float = Query(500.0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """
    Run all 3 strategies against the same forecast and (optionally) simulate
    clearing against actual prices.  Returns side-by-side KPIs.
    """
    # Load forecasts
    result = await db.execute(
        select(Forecast)
        .where(Forecast.target_date == target_date, Forecast.segment == segment)
        .order_by(Forecast.created_at.desc())
        .limit(96)
    )
    forecasts = result.scalars().all()
    if not forecasts:
        raise HTTPException(
            400,
            f"No forecasts for {target_date} / {segment}. Run /forecast/predict first.",
        )

    forecast_dicts = [
        {
            "block": f.block,
            "predicted_price": f.predicted_price,
            "confidence_low": f.confidence_low,
            "confidence_high": f.confidence_high,
            "volatility": f.volatility,
        }
        for f in forecasts
    ]

    # Load actual prices (may not exist yet)
    result = await db.execute(
        select(PriceHistory)
        .where(PriceHistory.date == target_date, PriceHistory.segment == segment)
        .order_by(PriceHistory.block)
    )
    actuals = {r.block: r.mcp for r in result.scalars().all()}
    has_actuals = len(actuals) > 0

    duration_hours = BLOCK_DURATION_MIN / 60.0
    load_per_block = demand_mw / NUM_BLOCKS
    strategies_out = []

    for strategy in ("conservative", "balanced", "aggressive"):
        recs = generate_recommendations(
            forecast_dicts,
            strategy,
            demand_mw,
            segment,
        )

        total_cost = 0.0
        total_volume = 0.0
        baseline_cost = 0.0
        hit_count = 0
        total_dsm_penalty = 0.0
        total_bid_value = 0.0
        violation_count = 0
        block_details = []

        for r in recs:
            b = r["block"]
            bid_price = r["price"]
            vol = r["volume_mw"]
            total_bid_value += bid_price * vol * duration_hours

            violation_count += len(r["constraint_violations"])

            # DSM penalty estimate
            deviation = abs(vol - load_per_block) / max(load_per_block, 0.01)
            excess_dev = max(0.0, deviation - DSM_DEVIATION_BAND)
            total_dsm_penalty += (
                excess_dev
                * load_per_block
                * bid_price
                * DSM_PENALTY_RATE
                * duration_hours
                * 1000
            )

            actual = actuals.get(b)
            cleared = actual is not None and bid_price >= actual
            if actual is not None:
                if cleared:
                    total_cost += actual * vol * duration_hours
                    total_volume += vol * duration_hours
                    hit_count += 1
                baseline_cost += actual * vol * duration_hours

            block_details.append(
                {
                    "block": b,
                    "bid_price": round(bid_price, 4),
                    "volume_mw": vol,
                    "cleared": cleared,
                    "actual_price": round(actual, 4) if actual is not None else None,
                }
            )

        bid_count = len(recs)
        basket_rate = (total_cost / total_volume) if total_volume > 0 else 0.0
        baseline_basket = (
            (baseline_cost / max(total_volume, 0.01)) if has_actuals else 0.0
        )
        basket_change = (
            ((basket_rate - baseline_basket) / max(baseline_basket, 0.01)) * 100
            if has_actuals and baseline_basket > 0
            else 0.0
        )
        avg_price = sum(r["price"] for r in recs) / max(len(recs), 1)
        total_vol = sum(r["volume_mw"] for r in recs)

        profile = STRATEGY_PROFILES[strategy]

        strategies_out.append(
            {
                "strategy": strategy,
                "risk_tolerance": profile["risk_tolerance"],
                "price_offset": profile["price_offset"],
                "volume_scale": profile["volume_scale"],
                "avg_bid_price": round(avg_price, 4),
                "total_volume_mw": round(total_vol, 1),
                "total_bid_value": round(total_bid_value, 2),
                "estimated_dsm_penalty": round(total_dsm_penalty, 2),
                "violation_count": violation_count,
                "hit_rate": round(
                    (hit_count / bid_count * 100) if bid_count > 0 else 0.0, 2
                ),
                "basket_rate": round(basket_rate, 4),
                "baseline_basket_rate": round(baseline_basket, 4),
                "basket_rate_change_pct": round(basket_change, 2),
                "cost_savings": (
                    round(baseline_cost - total_cost, 2) if has_actuals else None
                ),
                "blocks": block_details,
            }
        )

    return {
        "target_date": target_date,
        "segment": segment,
        "demand_mw": demand_mw,
        "has_actuals": has_actuals,
        "strategies": strategies_out,
    }


@router.get("/tune")
async def auto_tune_lambdas(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    strategy: str = Query("balanced", pattern=r"^(conservative|balanced|aggressive)$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    demand_mw: float = Query(500.0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """
    Grid-search λ₁ × λ₂ combinations and return the pair that maximises
    cleared bid value while minimising estimated DSM penalties.

    Score = total_bid_value - 2 × total_dsm_penalty_estimate
    """
    result = await db.execute(
        select(Forecast)
        .where(Forecast.target_date == target_date, Forecast.segment == segment)
        .order_by(Forecast.created_at.desc())
        .limit(96)
    )
    forecasts = result.scalars().all()
    if not forecasts:
        raise HTTPException(
            400,
            f"No forecasts for {target_date} / {segment}. Run /forecast/predict first.",
        )

    forecast_dicts = [
        {
            "block": f.block,
            "predicted_price": f.predicted_price,
            "confidence_low": f.confidence_low,
            "confidence_high": f.confidence_high,
            "volatility": f.volatility,
        }
        for f in forecasts
    ]

    duration_hours = BLOCK_DURATION_MIN / 60.0

    lambda1_grid = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0]
    lambda2_grid = [0.5, 0.75, 1.0, 1.25, 1.5]

    best_score = float("-inf")
    best_l1 = 2.0
    best_l2 = 1.5
    grid_results = []

    for l1 in lambda1_grid:
        for l2 in lambda2_grid:
            recs = generate_recommendations(
                forecast_dicts,
                strategy,
                demand_mw,
                segment,
                lambda1_base_override=l1,
                lambda2_base_override=l2,
            )
            total_bid_value = sum(
                r["price"] * r["volume_mw"] * duration_hours for r in recs
            )
            total_dsm = sum(r.get("dsm_penalty_estimate", 0.0) for r in recs)
            score = total_bid_value - 2.0 * total_dsm

            grid_results.append(
                {
                    "lambda1_base": l1,
                    "lambda2_base": l2,
                    "total_bid_value": round(total_bid_value, 2),
                    "total_dsm_penalty": round(total_dsm, 2),
                    "score": round(score, 2),
                }
            )

            if score > best_score:
                best_score = score
                best_l1 = l1
                best_l2 = l2

    return {
        "best_lambda1_base": best_l1,
        "best_lambda2_base": best_l2,
        "best_score": round(best_score, 2),
        "grid": sorted(grid_results, key=lambda x: x["score"], reverse=True),
    }
