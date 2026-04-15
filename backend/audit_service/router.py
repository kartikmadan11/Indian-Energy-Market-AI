import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from common.database import get_db
from common.models import AuditLog, Bid, Forecast, PriceHistory
from common.schemas import (
    AuditEntry,
    PostMarketSummary,
    PostMarketBlock,
)
from common.config import BLOCK_DURATION_MIN
from common.dsm_policy import get_active_policy

router = APIRouter(prefix="/audit", tags=["Audit"])


@router.post("/log")
async def create_audit_entry(entry: AuditEntry, db: AsyncSession = Depends(get_db)):
    """Create an immutable audit log entry."""
    db.add(
        AuditLog(
            session_id=entry.session_id,
            user=entry.user,
            action=entry.action,
            entity_type=entry.entity_type,
            entity_id=entry.entity_id,
            details=entry.details,
        )
    )
    await db.commit()
    return {"status": "logged"}


@router.get("/log")
async def get_audit_log(
    session_id: str = Query(None),
    action: str = Query(None),
    limit: int = Query(100, le=500),
    db: AsyncSession = Depends(get_db),
):
    """Query audit log entries."""
    q = select(AuditLog).order_by(AuditLog.timestamp.desc()).limit(limit)
    if session_id:
        q = q.where(AuditLog.session_id == session_id)
    if action:
        q = q.where(AuditLog.action == action)

    result = await db.execute(q)
    logs = result.scalars().all()
    return [
        {
            "id": l.id,
            "timestamp": str(l.timestamp),
            "session_id": l.session_id,
            "user": l.user,
            "action": l.action,
            "entity_type": l.entity_type,
            "entity_id": l.entity_id,
            "details": l.details,
        }
        for l in logs
    ]


@router.get("/post-market", response_model=PostMarketSummary)
async def post_market_analysis(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    session_id: str = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """
    Compare predicted vs actual prices, compute bid hit rate, basket rate, DSM penalties.
    This closes the feedback loop.
    """
    # Get actual prices
    result = await db.execute(
        select(PriceHistory)
        .where(PriceHistory.date == target_date, PriceHistory.segment == segment)
        .order_by(PriceHistory.block)
    )
    actuals = {r.block: r for r in result.scalars().all()}
    if not actuals:
        raise HTTPException(400, f"No actual price data for {target_date} / {segment}")

    # Get forecasts
    result = await db.execute(
        select(Forecast)
        .where(Forecast.target_date == target_date, Forecast.segment == segment)
        .order_by(Forecast.created_at.desc())
        .limit(96)
    )
    preds = {f.block: f for f in result.scalars().all()}

    # Get bids if session_id provided
    bids_map = {}
    if session_id:
        result = await db.execute(
            select(Bid).where(Bid.session_id == session_id).order_by(Bid.block)
        )
        bids_map = {b.block: b for b in result.scalars().all()}

    blocks = []
    errors = []
    hit_count = 0
    total_cost = 0.0
    total_volume = 0.0
    baseline_cost = 0.0

    for block_num in range(1, 97):
        actual = actuals.get(block_num)
        pred = preds.get(block_num)
        bid = bids_map.get(block_num)

        if not actual or not pred:
            continue

        actual_price = actual.mcp
        predicted_price = pred.predicted_price
        error = abs(predicted_price - actual_price)
        error_pct = (error / max(actual_price, 0.01)) * 100

        bid_price = bid.price if bid else None
        bid_volume = bid.volume_mw if bid else None
        cleared = bid_price is not None and bid_price >= actual_price

        if bid_price is not None:
            hit_count += int(cleared)
            if cleared:
                duration_hours = BLOCK_DURATION_MIN / 60.0
                total_cost += actual_price * bid_volume * duration_hours
                total_volume += bid_volume * duration_hours
            baseline_cost += (
                actual_price * (bid_volume or 0) * (BLOCK_DURATION_MIN / 60.0)
            )

        errors.append(error_pct)
        blocks.append(
            PostMarketBlock(
                block=block_num,
                predicted_price=round(predicted_price, 4),
                actual_price=round(actual_price, 4),
                bid_price=round(bid_price, 4) if bid_price else None,
                bid_volume=round(bid_volume, 1) if bid_volume else None,
                cleared=cleared,
                error=round(error, 4),
                error_pct=round(error_pct, 2),
            )
        )

    mape = float(np.mean(errors)) if errors else 0.0
    bid_count = sum(1 for b in blocks if b.bid_price is not None)
    bid_hit_rate = (hit_count / bid_count * 100) if bid_count > 0 else 0.0
    basket_rate = (total_cost / total_volume) if total_volume > 0 else 0.0
    baseline_basket = baseline_cost / max(total_volume, 0.01)
    basket_change = ((basket_rate - baseline_basket) / max(baseline_basket, 0.01)) * 100

    # Estimate DSM penalties using active policy
    policy = get_active_policy()
    duration_hours = BLOCK_DURATION_MIN / 60.0
    total_penalty = 0.0
    for b in blocks:
        if b.bid_volume and b.actual_price:
            actual = actuals.get(b.block)
            scheduled_mw = actual.demand_mw if actual and actual.demand_mw else b.bid_volume
            total_penalty += policy.penalty_cost(
                volume_mw=b.bid_volume,
                scheduled_mw=scheduled_mw,
                price=b.actual_price,
                duration_hours=duration_hours,
            )

    return PostMarketSummary(
        target_date=target_date,
        segment=segment,
        blocks=blocks,
        mape=round(mape, 2),
        bid_hit_rate=round(bid_hit_rate, 2),
        basket_rate=round(basket_rate, 4),
        baseline_basket_rate=round(baseline_basket, 4),
        basket_rate_change_pct=round(basket_change, 2),
        total_dsm_penalty=round(total_penalty, 2),
    )
