# Indian Energy Market — AI Bid Preparation Platform

Power trading platform for Indian electricity markets (IEX). Covers the full bid lifecycle: price forecasting across DAM, RTM and TAM segments, strategy-based bid optimization, risk assessment with DSM compliance, and post-market performance analysis.

**Stack:** Python 3.13 · FastAPI · Next.js 14 · scikit-learn · SQLite · Recharts

---

## Quick Start

```bash
./start.sh
# Backend:  http://localhost:8000  (Swagger UI at /docs)
# Frontend: http://localhost:3000
```

Or run each service separately:

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000   # terminal 1
cd frontend && npm run dev                        # terminal 2
```

---

## Architecture

```
backend/
├── main.py                      # FastAPI app, CORS, routers
├── common/                      # Shared config, DB, ORM models, Pydantic schemas
├── forecast_service/            # Price forecasting (train + predict)
├── bid_engine_service/          # Bid recommendation, submission, validation
├── risk_service/                # VaR, DSM penalty estimation, alerts
├── audit_service/               # Immutable action log, post-market analysis
├── jobs/                        # Daily scrape + auto-retrain scheduler
└── data/                        # Scrapers, SQLite DB, trained model files

frontend/src/
├── app/
│   ├── page.tsx                 # Dashboard
│   ├── forecast/page.tsx        # Trading desk — forecast, train, bid optimiser
│   ├── risk/page.tsx            # Risk panel
│   └── analysis/page.tsx        # Post-market analysis
├── components/                  # Sidebar, shared UI
└── lib/                         # API client, helpers
```

---

## Key Features

### Price Forecasting

Trains a HistGradientBoosting model per market segment on ~40k rows of real IEX data (Oct 2025 – Mar 2026). Supports configurable hyperparameters, cross-validated tuning, and custom feature engineering (lag days, rolling windows, EMA, demand-supply ratio). Returns 96-block predictions with 95% confidence intervals and per-block volatility.

### Bid Optimization

Generates bid recommendations using three strategy profiles (conservative, balanced, aggressive). Allocates volume using inverse price-weighting and adjusts prices based on predicted volatility. Enforces CERC 2024 DSM constraints (₹0–12/kWh price band, ≥1 MW volume).

### Risk Assessment

Computes parametric Value-at-Risk at 95% confidence, estimates expected and worst-case DSM penalties, and triggers alerts when portfolio exposure exceeds configurable thresholds.

### Post-Market Analysis

Compares forecasted vs actual cleared prices per block. Reports MAPE, bid hit rate, basket rate, and total DSM penalty for any given trading day.

### Audit Trail

Logs every action (create, override, submit, approve) with session grouping and timestamp for full traceability.

---

## API Overview

| Method | Endpoint                      | Description                      |
| ------ | ----------------------------- | -------------------------------- |
| POST   | `/api/forecast/train`         | Train forecasting model          |
| GET    | `/api/forecast/predict`       | 96-block price forecast          |
| GET    | `/api/forecast/predict-range` | Multi-day forecast               |
| GET    | `/api/forecast/latest`        | Last cached forecast (fallback)  |
| GET    | `/api/forecast/export-csv`    | Download forecast as CSV         |
| GET    | `/api/forecast/health`        | DB + model health check          |
| GET    | `/api/bids/recommend`         | AI bid recommendations           |
| POST   | `/api/bids/submit`            | Submit bid set                   |
| POST   | `/api/bids/validate`          | Validate bids without submitting |
| POST   | `/api/risk/assess`            | VaR + DSM penalty calculation    |
| GET    | `/api/risk/threshold`         | Current risk alert threshold     |
| POST   | `/api/audit/log`              | Create audit entry               |
| GET    | `/api/audit/log`              | Query audit log                  |
| GET    | `/api/audit/post-market`      | Post-market analysis             |

Full request/response schemas available at `http://localhost:8000/docs`.

---

## Data

- **Source:** IEX REST API (DAM, RTM) + IEX RSC endpoint (TAM/DAC)
- **Volume:** ~40,600 rows across 3 market segments
- **Period:** October 2025 – March 2026
- **Granularity:** 96 blocks per day (15-minute intervals)
- **Fields:** date, block, segment, MCP, MCV, demand, supply, renewable generation, temperature

---

## DSM Regulation (CERC 2024 Draft)

| Parameter             | Value     |
| --------------------- | --------- |
| Price floor           | ₹0.0/kWh  |
| Price ceiling         | ₹12.0/kWh |
| Permissible deviation | ±10%      |
| Penalty multiplier    | 1.5×      |

---

See [STATUS.md](STATUS.md) for detailed progress tracking and planned work.
