import asyncio
import logging
import os
import sqlite3
import importlib
from datetime import datetime, timedelta
from typing import Any, Optional
from zoneinfo import ZoneInfo

import pandas as pd

from backend.common.config import DB_PATH

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
    from backend.forecast_service.model import PriceForecastModel
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


def _run_pipeline_sync() -> None:
    from backend.data.scrape_iex import scrape_date as scrape_iex_date
    from backend.data.scrape_tam import (
        fetch_tam_rsc,
        records_to_rows as tam_records_to_rows,
        store_rows as tam_store_rows,
    )
    lookback_days = max(1, _env_int("SCHEDULER_SCRAPE_LOOKBACK_DAYS", 1))
    tam_region = os.getenv("SCHEDULER_TAM_REGION", "NR").strip().upper() or "NR"
    retrain_enabled = _env_bool("SCHEDULER_RETRAIN_ENABLED", True)

    train_segments_raw = os.getenv("SCHEDULER_TRAIN_SEGMENTS", "DAM,RTM,TAM")
    train_segments = [s.strip().upper() for s in train_segments_raw.split(",") if s.strip()]

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

    if not retrain_enabled:
        logger.info("Retraining disabled by SCHEDULER_RETRAIN_ENABLED=false")
        return

    for segment in train_segments:
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


async def run_daily_pipeline() -> None:
    await asyncio.to_thread(_run_pipeline_sync)


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
    scheduler.start()

    msg = f"Scheduler started: daily scrape+retrain at {hour:02d}:{minute:02d} ({timezone_name})"
    logger.info(msg)
    print(msg, flush=True)

    if _env_bool("SCHEDULER_RUN_ON_STARTUP", False):
        scheduler.add_job(run_daily_pipeline, id="startup-scrape-retrain", replace_existing=True)
        logger.info("Startup run scheduled immediately (SCHEDULER_RUN_ON_STARTUP=true)")


def stop_scheduler() -> None:
    global scheduler
    if scheduler and scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped")
