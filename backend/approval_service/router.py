"""Agentic Approval Router.

POST /bids/request-approval
  – fetches stored forecasts + latest risk snapshot for the date/segment
  – runs the rule-based AI approval agent
  – writes an immutable audit entry
  – returns the full verdict for the workspace UI
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from common.database import get_db
from common.models import AuditLog, Forecast, RiskSnapshot
from .agent import run_approval_agent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bids", tags=["Approval"])


# ── Pydantic schema for incoming bids ───────────────────────────────────────

class ApprovalBidItem(BaseModel):
    """Bid item as sent from the workspace frontend (after validation)."""

    block: int = Field(..., ge=1, le=96)
    segment: str = Field(..., pattern=r"^(DAM|RTM|TAM)$")
    price: float = Field(..., ge=0)
    volume_mw: float = Field(..., ge=0)
    is_overridden: bool = False
    override_reason: Optional[str] = None
    constraint_violations: Optional[list] = None  # list[ConstraintViolation dict]


# ── Endpoint ─────────────────────────────────────────────────────────────────

@router.post("/request-approval")
async def request_approval(
    session_id: str = Query(...),
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    strategy: str = Query(
        default="balanced", pattern=r"^(conservative|balanced|aggressive)$"
    ),
    bids: list[ApprovalBidItem] = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """Run the AI approval agent on a bid set and return a scored verdict."""

    # 1. Fetch latest forecasts for target_date + segment (one row per block)
    fc_rows = (
        await db.execute(
            select(Forecast)
            .where(
                Forecast.target_date == target_date,
                Forecast.segment == segment,
            )
            .order_by(Forecast.id.desc())
        )
    ).scalars().all()

    # De-duplicate: keep most recent forecast per block
    forecasts: dict[int, dict] = {}
    for row in fc_rows:
        if row.block not in forecasts:
            forecasts[row.block] = {
                "predicted_price": row.predicted_price,
                "confidence_low": row.confidence_low or 0.0,
                "confidence_high": row.confidence_high or 0.0,
            }

    # 2. Fetch latest risk snapshot for this segment (any session)
    risk_row = (
        await db.execute(
            select(RiskSnapshot)
            .where(RiskSnapshot.segment == segment)
            .order_by(RiskSnapshot.id.desc())
            .limit(1)
        )
    ).scalars().first()

    risk_result: dict | None = None
    if risk_row:
        risk_result = {
            "var_95": risk_row.var_95 or 0.0,
            "expected_dsm_penalty": risk_row.expected_dsm_penalty or 0.0,
            "worst_case_penalty": risk_row.worst_case_penalty or 0.0,
            "total_exposure": risk_row.total_exposure or 0.0,
            "alert_triggered": bool(risk_row.alert_triggered),
        }

    # 3. Run the agent
    bids_dicts = [b.model_dump() for b in bids]
    agent_result = run_approval_agent(
        bids=bids_dicts,
        forecasts=forecasts,
        risk_result=risk_result,
        strategy=strategy,
        segment=segment,
    )

    # 4. Write audit log
    db.add(
        AuditLog(
            session_id=session_id,
            user="agent",
            action="agent_approval",
            entity_type="bid",
            details={
                "target_date": target_date,
                "segment": segment,
                "strategy": strategy,
                "verdict": agent_result["verdict"],
                "score": agent_result["score"],
                "can_submit": agent_result["can_submit"],
                "bid_count": len(bids),
            },
        )
    )
    await db.commit()

    return {
        "session_id": session_id,
        "target_date": target_date,
        "segment": segment,
        "strategy": strategy,
        **agent_result,
    }
