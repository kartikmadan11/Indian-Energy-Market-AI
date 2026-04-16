"""Beckn Protocol / UEI router.

Implements the BAP (Beckn Application Platform) side of the 4-step Beckn flow:
  POST /beckn/search   → discover market offerings from all mock BPPs
  POST /beckn/select   → select a specific exchange (BPP)
  POST /beckn/init     → draft a bid order
  POST /beckn/confirm  → confirm / submit the bid
  GET  /beckn/orders   → list all orders
  GET  /beckn/orders/{order_id} → get a specific order
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from common.database import get_db
from .mock_bpp import EXCHANGE_CONFIGS, get_exchange_quote
from .schemas import (
    BecknContext,
    BecknOrder,
    ConfirmRequest,
    ConfirmResponse,
    ExchangeQuote,
    InitRequest,
    InitResponse,
    SearchRequest,
    SearchResponse,
    SelectRequest,
    SelectResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/beckn", tags=["Beckn Protocol / UEI"])

_orders: dict[str, BecknOrder] = {}
# transaction_id → { exchange_id: ExchangeQuote }
_quote_cache: dict[str, dict[str, ExchangeQuote]] = {}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _ctx(action: str, txn_id: str, bpp_id: Optional[str] = None) -> BecknContext:
    bpp_uri = (
        EXCHANGE_CONFIGS.get(bpp_id.upper(), {}).get("bpp_uri") if bpp_id else None
    )
    return BecknContext(
        action=action,
        transaction_id=txn_id,
        bpp_id=bpp_id,
        bpp_uri=bpp_uri,
    )


async def _ensure_quote(
    db: AsyncSession,
    txn_id: str,
    exchange_id: str,
    segment: str,
    target_date: str,
    block_start: int,
    block_end: int,
    demand_mw: float,
) -> ExchangeQuote:
    cached = _quote_cache.get(txn_id, {}).get(exchange_id)
    if cached:
        return cached
    quote = await get_exchange_quote(
        db, exchange_id, segment, target_date, block_start, block_end, demand_mw, txn_id
    )
    if not quote:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No forecast data found for {exchange_id} / {segment} / {target_date}. "
                "Train a forecast model first via /api/forecast/train."
            ),
        )
    _quote_cache.setdefault(txn_id, {})[exchange_id] = quote
    return quote


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/search", response_model=SearchResponse, summary="Beckn search — discover market offerings")
async def beckn_search(
    req: SearchRequest,
    db: AsyncSession = Depends(get_db),
) -> SearchResponse:
    """Broadcast a Beckn search to all mock BPPs (IEX, PXIL, HPX).

    Returns a catalog of available market offerings with prices from each exchange.
    """
    txn_id = str(uuid.uuid4())
    providers: list[ExchangeQuote] = []

    for exchange_id in EXCHANGE_CONFIGS:
        quote = await get_exchange_quote(
            db, exchange_id, req.segment, req.target_date,
            req.block_start, req.block_end, req.demand_mw, txn_id,
        )
        if quote:
            providers.append(quote)

    if not providers:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No forecasts found for {req.segment} / {req.target_date}. "
                "Train a model first via POST /api/forecast/train."
            ),
        )

    # Cache for downstream select/init/confirm
    _quote_cache[txn_id] = {p.exchange_id: p for p in providers}

    return SearchResponse(
        context=_ctx("on_search", txn_id),
        transaction_id=txn_id,
        providers=providers,
        search_params={
            "segment": req.segment,
            "target_date": req.target_date,
            "block_start": req.block_start,
            "block_end": req.block_end,
            "demand_mw": req.demand_mw,
        },
    )


@router.post("/select", response_model=SelectResponse, summary="Beckn select — choose an exchange")
async def beckn_select(
    req: SelectRequest,
    db: AsyncSession = Depends(get_db),
) -> SelectResponse:
    """Select a specific exchange from search results.

    Returns a detailed quote with Beckn-formatted price breakup.
    """
    quote = await _ensure_quote(
        db, req.transaction_id, req.exchange_id,
        req.segment, req.target_date, req.block_start, req.block_end, req.demand_mw,
    )

    beckn_quote: dict[str, Any] = {
        "price": {
            "currency": "INR",
            "value": str(round(quote.total_value_inr, 2)),
        },
        "breakup": [
            {
                "title": f"Block {item['block']} ({item['time']})",
                "price": {
                    "currency": "INR",
                    "value": str(round(item["price_inr_kwh"] * item["volume_mw"] * 250, 2)),
                },
            }
            for item in quote.items[:8]
        ],
        "ttl": "PT10M",
    }

    return SelectResponse(
        context=_ctx("on_select", req.transaction_id, req.exchange_id),
        transaction_id=req.transaction_id,
        quote=quote,
        beckn_quote=beckn_quote,
    )


@router.post("/init", response_model=InitResponse, summary="Beckn init — draft a bid order")
async def beckn_init(
    req: InitRequest,
    db: AsyncSession = Depends(get_db),
) -> InitResponse:
    """Initialize a bid order (draft state) for the selected exchange."""
    quote = await _ensure_quote(
        db, req.transaction_id, req.exchange_id,
        req.segment, req.target_date, req.block_start, req.block_end, req.demand_mw,
    )

    order_id = "BECK-" + str(uuid.uuid4())[:8].upper()

    gate_closure = {
        "DAM": "10:00 IST (D-1)",
        "RTM": "55 min before delivery",
        "TAM": "As per contract terms",
    }.get(req.segment, "TBD")

    fulfillment: dict[str, Any] = {
        "type": "ENERGY_PROCUREMENT",
        "delivery_date": req.target_date,
        "segment": req.segment,
        "block_range": f"{quote.block_start}–{quote.block_end}",
        "blocks_count": len(quote.items),
        "gate_closure": gate_closure,
        "clearing_mechanism": "MCP-based auction" if req.segment in ("DAM", "RTM") else "Bilateral contract",
        "settlement": "T+2 working days",
        "billing_entity": req.billing_entity,
    }

    order = BecknOrder(
        order_id=order_id,
        transaction_id=req.transaction_id,
        status="draft",
        exchange_id=req.exchange_id,
        segment=req.segment,
        target_date=req.target_date,
        block_start=quote.block_start,
        block_end=quote.block_end,
        demand_mw=req.demand_mw,
        items=quote.items,
        total_volume_mw=quote.total_volume_mw,
        total_value_inr=quote.total_value_inr,
        avg_price=quote.avg_price,
        created_at=datetime.utcnow().isoformat() + "Z",
        billing_entity=req.billing_entity,
    )
    _orders[order_id] = order

    return InitResponse(
        context=_ctx("on_init", req.transaction_id, req.exchange_id),
        transaction_id=req.transaction_id,
        order_id=order_id,
        status="draft",
        exchange_id=req.exchange_id,
        segment=req.segment,
        target_date=req.target_date,
        items=quote.items,
        total_volume_mw=quote.total_volume_mw,
        total_value_inr=quote.total_value_inr,
        fulfillment=fulfillment,
    )


@router.post("/confirm", response_model=ConfirmResponse, summary="Beckn confirm — submit the bid")
async def beckn_confirm(req: ConfirmRequest) -> ConfirmResponse:
    """Confirm (submit) a draft bid order. Transitions status to 'confirmed'."""
    order = _orders.get(req.order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found. Call /init first.")
    if order.status == "confirmed":
        raise HTTPException(status_code=409, detail="Order already confirmed.")

    order.status = "confirmed"
    order.confirmed_at = datetime.utcnow().isoformat() + "Z"

    txn_id = req.transaction_id or order.transaction_id

    return ConfirmResponse(
        context=_ctx("on_confirm", txn_id, order.exchange_id),
        transaction_id=txn_id,
        order_id=order.order_id,
        status="confirmed",
        message=(
            f"Order {order.order_id} confirmed on {order.exchange_id}. "
            f"{order.segment} · {order.target_date} · "
            f"{len(order.items)} blocks · {order.total_volume_mw:.0f} MWh · "
            f"₹{order.total_value_inr:,.2f}"
        ),
        exchange_id=order.exchange_id,
        segment=order.segment,
        target_date=order.target_date,
    )


@router.get("/orders", summary="List all Beckn orders")
async def list_orders() -> dict[str, Any]:
    """Return all orders (draft + confirmed), newest first."""
    orders = sorted(_orders.values(), key=lambda o: o.created_at, reverse=True)
    return {"orders": [o.model_dump() for o in orders], "total": len(orders)}


@router.get("/orders/{order_id}", summary="Get a Beckn order by ID")
async def get_order(order_id: str) -> dict[str, Any]:
    """Return a single Beckn order."""
    order = _orders.get(order_id)
    if not order:
        raise HTTPException(status_code=404, detail="Order not found.")
    return order.model_dump()


@router.get("/exchanges", summary="List available BPP exchanges")
async def list_exchanges() -> dict[str, Any]:
    """Return metadata about the three mock exchanges."""
    return {
        "exchanges": [
            {
                "id": eid,
                "name": cfg["name"],
                "price_premium_pct": cfg["price_offset_pct"] * 100,
                "bpp_uri": cfg["bpp_uri"],
                "description": cfg["description"],
            }
            for eid, cfg in EXCHANGE_CONFIGS.items()
        ]
    }
