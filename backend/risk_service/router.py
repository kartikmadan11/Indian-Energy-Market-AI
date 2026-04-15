from fastapi import APIRouter, Depends, HTTPException, Query, Body, BackgroundTasks
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import time

from common.database import get_db
from common.models import Forecast, RiskSnapshot
from common.schemas import BidItem, RiskResult
from common.config import DEFAULT_VAR_THRESHOLD
from .engine import assess_risk

router = APIRouter(prefix="/risk", tags=["Risk"])


async def _persist_risk_snapshot(
    session_id: str, segment: str, risk: dict, db: AsyncSession
):
    """Background task: persist risk snapshot without blocking response."""
    db.add(
        RiskSnapshot(
            session_id=session_id,
            segment=segment,
            var_95=risk["var_95"],
            expected_dsm_penalty=risk["expected_dsm_penalty"],
            worst_case_penalty=risk["worst_case_penalty"],
            total_exposure=risk["total_exposure"],
            alert_triggered=risk["alert_triggered"],
            alert_details=risk["alert_details"],
        )
    )
    await db.commit()


@router.post("/assess", response_model=RiskResult)
async def assess_bid_risk(
    session_id: str = Query(...),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    bids: list[BidItem] = Body(...),
    var_threshold: float = Query(DEFAULT_VAR_THRESHOLD, gt=0),
    db: AsyncSession = Depends(get_db),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    """Calculate risk metrics (VaR, DSM penalties, alerts) for a bid set."""
    t0 = time.perf_counter()

    if not bids:
        raise HTTPException(400, "No bids provided.")

    # Get forecasted prices for these blocks
    result = await db.execute(
        select(Forecast)
        .where(Forecast.segment == segment)
        .order_by(Forecast.created_at.desc())
        .limit(96)
    )
    forecasts_raw = result.scalars().all()
    forecasts = {f.block: f for f in forecasts_raw}

    bid_prices = [b.price for b in bids]
    bid_volumes = [b.volume_mw for b in bids]
    predicted_prices = [forecasts[b.block].predicted_price if b.block in forecasts else b.price for b in bids]
    confidence_low = [forecasts[b.block].confidence_low if b.block in forecasts else None for b in bids]
    confidence_high = [forecasts[b.block].confidence_high if b.block in forecasts else None for b in bids]
    # Filter out None values — only pass CI lists if all blocks have forecasts
    has_ci = all(v is not None for v in confidence_low) and all(v is not None for v in confidence_high)

    risk = assess_risk(
        bid_prices,
        bid_volumes,
        predicted_prices,
        confidence_low=confidence_low if has_ci else None,
        confidence_high=confidence_high if has_ci else None,
        var_threshold=var_threshold,
    )

    elapsed_ms = (time.perf_counter() - t0) * 1000

    # Persist in background — don't block response
    background_tasks.add_task(_persist_risk_snapshot, session_id, segment, risk, db)

    response = RiskResult(segment=segment, **risk)
    json_response = JSONResponse(content=response.model_dump())
    json_response.headers["X-Risk-Latency-Ms"] = f"{elapsed_ms:.1f}"
    return json_response


@router.get("/threshold")
async def get_threshold():
    """Get current risk alert threshold."""
    return {"var_threshold": DEFAULT_VAR_THRESHOLD}
