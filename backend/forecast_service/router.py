from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func as sql_func
from datetime import datetime, timedelta
import pandas as pd
import numpy as np
import io

from common.database import get_db
from common.models import PriceHistory, Forecast
from common.schemas import ForecastResponse, ForecastBlock, TrainRequest
from .model import PriceForecastModel

router = APIRouter(prefix="/forecast", tags=["Forecast"])

# Cache loaded models per segment
_models: dict[str, PriceForecastModel] = {}

# History cache: segment -> (DataFrame, expiry datetime)
_history_cache: dict[str, tuple[pd.DataFrame, datetime]] = {}
_HISTORY_TTL = timedelta(minutes=15)


def _invalidate_history_cache(segment: Optional[str] = None) -> None:
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
    block_start: int = Query(default=1, ge=1, le=96),
    block_end: int = Query(default=96, ge=1, le=96),
    db: AsyncSession = Depends(get_db),
):
    """Generate price forecasts for a target date and segment, optionally filtered to a block range."""
    target_date = _validate_date(target_date)
    if block_start > block_end:
        raise HTTPException(422, "block_start must be <= block_end")
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
    if block_start > 1 or block_end < 96:
        blocks = [b for b in blocks if block_start <= b["block"] <= block_end]

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


@router.get("/predict-range")
async def predict_prices_range(
    date_from: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    date_to: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    block_start: int = Query(default=1, ge=1, le=96),
    block_end: int = Query(default=96, ge=1, le=96),
    db: AsyncSession = Depends(get_db),
):
    """Generate forecasts for a date range (max 30 days), optionally filtered to a block range."""
    date_from = _validate_date(date_from)
    date_to = _validate_date(date_to)
    if block_start > block_end:
        raise HTTPException(422, "block_start must be <= block_end")
    d0 = datetime.strptime(date_from, "%Y-%m-%d")
    d1 = datetime.strptime(date_to, "%Y-%m-%d")
    if d0 > d1:
        raise HTTPException(422, "date_from must be <= date_to")
    if (d1 - d0).days > 29:
        raise HTTPException(422, "Date range cannot exceed 30 days")

    model = _get_model(segment)
    if model.model is None:
        raise HTTPException(
            503, f"No trained model for {segment}. POST /forecast/train first."
        )

    # Reuse history cache (same as single-day endpoint)
    cached = _history_cache.get(segment)
    if cached and datetime.utcnow() < cached[1]:
        history_df = cached[0]
    else:
        result = await db.execute(
            select(PriceHistory)
            .where(PriceHistory.segment == segment)
            .order_by(PriceHistory.date.desc(), PriceHistory.block)
            .limit(96 * 30)
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

    days = []
    current = d0
    while current <= d1:
        date_str = current.strftime("%Y-%m-%d")
        day_blocks = model.predict(date_str, history_df)
        if block_start > 1 or block_end < 96:
            day_blocks = [
                b for b in day_blocks if block_start <= b["block"] <= block_end
            ]
        for b in day_blocks:
            db.add(
                Forecast(
                    target_date=date_str,
                    block=b["block"],
                    segment=segment,
                    predicted_price=b["predicted_price"],
                    confidence_low=b["confidence_low"],
                    confidence_high=b["confidence_high"],
                    volatility=b["volatility"],
                    top_features=b["top_features"],
                )
            )
        days.append({"date": date_str, "blocks": day_blocks})
        current += timedelta(days=1)
    await db.commit()

    return {
        "segment": segment,
        "date_from": date_from,
        "date_to": date_to,
        "days": days,
    }


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

    return ForecastResponse(target_date=target_date, segment=segment, blocks=blocks)


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


@router.get("/model-info")
async def get_model_info(
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
):
    """Return metadata about the currently loaded model: train/test date splits."""
    model = _get_model(segment)
    if model.model is None:
        raise HTTPException(503, f"No trained model for {segment}.")
    train_dates = getattr(model, "train_dates", [])
    test_dates  = getattr(model, "test_dates",  [])
    return {
        "segment": segment,
        "train_dates": train_dates,
        "test_dates":  test_dates,
        "train_count": len(train_dates),
        "test_count":  len(test_dates),
        "trained_on":  f"{train_dates[0]} – {train_dates[-1]}" if train_dates else None,
    }


@router.get("/data-coverage")
async def get_data_coverage(
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    db: AsyncSession = Depends(get_db),
):
    """Return all distinct dates available in price_history for a segment."""
    result = await db.execute(
        select(PriceHistory.date)
        .where(PriceHistory.segment == segment)
        .distinct()
        .order_by(PriceHistory.date)
    )
    dates = [r.date for r in result.all()]
    return {"segment": segment, "dates": dates}


@router.get("/evaluate")
async def evaluate_forecast(
    start_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    end_date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    segment: str = Query(..., pattern=r"^(DAM|RTM|TAM)$"),
    db: AsyncSession = Depends(get_db),
):
    """
    Backtest the trained model against real actuals.
    For each date in [start_date, end_date], predicts 96 blocks using only data
    prior to that date (no leakage), then compares with actuals in price_history.
    Returns per-day and aggregate MAPE/MAE/RMSE/R².
    """
    from sklearn.metrics import r2_score as _r2_score

    start_date = _validate_date(start_date)
    end_date = _validate_date(end_date)
    d0 = datetime.strptime(start_date, "%Y-%m-%d")
    d1 = datetime.strptime(end_date, "%Y-%m-%d")
    if d0 > d1:
        raise HTTPException(422, "start_date must be <= end_date")
    if (d1 - d0).days > 29:
        raise HTTPException(422, "Evaluation range cannot exceed 30 days")

    model = _get_model(segment)
    if model.model is None:
        raise HTTPException(
            503, f"No trained model for {segment}. POST /forecast/train first."
        )

    # Fetch full segment history (we need context before the window + actuals inside it)
    result = await db.execute(
        select(PriceHistory)
        .where(PriceHistory.segment == segment)
        .order_by(PriceHistory.date, PriceHistory.block)
    )
    rows = result.scalars().all()
    if not rows:
        raise HTTPException(400, "No historical data available.")

    full_df = pd.DataFrame(
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

    all_predicted, all_actual = [], []
    daily_results = []

    # Look up which dates were in the model's train/test split
    model_train_dates = set(getattr(model, "train_dates", []))
    model_test_dates  = set(getattr(model, "test_dates",  []))

    current = d0
    while current <= d1:
        date_str = current.strftime("%Y-%m-%d")

        # Actuals for this day
        actuals_day = full_df[full_df["date"] == date_str].copy()
        if actuals_day.empty:
            current += timedelta(days=1)
            continue

        actuals_map = {
            int(r["block"]): float(r["mcp"]) for _, r in actuals_day.iterrows()
        }

        # History strictly before this date (last 30 days for feature engineering)
        cutoff = current
        history_before = full_df[pd.to_datetime(full_df["date"]) < cutoff].copy()
        if len(history_before) < 96 * 7:
            current += timedelta(days=1)
            continue

        # Keep last 30 days of pre-date history
        history_before = history_before.sort_values(["date", "block"]).tail(96 * 30)

        try:
            predicted_blocks = model.predict(date_str, history_before)
        except Exception:
            current += timedelta(days=1)
            continue

        blocks_out = []
        day_predicted, day_actual = [], []
        for pb in predicted_blocks:
            blk = pb["block"]
            pred = pb["predicted_price"]
            actual = actuals_map.get(blk)
            if actual is None:
                continue
            err_pct = abs(pred - actual) / max(abs(actual), 1e-6) * 100
            blocks_out.append(
                {
                    "block": blk,
                    "predicted": round(pred, 4),
                    "actual": round(actual, 4),
                    "error_pct": round(err_pct, 2),
                }
            )
            day_predicted.append(pred)
            day_actual.append(actual)
            all_predicted.append(pred)
            all_actual.append(actual)

        if not day_predicted:
            current += timedelta(days=1)
            continue

        dp = np.array(day_predicted)
        da = np.array(day_actual)
        day_mape = float(np.mean(np.abs(dp - da) / np.maximum(np.abs(da), 1e-6)) * 100)
        day_mae = float(np.mean(np.abs(dp - da)))
        day_rmse = float(np.sqrt(np.mean((dp - da) ** 2)))
        # Filtered MAPE: exclude blocks where actual < ₹1 (avoids solar-collapse noise inflating metric)
        fmask = da >= 1.0
        day_filtered_mape = (
            float(
                np.mean(
                    np.abs(dp[fmask] - da[fmask]) / np.maximum(np.abs(da[fmask]), 1e-6)
                )
                * 100
            )
            if fmask.sum() > 0
            else day_mape
        )

        daily_results.append(
            {
                "date": date_str,
                "data_split": (
                    "train" if date_str in model_train_dates
                    else "test" if date_str in model_test_dates
                    else "unseen"
                ),
                "mape": round(day_mape, 2),
                "filtered_mape": round(day_filtered_mape, 2),
                "mae": round(day_mae, 4),
                "rmse": round(day_rmse, 4),
                "avg_predicted": round(float(np.mean(dp)), 4),
                "avg_actual": round(float(np.mean(da)), 4),
                "blocks": blocks_out,
            }
        )
        current += timedelta(days=1)

    if not all_predicted:
        raise HTTPException(404, "No dates with actuals found in the given range.")

    ap = np.array(all_predicted)
    aa = np.array(all_actual)
    agg_mape = float(np.mean(np.abs(ap - aa) / np.maximum(np.abs(aa), 1e-6)) * 100)
    agg_mae = float(np.mean(np.abs(ap - aa)))
    agg_rmse = float(np.sqrt(np.mean((ap - aa) ** 2)))
    agg_r2 = float(_r2_score(aa, ap))
    agg_fmask = aa >= 1.0
    agg_filtered_mape = (
        float(
            np.mean(
                np.abs(ap[agg_fmask] - aa[agg_fmask])
                / np.maximum(np.abs(aa[agg_fmask]), 1e-6)
            )
            * 100
        )
        if agg_fmask.sum() > 0
        else agg_mape
    )

    best_day = min(daily_results, key=lambda d: d["mape"])
    worst_day = max(daily_results, key=lambda d: d["mape"])

    return {
        "segment": segment,
        "start_date": start_date,
        "end_date": end_date,
        "days_evaluated": len(daily_results),
        "aggregate": {
            "mape": round(agg_mape, 2),
            "filtered_mape": round(agg_filtered_mape, 2),
            "mae": round(agg_mae, 4),
            "rmse": round(agg_rmse, 4),
            "r2": round(agg_r2, 4),
        },
        "best_day": {"date": best_day["date"], "mape": best_day["mape"]},
        "worst_day": {"date": worst_day["date"], "mape": worst_day["mape"]},
        "daily": daily_results,
    }


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
            select(sql_func.max(Forecast.created_at).label("latest_forecast")).where(
                Forecast.segment == seg
            )
        )
        fc_row = fc.one()
        status["segments"][seg] = {
            "latest_data": row.latest_data,
            "row_count": row.row_count,
            "latest_forecast": (
                str(fc_row.latest_forecast) if fc_row.latest_forecast else None
            ),
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

    # Optionally limit to the most recent N days
    if req.max_days:
        dates = sorted(df["date"].unique())[-req.max_days :]
        df = df[df["date"].isin(dates)]

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

    train_kwargs["peak_block_weight"] = req.peak_block_weight

    metrics = model.train(df, **train_kwargs)
    _models[segment] = model
    _invalidate_history_cache(segment)

    return {"status": "trained", "segment": segment, "metrics": metrics}
