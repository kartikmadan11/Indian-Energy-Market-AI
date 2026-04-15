"""Mock BPP (Beckn Provider Platform) implementations for IEX, PXIL, and HPX.

Real exchanges don't expose Beckn APIs yet. This layer adapts the platform's
own forecast data into Beckn catalog responses, simulating each exchange with
a deterministic price offset so cross-exchange comparison is meaningful.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from common.models import Forecast
from .schemas import ExchangeQuote

logger = logging.getLogger(__name__)

# Exchange registry — offset_pct is a price markup above IEX forecast
EXCHANGE_CONFIGS: dict[str, dict] = {
    "IEX": {
        "name": "Indian Energy Exchange (IEX)",
        "price_offset_pct": 0.0,
        "bpp_uri": "https://iex-exchange.in/beckn",
        "description": "~85% market share · most liquid · best price discovery",
    },
    "PXIL": {
        "name": "Power Exchange India Ltd (PXIL)",
        "price_offset_pct": 0.007,   # +0.7% above IEX
        "bpp_uri": "https://pxil-exchange.in/beckn",
        "description": "NTPC + PFC joint venture · alternative liquidity pool",
    },
    "HPX": {
        "name": "Hindustan Power Exchange (HPX)",
        "price_offset_pct": 0.003,   # +0.3% above IEX
        "bpp_uri": "https://hpx-exchange.in/beckn",
        "description": "Newest exchange · growing liquidity in RTM segment",
    },
}


async def get_exchange_quote(
    db: AsyncSession,
    exchange_id: str,
    segment: str,
    target_date: str,
    block_start: int,
    block_end: int,
    demand_mw: float,
    transaction_id: str,
) -> Optional[ExchangeQuote]:
    """Build a simulated Beckn catalog item for a given exchange using forecast DB."""

    if exchange_id not in EXCHANGE_CONFIGS:
        return None

    cfg = EXCHANGE_CONFIGS[exchange_id]
    offset = cfg["price_offset_pct"]

    rows = (
        await db.execute(
            select(Forecast)
            .where(
                Forecast.target_date == target_date,
                Forecast.segment == segment,
                Forecast.block >= block_start,
                Forecast.block <= block_end,
            )
            .order_by(Forecast.block)
        )
    ).scalars().all()

    # De-duplicate: keep most recent row per block (highest id)
    latest: dict[int, Forecast] = {}
    for r in rows:
        if r.block not in latest or r.id > latest[r.block].id:
            latest[r.block] = r

    if not latest:
        logger.warning(
            "No forecasts found for %s %s %s blocks %d-%d",
            exchange_id, segment, target_date, block_start, block_end,
        )
        return None

    items = []
    for block in sorted(latest):
        f = latest[block]
        base = f.predicted_price
        adj = round(base * (1 + offset), 4)
        cl = f.confidence_low or base * 0.97
        ch = f.confidence_high or base * 1.03
        items.append({
            "block": block,
            "time": f"{(block - 1) * 15 // 60:02d}:{(block - 1) * 15 % 60:02d}",
            "price_inr_kwh": adj,
            "volume_mw": demand_mw,
            "confidence_low": round(cl * (1 + offset), 4),
            "confidence_high": round(ch * (1 + offset), 4),
        })

    avg_price = sum(i["price_inr_kwh"] for i in items) / len(items)
    # MWh per block = MW × 0.25 h; value = price/kWh × 1000 × MWh / 1000 = price × MWh
    total_mwh = demand_mw * len(items) * 0.25
    total_value = sum(i["price_inr_kwh"] * demand_mw * 250 for i in items)  # 250 = 1000 kWh/MWh × 0.25 h

    return ExchangeQuote(
        exchange_id=exchange_id,
        exchange_name=cfg["name"],
        transaction_id=transaction_id,
        segment=segment,
        target_date=target_date,
        block_start=block_start,
        block_end=block_end,
        items=items,
        avg_price=round(avg_price, 4),
        total_volume_mw=round(demand_mw * len(items), 2),
        total_value_inr=round(total_value, 2),
    )
