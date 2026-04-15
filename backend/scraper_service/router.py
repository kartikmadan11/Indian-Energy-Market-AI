from typing import Optional
import asyncio
import logging
from datetime import date as date_type, timedelta

logger = logging.getLogger(__name__)
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func as sql_func
from fastapi import Depends

from common.database import get_db
from common.models import PriceHistory
from common.config import DB_PATH

router = APIRouter(prefix="/scraper", tags=["Scraper"])

_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "platform.db"

SEGMENTS = ("DAM", "RTM", "TAM")


def _run_scrape_sync(segment: str, start: date_type, end: date_type) -> dict:
    """Blocking scrape function — runs inside a thread executor."""
    date_range = [
        (start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)
    ]
    total: dict = {"scraped": 0, "inserted": 0, "dates": [], "errors": []}

    if segment in ("DAM", "RTM"):
        from data.scrape_iex import scrape_date

        for d in date_range:
            try:
                result = scrape_date(d, [segment], _DB_PATH)
                seg = result.get(segment, {})
                total["scraped"] += seg.get("scraped", 0)
                total["inserted"] += seg.get("inserted", 0)
                if seg.get("scraped", 0) > 0:
                    total["dates"].append(d)
            except Exception as exc:
                total["errors"].append(f"{d}: {exc}")

    elif segment == "TAM":
        from data.scrape_tam import fetch_tam_rsc, records_to_rows, store_rows

        try:
            raw = fetch_tam_rsc(start.isoformat(), end.isoformat(), contract_type="DAC")
            rows = records_to_rows(raw)
            inserted = store_rows(rows, _DB_PATH)
            total["scraped"] = len(rows)
            total["inserted"] = inserted
            total["dates"] = sorted({r["date"] for r in rows})
        except Exception as exc:
            total["errors"].append(str(exc))

    return total


@router.post("/trigger")
async def trigger_scrape(
    segment: str = Query(
        ..., pattern=r"^(DAM|RTM|TAM)$", description="Market segment to scrape"
    ),
    days: int = Query(
        default=3, ge=1, le=30, description="Number of calendar days back from today"
    ),
    start_date: Optional[str] = Query(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="Explicit start date YYYY-MM-DD (overrides `days`)",
    ),
    end_date: Optional[str] = Query(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="Explicit end date YYYY-MM-DD (defaults to today)",
    ),
):
    """
    Trigger an on-demand scrape from IEX India for a single segment.

    - Use `days` for a rolling window (e.g. last 3 days).
    - Use `start_date` / `end_date` for an explicit date range up to 30 days.
    - Runs in a background thread so the event loop is not blocked.
    - Skips rows already present in the DB (idempotent).
    """
    today = date_type.today()

    if start_date:
        try:
            start = date_type.fromisoformat(start_date)
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid start_date format")
        end = date_type.fromisoformat(end_date) if end_date else today
        if end < start:
            raise HTTPException(
                status_code=422, detail="end_date must be >= start_date"
            )
        if (end - start).days > 29:
            raise HTTPException(
                status_code=422, detail="Date range cannot exceed 30 days"
            )
    else:
        end = today
        start = end - timedelta(days=days - 1)

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _run_scrape_sync, segment, start, end)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if result["errors"] and not result["dates"]:
        raise HTTPException(status_code=502, detail=result["errors"][0])

    return {
        "status": "ok",
        "segment": segment,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "scraped": result["scraped"],
        "inserted": result["inserted"],
        "dates_with_data": result["dates"],
        "errors": result["errors"],
    }


@router.post("/trigger-all")
async def trigger_scrape_all(
    days: int = Query(
        default=3, ge=1, le=30, description="Number of calendar days back from today"
    ),
):
    """
    Trigger a scrape for all three segments (DAM, RTM, TAM) concurrently.
    Returns a per-segment result map.
    """
    today = date_type.today()
    start = today - timedelta(days=days - 1)
    loop = asyncio.get_event_loop()

    async def _scrape_one(seg: str) -> dict:
        try:
            result = await loop.run_in_executor(
                None, _run_scrape_sync, seg, start, today
            )
            return {
                "status": "ok",
                "scraped": result["scraped"],
                "inserted": result["inserted"],
                "dates_with_data": result["dates"],
                "errors": result["errors"],
            }
        except Exception as exc:
            return {"status": "error", "detail": str(exc)}

    results = await asyncio.gather(*[_scrape_one(s) for s in SEGMENTS])
    return {
        "start_date": start.isoformat(),
        "end_date": today.isoformat(),
        "segments": dict(zip(SEGMENTS, results)),
    }


@router.get("/status")
async def scrape_status(db: AsyncSession = Depends(get_db)):
    """
    Return the latest available date and total row count per segment,
    sourced directly from the price_history table.
    """
    status: dict = {"segments": {}}
    for seg in SEGMENTS:
        result = await db.execute(
            select(
                sql_func.max(PriceHistory.date).label("latest_date"),
                sql_func.min(PriceHistory.date).label("earliest_date"),
                sql_func.count(PriceHistory.id).label("row_count"),
            ).where(PriceHistory.segment == seg)
        )
        row = result.one()
        status["segments"][seg] = {
            "latest_date": row.latest_date,
            "earliest_date": row.earliest_date,
            "row_count": row.row_count,
        }
    return status


@router.post("/enrich")
async def trigger_enrichment(
    start_date: Optional[str] = Query(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="Start date for enrichment (YYYY-MM-DD). Auto-detected if omitted.",
    ),
    end_date: Optional[str] = Query(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="End date for enrichment (YYYY-MM-DD). Defaults to today if omitted.",
    ),
    overwrite: bool = Query(
        default=False,
        description="Re-enrich rows that already have weather data.",
    ),
):
    """
    Run the feature enrichment pipeline for price_history rows.

    Fetches from Open-Meteo (free, no API key required) and populates:
      - `temperature`         — replaces sparse scraped values with ERA5 reanalysis
      - `wind_speed_ms`       — 10m wind speed (m/s)
      - `solar_radiation_wm2` — shortwave radiation (W/m²)
      - `cloud_cover_pct`     — total cloud cover (%)

    By default only fills NULL rows; set `overwrite=true` to refresh all.
    Auto-detects the date range from unenriched rows if no dates are provided.

    Returns immediately — enrichment runs in the background. Poll
    GET /enrich/status to track progress.
    """
    from data.enrich_pipeline import run_enrichment

    def _run():
        try:
            result = run_enrichment(
                db_path=DB_PATH,
                start_date=start_date,
                end_date=end_date,
                overwrite=overwrite,
            )
            logger.info("Background enrichment complete: %s", result)
        except Exception:
            logger.exception("Background enrichment failed")

    asyncio.get_running_loop().run_in_executor(None, _run)

    return {
        "status": "started",
        "message": "Enrichment running in background. Poll GET /api/scraper/enrich/status for progress.",
        "params": {
            "start_date": start_date,
            "end_date": end_date,
            "overwrite": overwrite,
        },
    }


@router.get("/enrich/status")
async def enrichment_status():
    """
    Report how many price_history rows are missing weather features.
    Use before running /enrich to estimate enrichment scope.
    """
    from data.enrich_pipeline import unenriched_row_count, get_unenriched_date_range
    from data.scrape_weather import ensure_weather_columns

    ensure_weather_columns(DB_PATH)
    missing = unenriched_row_count(DB_PATH)
    earliest, latest = get_unenriched_date_range(DB_PATH)
    return {
        "unenriched_rows": missing,
        "date_range": {"earliest": earliest, "latest": latest},
        "note": (
            "POST /api/scraper/enrich to fill these rows with weather data."
            if missing > 0
            else "All rows enriched."
        ),
    }
