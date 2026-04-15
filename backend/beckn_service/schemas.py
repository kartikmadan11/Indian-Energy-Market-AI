"""Pydantic schemas for Beckn Protocol / UEI energy domain."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


def _ts() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _uid() -> str:
    return str(uuid.uuid4())


# ── Beckn Context ─────────────────────────────────────────────────────────────

class BecknContext(BaseModel):
    domain: str = "uei:energy"
    version: str = "1.1.0"
    action: str
    bap_id: str = "power-trader.example.com"
    bap_uri: str = "https://power-trader.example.com/beckn"
    bpp_id: Optional[str] = None
    bpp_uri: Optional[str] = None
    transaction_id: str = Field(default_factory=_uid)
    message_id: str = Field(default_factory=_uid)
    timestamp: str = Field(default_factory=_ts)
    country: str = "IND"
    city: str = "std:011"


# ── Search ────────────────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    segment: str = Field(..., pattern=r"^(DAM|RTM|TAM)$")
    target_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    block_start: int = Field(default=1, ge=1, le=96)
    block_end: int = Field(default=96, ge=1, le=96)
    demand_mw: float = Field(default=500.0, ge=1.0)


class ExchangeQuote(BaseModel):
    exchange_id: str
    exchange_name: str
    transaction_id: str
    segment: str
    target_date: str
    block_start: int
    block_end: int
    items: list[dict[str, Any]]
    avg_price: float
    total_volume_mw: float
    total_value_inr: float


class SearchResponse(BaseModel):
    context: BecknContext
    transaction_id: str
    providers: list[ExchangeQuote]
    search_params: dict[str, Any]


# ── Select ────────────────────────────────────────────────────────────────────

class SelectRequest(BaseModel):
    transaction_id: str
    exchange_id: str = Field(..., pattern=r"^(IEX|PXIL|HPX)$")
    segment: str = Field(..., pattern=r"^(DAM|RTM|TAM)$")
    target_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    block_start: int = Field(default=1, ge=1, le=96)
    block_end: int = Field(default=96, ge=1, le=96)
    demand_mw: float = Field(default=500.0, ge=1.0)


class SelectResponse(BaseModel):
    context: BecknContext
    transaction_id: str
    quote: ExchangeQuote
    beckn_quote: dict[str, Any]


# ── Init ──────────────────────────────────────────────────────────────────────

class InitRequest(BaseModel):
    transaction_id: str
    exchange_id: str = Field(..., pattern=r"^(IEX|PXIL|HPX)$")
    segment: str = Field(..., pattern=r"^(DAM|RTM|TAM)$")
    target_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    block_start: int = Field(default=1, ge=1, le=96)
    block_end: int = Field(default=96, ge=1, le=96)
    demand_mw: float = Field(default=500.0, ge=1.0)
    billing_entity: str = "DISCOM-Default"


class InitResponse(BaseModel):
    context: BecknContext
    transaction_id: str
    order_id: str
    status: str
    exchange_id: str
    segment: str
    target_date: str
    items: list[dict[str, Any]]
    total_volume_mw: float
    total_value_inr: float
    fulfillment: dict[str, Any]


# ── Confirm ───────────────────────────────────────────────────────────────────

class ConfirmRequest(BaseModel):
    transaction_id: Optional[str] = None
    order_id: str


class ConfirmResponse(BaseModel):
    context: BecknContext
    transaction_id: str
    order_id: str
    status: str
    message: str
    exchange_id: str
    segment: str
    target_date: str


# ── Order model ───────────────────────────────────────────────────────────────

class BecknOrder(BaseModel):
    order_id: str
    transaction_id: str
    status: str
    exchange_id: str
    segment: str
    target_date: str
    block_start: int
    block_end: int
    demand_mw: float
    items: list[dict[str, Any]]
    total_volume_mw: float
    total_value_inr: float
    avg_price: float
    created_at: str
    confirmed_at: Optional[str] = None
    billing_entity: str = "DISCOM-Default"
