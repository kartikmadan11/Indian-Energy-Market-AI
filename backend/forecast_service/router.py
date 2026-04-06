from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func as sql_func
from datetime import datetime, timedelta
import pandas as pd
import io

from backend.common.database import get_db
from backend.common.models import PriceHistory, Forecast
from backend.common.schemas import ForecastResponse, ForecastBlock, TrainRequest
from .model import PriceForecastModel

router = APIRouter(prefix="/forecast", tags=["Forecast"])

# Cache loaded models per segment
_models: dict[str, PriceForecastModel] = {}

# History cache: segment -> (DataFrame, expiry datetime)
_history_cache: dict[str, tuple[pd.DataFrame, datetime]] = {}
_HISTORY_TTL = timedelta(minutes=15)


def _invalidate_history_cache(segment: str | None = None) -> None:
    if segment:
        _history_cache.pop(segment, None)
    else:
        _history_cache.clear()


def _get_model(segment: str) -> PriceForecastModel:
    if segment not in _models:
        m = PriceForecastModel(segment=segment)
        m.load()
        _models[segment] = m
    return _models[segment]


def _validate_date(d: str) -> str:
    try:
        datetime.strptime(d, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(422, f"Invalid date: {d}")
    return d


@router.get("/predict", response_model=ForecastResponse)
async def predict_prices(
    target_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    db: AsyncSession = Depends(get_db),
):
    """Generate 96-block price forecasts for a target date and segment."""
    target_date = _validate_date(target_date)
    model = _get_model(segment)
    if model.model is None:
        raise HTTPException(
            503, f"No trained model for {segment}. POST /forecast/train first."
        )

    # Fetch recent history for feature engineering (cached for 15 min)
    cached = _history_cache.get(segment)
    if cached and datetime.utcnow() < cached[1]:
        history_df = cached[0]
    else:
        result = await db.execute(
            select(PriceHistory)
            .where(PriceHistory.segment == segment)
            .order_by(PriceHistory.date.desc(), PriceHistory.block)
            .limit(96 * 30)  # last ~30 days
        )
        rows = result.scalars().all()
        if not rows:
            raise HTTPException(400, "No historical data available. Load data first.")
        history_df = pd.DataFrame(
            [
                {
                    "date": r.date,
                    "block": r.block,
                    "segment": r.segment,
                    "mcp": r.mcp,
                    "mcv": r.mcv,
                    "demand_mw": r.demand_mw,
                    "supply_mw": r.supply_mw,
                    "renewable_gen_mw": r.renewable_gen_mw,
                    "temperature": r.temperature,
                }
                for r in rows
            ]
        )
        _history_cache[segment] = (history_df, datetime.utcnow() + _HISTORY_TTL)

    blocks = model.predict(target_date, history_df)

    # Persist forecasts
    for b in blocks:
        db.add(
            Forecast(
                target_date=target_date,
                block=b["block"],
                segment=segment,
                predicted_price=b["predicted_price"],
                confidence_low=b["confidence_low"],
                confidence_high=b["confidence_high"],
                volatility=b["volatility"],
                top_features=b["top_features"],
            )
        )
    await db.commit()

    return ForecastResponse(
        target_date=target_date,
        segment=segment,
        blocks=[ForecastBlock(**b) for b in blocks],
    )


@router.get("/latest", response_model=ForecastResponse)
async def get_latest_forecast(
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    db: AsyncSession = Depends(get_db),
):
    """Return the most recent stored forecast for a segment (stale-data fallback)."""
    result = await db.execute(
        select(Forecast)
        .where(Forecast.segment == segment)
        .order_by(Forecast.created_at.desc())
        .limit(96)
    )
    rows = result.scalars().all()
    if not rows:
        raise HTTPException(404, f"No cached forecast for {segment}.")

    target_date = rows[0].target_date
    blocks = [
        ForecastBlock(
            block=r.block,
            predicted_price=r.predicted_price,
            confidence_low=r.confidence_low or r.predicted_price * 0.9,
            confidence_high=r.confidence_high or r.predicted_price * 1.1,
            volatility=r.volatility or 0.0,
            top_features=r.top_features or [],
        )
        for r in sorted(rows, key=lambda x: x.block)
    ]

    return ForecastResponse(
        target_date=target_date, segment=segment, blocks=blocks
    )


@router.get("/export-csv")
async def export_forecast_csv(
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    db: AsyncSession = Depends(get_db),
):
    """Export the latest forecast as CSV for manual exchange upload."""
    result = await db.execute(
        select(Forecast)
        .where(Forecast.segment == segment)
        .order_by(Forecast.created_at.desc())
        .limit(96)
    )
    rows = result.scalars().all()
    if not rows:
        raise HTTPException(404, f"No forecast data for {segment}.")

    df = pd.DataFrame(
        [
            {
                "block": r.block,
                "target_date": r.target_date,
                "segment": segment,
                "predicted_price_inr_kwh": r.predicted_price,
                "confidence_low": r.confidence_low,
                "confidence_high": r.confidence_high,
                "volatility": r.volatility,
            }
            for r in sorted(rows, key=lambda x: x.block)
        ]
    )
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)

    filename = f"forecast_{segment}_{rows[0].target_date}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/history")
async def get_price_history(
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    days: int = Query(default=7, ge=1, le=60),
    db: AsyncSession = Depends(get_db),
):
    """Return the last `days` days of scraped MCP data for a segment."""
    result = await db.execute(
        select(PriceHistory.date, PriceHistory.block, PriceHistory.mcp)
        .where(PriceHistory.segment == segment)
        .order_by(PriceHistory.date.desc(), PriceHistory.block)
        .limit(days * 96)
    )
    rows = result.all()
    return [{"date": r.date, "block": r.block, "mcp": r.mcp} for r in rows]


@router.get("/health")
async def forecast_health(db: AsyncSession = Depends(get_db)):
    """Health check: DB connectivity + latest data timestamps per segment."""
    status = {"status": "ok", "segments": {}}
    for seg in ["DAM", "RTM", "TAM"]:
        result = await db.execute(
            select(
                sql_func.max(PriceHistory.date).label("latest_data"),
                sql_func.count(PriceHistory.id).label("row_count"),
            ).where(PriceHistory.segment == seg)
        )
        row = result.one()
        # Latest forecast
        fc = await db.execute(
            select(sql_func.max(Forecast.created_at).label("latest_forecast"))
            .where(Forecast.segment == seg)
        )
        fc_row = fc.one()
        status["segments"][seg] = {
            "latest_data": row.latest_data,
            "row_count": row.row_count,
            "latest_forecast": str(fc_row.latest_forecast) if fc_row.latest_forecast else None,
        }
    return status


@router.post("/train")
async def train_model(req: TrainRequest = None, db: AsyncSession = Depends(get_db)):
    """
    Train the forecasting model on available historical data.

    Send an empty POST for defaults, or a JSON body to customise:
    - **hyperparams**: direct model params (max_iter, learning_rate, …)
    - **tuning**: enable CV search (method, n_iter, cv_folds, param_grid)
    - **features**: extra lags, rolling windows, demand/supply ratio, EMA, momentum
    """
    if req is None:
        req = TrainRequest()

    segment = req.segment

    result = await db.execute(
        select(PriceHistory)
        .where(PriceHistory.segment == segment)
        .order_by(PriceHistory.date, PriceHistory.block)
    )
    rows = result.scalars().all()
    if not rows:
        raise HTTPException(400, "No historical data. Load data first.")

    df = pd.DataFrame(
        [
            {
                "date": r.date,
                "block": r.block,
                "segment": r.segment,
                "mcp": r.mcp,
                "mcv": r.mcv,
                "demand_mw": r.demand_mw,
                "supply_mw": r.supply_mw,
                "renewable_gen_mw": r.renewable_gen_mw,
                "temperature": r.temperature,
            }
            for r in rows
        ]
    )

    model = PriceForecastModel(segment=segment)

    # Build kwargs for model.train()
    train_kwargs = {
        "test_size": req.test_size,
        "shuffle": req.shuffle,
    }

    if req.hyperparams:
        train_kwargs["hyperparams"] = req.hyperparams.model_dump(exclude_none=True)

    if req.tuning:
        train_kwargs["tuning"] = req.tuning.model_dump(exclude_none=True)

    if req.features:
        train_kwargs["feature_cfg"] = req.features.model_dump()

    metrics = model.train(df, **train_kwargs)
    _models[segment] = model
    _invalidate_history_cache(segment)

    return {"status": "trained", "segment": segment, "metrics": metrics}
