"""
Policy Service — REST endpoints for DSM regulation management.

Endpoints:
  GET  /policy/list              — list all available policies
  GET  /policy/active            — get the currently active policy
  POST /policy/activate/{id}     — switch the active regulation
  GET  /policy/compare           — side-by-side diff of two policies
"""

import logging
from fastapi import APIRouter, HTTPException

from common.dsm_policy import (
    list_policies,
    get_active_policy,
    set_active_policy,
    load_policy,
    update_policy,
    DSMPolicy,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/policy", tags=["Policy"])


@router.get("/list")
async def get_all_policies() -> list[dict]:
    """Return all available DSM policies with an 'is_active' flag."""
    try:
        active = get_active_policy()
        policies = list_policies()
        return [
            {**p.model_dump(), "is_active": p.regulation_id == active.regulation_id}
            for p in policies
        ]
    except Exception as exc:
        logger.exception("Failed to list policies")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/active")
async def get_active() -> dict:
    """Return the currently active DSM policy."""
    try:
        policy = get_active_policy()
        return {**policy.model_dump(), "is_active": True}
    except Exception as exc:
        logger.exception("Failed to get active policy")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/activate/{regulation_id}")
async def activate_policy(regulation_id: str) -> dict:
    """
    Switch the active DSM regulation.

    Immediately affects all subsequent LP optimisations and constraint checks.
    The change is persisted to disk (active_policy.txt) so it survives restarts.
    """
    try:
        policy = set_active_policy(regulation_id)
        logger.info("Policy activated via API: %s", regulation_id)
        return {
            "message": f"Active policy switched to '{policy.name}'",
            "policy": policy.model_dump(),
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.exception("Failed to activate policy %s", regulation_id)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/compare")
async def compare_policies(policy_a: str, policy_b: str) -> dict:
    """
    Return a field-level diff between two policies.

    Useful for the UI to show "what changes if I switch from 2019 to 2024 draft".
    """
    numeric_fields = [
        "price_floor",
        "price_ceiling",
        "deviation_band",
        "penalty_rate",
        "severe_deviation_threshold",
        "severe_penalty_multiplier",
        "technical_minimum_mw",
        "lambda1_base",
        "lambda2_base",
    ]
    try:
        pa: DSMPolicy = load_policy(policy_a)
        pb: DSMPolicy = load_policy(policy_b)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    diffs = []
    for field in numeric_fields:
        va = getattr(pa, field)
        vb = getattr(pb, field)
        if va != vb:
            pct_change = ((vb - va) / va * 100) if va != 0 else None
            diffs.append(
                {
                    "field": field,
                    "policy_a_value": va,
                    "policy_b_value": vb,
                    "pct_change": (
                        round(pct_change, 1) if pct_change is not None else None
                    ),
                    "direction": (
                        "tighter"
                        if vb < va
                        else (
                            "looser"
                            if field in ("deviation_band",)
                            else "higher" if vb > va else "lower"
                        )
                    ),
                }
            )

    return {
        "policy_a": pa.model_dump(),
        "policy_b": pb.model_dump(),
        "diffs": diffs,
        "summary": f"{len(diffs)} parameter(s) differ between '{pa.name}' and '{pb.name}'",
    }


@router.put("/{regulation_id}")
async def update_policy_endpoint(regulation_id: str, body: dict) -> dict:
    """
    Edit an existing policy's parameters in-place.

    The regulation_id (used as the file name) cannot be changed here.
    All numeric fields and text metadata (name, description, status,
    effective_date) can be updated.  The result is immediately reflected
    in all subsequent LP solves if this regulation is the active one.
    """
    try:
        policy = update_policy(regulation_id, body)
        active = get_active_policy()
        return {
            "message": f"Policy '{regulation_id}' updated successfully",
            "policy": {
                **policy.model_dump(),
                "is_active": policy.regulation_id == active.regulation_id,
            },
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except (ValueError, Exception) as exc:
        logger.exception("Failed to update policy %s", regulation_id)
        raise HTTPException(status_code=422, detail=str(exc))
