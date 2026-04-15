from pydantic import BaseModel, Field, field_validator
from typing import Optional, Literal
from datetime import date, datetime


# ── Training Configuration ──────────────────────────────────────────────


class HyperParams(BaseModel):
    """Direct hyperparameters for HistGradientBoostingRegressor."""

    max_iter: int = Field(default=300, ge=50, le=5000)
    max_depth: Optional[int] = Field(default=8, ge=2, le=30)
    learning_rate: float = Field(default=0.05, gt=0, le=1.0)
    min_samples_leaf: int = Field(default=10, ge=1, le=200)
    l2_regularization: float = Field(default=0.0, ge=0.0, le=10.0)
    max_bins: int = Field(default=255, ge=10, le=255)
    max_leaf_nodes: Optional[int] = Field(default=None, ge=2, le=500)
    early_stopping: bool = True
    n_iter_no_change: int = Field(default=10, ge=1, le=100)
    validation_fraction: float = Field(default=0.1, gt=0, lt=0.5)


class TuningConfig(BaseModel):
    """Hyperparameter search configuration."""

    method: Literal["grid", "random"] = "random"
    n_iter: int = Field(
        default=30, ge=5, le=200, description="Iterations for random search"
    )
    cv_folds: int = Field(default=5, ge=2, le=10)
    scoring: Literal[
        "neg_mean_absolute_percentage_error", "neg_mean_squared_error", "r2"
    ] = "neg_mean_absolute_percentage_error"
    param_grid: Optional[dict] = Field(
        default=None,
        description="Custom param grid. If None, uses sensible defaults.",
    )


class FeatureConfig(BaseModel):
    """Control which features to engineer."""

    extra_lags: list[int] = Field(
        default=[], description="Extra lag days, e.g. [2, 3, 14]"
    )
    rolling_windows: list[int] = Field(default=[7], description="Rolling stat windows")
    include_demand_supply_ratio: bool = True
    include_price_momentum: bool = True
    include_ema: bool = True
    ema_span: int = Field(default=7, ge=2, le=30)
    # New feature groups — all default on so a simple retrain gets everything
    include_weather: bool = Field(
        default=True,
        description="Include wind_speed_ms, solar_radiation_wm2, cloud_cover_pct. "
                    "Values come from Open-Meteo via the enrichment pipeline. "
                    "HistGBR handles missing (NaN) values natively."
    )
    include_holidays: bool = Field(
        default=True,
        description="Include is_holiday and days_to_holiday (±7 days). "
                    "Computed from embedded India national holiday table."
    )
    include_month_cyclic: bool = Field(
        default=True,
        description="Replace raw month integer with sin/cos encoding "
                    "to remove the Dec→Jan discontinuity."
    )
    include_price_range: bool = Field(
        default=True,
        description="Add price_range_7d = rolling max - min over 7 days. "
                    "Signals high/low volatility regimes."
    )
    include_summer_signal: bool = Field(
        default=True,
        description="Add is_summer (Apr–Jun flag) and max_temp_7d (7-day rolling max "
                    "temperature). Captures India peak-cooling demand season onset."
    )


class TrainRequest(BaseModel):
    """Full training configuration."""

    segment: str = Field(default="DAM", pattern=r"^(DAM|RTM|TAM)$")
    test_size: float = Field(default=0.2, gt=0.05, lt=0.5)
    shuffle: bool = False
    max_days: Optional[int] = Field(default=None, ge=10, le=3650)
    hyperparams: Optional[HyperParams] = None
    tuning: Optional[TuningConfig] = None
    features: Optional[FeatureConfig] = None
    peak_block_weight: float = Field(default=2.0, ge=1.0, le=10.0, description="Sample weight multiplier for peak DSM blocks (32–64, 8 AM–4 PM). Higher = model focuses more on mid-day accuracy.")


# ── Forecast ────────────────────────────────────────────────────────────


class ForecastRequest(BaseModel):
    target_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    segment: str = Field(..., pattern=r"^(DAM|RTM|TAM)$")

    @field_validator("target_date")
    @classmethod
    def validate_date(cls, v: str) -> str:
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise ValueError(f"Invalid date: {v}")
        return v


class ForecastBlock(BaseModel):
    block: int = Field(..., ge=1, le=96)
    predicted_price: float
    confidence_low: float
    confidence_high: float
    volatility: float
    top_features: list[dict]


class ForecastResponse(BaseModel):
    target_date: str
    segment: str
    blocks: list[ForecastBlock]


class BidItem(BaseModel):
    block: int = Field(..., ge=1, le=96)
    segment: str = Field(..., pattern=r"^(DAM|RTM|TAM)$")
    price: float = Field(..., ge=0)
    volume_mw: float = Field(..., ge=0)
    is_overridden: bool = False
    override_reason: Optional[str] = None


class BidRequest(BaseModel):
    target_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    strategy: str = Field(
        default="balanced", pattern=r"^(conservative|balanced|aggressive)$"
    )
    segment: str = Field(..., pattern=r"^(DAM|RTM|TAM)$")
    bids: list[BidItem]


class BidRecommendationRequest(BaseModel):
    target_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    strategy: str = Field(
        default="balanced", pattern=r"^(conservative|balanced|aggressive)$"
    )
    segment: str = Field(..., pattern=r"^(DAM|RTM|TAM)$")
    demand_mw: float = Field(default=500.0, ge=0)


class ConstraintViolation(BaseModel):
    block: int
    field: str
    value: float
    limit: float
    message: str


class BidRecommendation(BaseModel):
    block: int
    segment: str
    price: float
    volume_mw: float
    strategy: str
    dsm_penalty_estimate: float = 0.0
    uncertainty_score: float = 0.0
    constraint_violations: list[ConstraintViolation] = []
    active_policy: str = ""
    effective_lambda1: float = 0.0
    effective_lambda2: float = 0.0


class RiskRequest(BaseModel):
    session_id: str
    segment: str = Field(..., pattern=r"^(DAM|RTM|TAM)$")
    bids: list[BidItem]


class RiskResult(BaseModel):
    segment: str
    var_95: float
    expected_dsm_penalty: float
    worst_case_penalty: float
    total_exposure: float
    alert_triggered: bool
    alert_details: Optional[dict] = None


class AuditEntry(BaseModel):
    session_id: Optional[str] = None
    user: str = "trader"
    action: str
    entity_type: Optional[str] = None
    entity_id: Optional[int] = None
    details: Optional[dict] = None


class PostMarketRequest(BaseModel):
    target_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    segment: str = Field(..., pattern=r"^(DAM|RTM|TAM)$")
    session_id: Optional[str] = None


class PostMarketBlock(BaseModel):
    block: int
    predicted_price: float
    actual_price: float
    bid_price: Optional[float] = None
    bid_volume: Optional[float] = None
    cleared: bool = False
    error: float
    error_pct: float


class PostMarketSummary(BaseModel):
    target_date: str
    segment: str
    blocks: list[PostMarketBlock]
    mape: float
    bid_hit_rate: float
    basket_rate: float
    baseline_basket_rate: float
    basket_rate_change_pct: float
    total_dsm_penalty: float
