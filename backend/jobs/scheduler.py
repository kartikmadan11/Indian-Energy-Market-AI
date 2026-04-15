import asyncio
import logging
import os
import sqlite3
import importlib
from datetime import datetime, timedelta
from typing import Any, Optional
from zoneinfo import ZoneInfo

import pandas as pd

from common.config import DB_PATH

logger = logging.getLogger(__name__)

scheduler: Optional[Any] = None


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        logger.warning("Invalid int for %s=%s, using default=%s", name, value, default)
        return default


def _train_segment(segment: str) -> dict:
    from forecast_service.model import PriceForecastModel

    conn = sqlite3.connect(DB_PATH)
    try:
        df = pd.read_sql_query(
            """
            SELECT date, block, segment, mcp, mcv, demand_mw, supply_mw, renewable_gen_mw, temperature
            FROM price_history
            WHERE segment = ?
            ORDER BY date, block
            """,
            conn,
            params=(segment,),
        )
    finally:
        conn.close()

    if len(df) < 96 * 10:
        raise ValueError(
            f"Not enough rows for {segment} retraining: {len(df)} rows (need >= 960)"
        )

    model = PriceForecastModel(segment=segment)
    metrics = model.train(df, test_size=0.2, shuffle=False)
    return metrics


def _feedback_loop_sync() -> dict:
    """Evaluate yesterday's forecast accuracy against actual settled prices.

    Joins the most-recent forecast per block with price_history actuals for
    yesterday, computes per-segment MAPE, and writes the result to audit_log.

    Returns a mapping {segment: mape_float} for segments where enough data
    was available (>= 10 blocks matched).  Segments with MAPE above
    FEEDBACK_MAPE_THRESHOLD indicate model degradation and will trigger a
    forced retrain even if SCHEDULER_RETRAIN_ENABLED=false.
    """
    import json as _json

    mape_threshold = float(os.getenv("FEEDBACK_MAPE_THRESHOLD", "15.0"))
    yesterday = (datetime.now().date() - timedelta(days=1)).isoformat()

    segment_mape: dict = {}
    conn = sqlite3.connect(DB_PATH)
    try:
        for segment in ["DAM", "RTM", "TAM"]:
            df_raw = pd.read_sql_query(
                """
                SELECT f.block, f.predicted_price, f.created_at, p.mcp
                FROM forecasts f
                JOIN price_history p
                  ON f.block = p.block AND p.date = ? AND p.segment = ?
                WHERE f.target_date = ? AND f.segment = ? AND p.mcp > 0
                """,
                conn,
                params=(yesterday, segment, yesterday, segment),
            )

            if df_raw.empty:
                logger.info(
                    "Feedback loop: no matched rows for %s on %s, skipping",
                    segment, yesterday,
                )
                continue

            # Keep the most-recent forecast per block (handles multiple predict runs)
            df = (
                df_raw.sort_values("created_at")
                .groupby("block")
                .last()
                .reset_index()
            )

            if len(df) < 10:
                logger.info(
                    "Feedback loop: only %d blocks for %s on %s, skipping",
                    len(df), segment, yesterday,
                )
                continue

            mape = float(
                ((df["predicted_price"] - df["mcp"]).abs() / df["mcp"].clip(lower=0.01)).mean() * 100
            )
            mape = round(mape, 4)
            segment_mape[segment] = mape

            triggered_retrain = mape > mape_threshold
            details = _json.dumps({
                "date": yesterday,
                "segment": segment,
                "mape": mape,
                "blocks_compared": int(len(df)),
                "threshold": mape_threshold,
                "triggered_retrain": triggered_retrain,
            })

            conn.execute(
                """
                INSERT INTO audit_log
                  (session_id, user, action, entity_type, details, timestamp)
                VALUES (?, 'scheduler', 'feedback_loop', 'forecast', ?, datetime('now'))
                """,
                (f"feedback-{yesterday}-{segment.lower()}", details),
            )
            conn.commit()

            logger.info(
                "Feedback loop %s: MAPE=%.2f%% blocks=%d triggered_retrain=%s",
                segment, mape, len(df), triggered_retrain,
            )
    except Exception:
        logger.exception("Feedback loop failed for segment=%s", segment)
    finally:
        conn.close()

    return segment_mape


def _run_pipeline_sync() -> None:
    from data.scrape_iex import scrape_date as scrape_iex_date
    from data.scrape_tam import (
        fetch_tam_rsc,
        records_to_rows as tam_records_to_rows,
        store_rows as tam_store_rows,
    )

    lookback_days = max(1, _env_int("SCHEDULER_SCRAPE_LOOKBACK_DAYS", 1))
    tam_region = os.getenv("SCHEDULER_TAM_REGION", "NR").strip().upper() or "NR"
    retrain_enabled = _env_bool("SCHEDULER_RETRAIN_ENABLED", True)

    train_segments_raw = os.getenv("SCHEDULER_TRAIN_SEGMENTS", "DAM,RTM,TAM")
    train_segments = [
        s.strip().upper() for s in train_segments_raw.split(",") if s.strip()
    ]

    today = datetime.now().date()
    end_date = today - timedelta(days=1)
    start_date = end_date - timedelta(days=lookback_days - 1)

    logger.info(
        "Scheduler pipeline start: scrape %s..%s, retrain=%s segments=%s region=%s",
        start_date,
        end_date,
        retrain_enabled,
        train_segments,
        tam_region,
    )

    current = start_date
    iex_inserted_total = 0
    while current <= end_date:
        date_str = current.strftime("%Y-%m-%d")
        result = scrape_iex_date(date_str, ["DAM", "RTM"], DB_PATH)
        for seg in ["DAM", "RTM"]:
            iex_inserted_total += result.get(seg, {}).get("inserted", 0)
        current += timedelta(days=1)

    logger.info("DAM/RTM scrape done, new rows inserted=%s", iex_inserted_total)

    # TAM RSC endpoint accepts a date range; pull once for the same window.
    raw_tam = fetch_tam_rsc(
        start_date.strftime("%Y-%m-%d"),
        end_date.strftime("%Y-%m-%d"),
        contract_type="DAC",
    )
    tam_rows = tam_records_to_rows(raw_tam, region=tam_region)
    tam_inserted = tam_store_rows(tam_rows, DB_PATH)
    logger.info(
        "TAM scrape done: raw=%s block_rows=%s inserted=%s",
        len(raw_tam),
        len(tam_rows),
        tam_inserted,
    )

    # --- Feedback loop: evaluate yesterday's forecast quality vs settled actuals ---
    segment_mape: dict = {}
    try:
        segment_mape = _feedback_loop_sync()
    except Exception:
        logger.exception("Feedback loop evaluation failed (non-fatal)")

    mape_threshold = float(os.getenv("FEEDBACK_MAPE_THRESHOLD", "15.0"))

    # Determine which segments to retrain:
    #   - If global retrain is enabled → retrain all configured segments
    #   - If disabled → only retrain segments where MAPE degraded past threshold
    if retrain_enabled:
        segments_to_retrain = train_segments
    else:
        segments_to_retrain = [
            s for s in train_segments
            if segment_mape.get(s, 0.0) > mape_threshold
        ]
        if not segments_to_retrain:
            logger.info(
                "Retraining disabled and no segments degraded (threshold=%.1f%%). Skipping retrain.",
                mape_threshold,
            )
            return
        logger.info(
            "Retraining disabled globally but forcing retrain for degraded segments %s "
            "(MAPE above %.1f%% threshold)",
            segments_to_retrain, mape_threshold,
        )

    for segment in segments_to_retrain:
        try:
            metrics = _train_segment(segment)
            logger.info(
                "Retrained %s: MAPE=%s SMAPE=%s RMSE=%s",
                segment,
                metrics.get("mape"),
                metrics.get("smape"),
                metrics.get("rmse"),
            )
        except Exception:
            logger.exception("Retraining failed for segment=%s", segment)


def _run_enrichment_sync() -> None:
    """Enrich the last 2 days of price_history with weather data from Open-Meteo."""
    from data.enrich_pipeline import run_enrichment

    enrichment_enabled = _env_bool("SCHEDULER_ENRICHMENT_ENABLED", True)
    if not enrichment_enabled:
        logger.info("Feature enrichment disabled by SCHEDULER_ENRICHMENT_ENABLED=false")
        return

    today = datetime.now().date()
    # Enrich yesterday and day-before (IEX scrape runs for yesterday; ERA5 has 5-day lag
    # so very recent data is served by Open-Meteo forecast API instead)
    start_date = (today - timedelta(days=2)).isoformat()
    end_date   = today.isoformat()

    try:
        result = run_enrichment(DB_PATH, start_date=start_date, end_date=end_date)
        logger.info(
            "Enrichment done: status=%s weather_updated=%s skipped=%s errors=%s",
            result.get("status"),
            result.get("weather", {}).get("updated", 0),
            result.get("weather", {}).get("skipped", 0),
            result.get("weather", {}).get("errors", []),
        )
    except Exception:
        logger.exception("Daily enrichment failed")


async def run_daily_pipeline() -> None:
    await asyncio.to_thread(_run_pipeline_sync)


async def run_daily_enrichment() -> None:
    await asyncio.to_thread(_run_enrichment_sync)


def start_scheduler() -> None:
    global scheduler

    # Ensure application loggers are visible in journald
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")

    try:
        AsyncIOScheduler = importlib.import_module(
            "apscheduler.schedulers.asyncio"
        ).AsyncIOScheduler
        CronTrigger = importlib.import_module("apscheduler.triggers.cron").CronTrigger
    except Exception:
        logger.warning(
            "APScheduler is not installed. Install dependencies to enable background scheduler."
        )
        return

    enabled = _env_bool("SCHEDULER_ENABLED", False)
    if not enabled:
        logger.info("Scheduler disabled. Set SCHEDULER_ENABLED=true to enable.")
        return

    if scheduler and scheduler.running:
        return

    timezone_name = os.getenv("SCHEDULER_TIMEZONE", "Asia/Kolkata")
    timezone = ZoneInfo(timezone_name)

    minute = _env_int("SCHEDULER_CRON_MINUTE", 10)
    hour = _env_int("SCHEDULER_CRON_HOUR", 1)

    scheduler = AsyncIOScheduler(timezone=timezone)
    scheduler.add_job(
        run_daily_pipeline,
        CronTrigger(hour=hour, minute=minute, timezone=timezone),
        id="daily-scrape-retrain",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3600,
    )

    # Enrichment runs 30 min after the scrape to ensure yesterday's price rows exist
    enrich_minute = (minute + 30) % 60
    enrich_hour   = hour + ((minute + 30) // 60)
    scheduler.add_job(
        run_daily_enrichment,
        CronTrigger(hour=enrich_hour % 24, minute=enrich_minute, timezone=timezone),
        id="daily-enrichment",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3600,
    )

    scheduler.start()

    msg = (
        f"Scheduler started: scrape+retrain at {hour:02d}:{minute:02d}, "
        f"enrichment at {enrich_hour % 24:02d}:{enrich_minute:02d} ({timezone_name})"
    )
    logger.info(msg)
    print(msg, flush=True)

    if _env_bool("SCHEDULER_RUN_ON_STARTUP", False):
        scheduler.add_job(
            run_daily_pipeline, id="startup-scrape-retrain", replace_existing=True
        )
        logger.info("Startup run scheduled immediately (SCHEDULER_RUN_ON_STARTUP=true)")


def stop_scheduler() -> None:
    global scheduler
    if scheduler and scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped")
