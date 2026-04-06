import uuid
from fastapi import APIRouter, Depends, HTTPException, Query, Body
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.common.database import get_db
from backend.common.models import Bid, Forecast
from backend.common.schemas import (
    BidItem,
    BidRecommendation,
    ConstraintViolation,
)
from .optimizer import generate_recommendations, validate_constraints

router = APIRouter(prefix="/bids", tags=["Bid Engine"])


@router.get("/recommend", response_model=list[BidRecommendation])
async def recommend_bids(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    strategy: str = Query("balanced", pattern=r"^(conservative|balanced|aggressive)$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    demand_mw: float = Query(500.0, ge=0),
    price_offset: float | None = Query(default=None, ge=-5.0, le=5.0, description="Override strategy price offset"),
    risk_tolerance: float | None = Query(default=None, ge=0.0, le=1.0, description="Override strategy risk tolerance (0=conservative, 1=aggressive)"),
    volume_scale: float | None = Query(default=None, ge=0.1, le=3.0, description="Override strategy volume scale"),
    per_block_cap_factor: float = Query(default=4.0, ge=1.0, le=20.0, description="Max volume per block as multiple of avg load"),
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
        forecast_dicts, strategy, demand_mw, segment,
        price_offset_override=price_offset,
        risk_tolerance_override=risk_tolerance,
        volume_scale_override=volume_scale,
        per_block_cap_factor=per_block_cap_factor,
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
