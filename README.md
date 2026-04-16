# EnergyTrader — ML-Driven Market Participation Platform

Data-driven bid preparation and market participation platform for India's power trading ecosystem (DISCOMs and Open Access consumers). Covers the full bid lifecycle: multi-exchange data ingestion, 96-block price forecasting via gradient boosting, LP-based bid optimisation, DSM constraint enforcement, rule-based compliance approval, risk assessment, and post-market learning.

**Stack:** Python 3.12 · FastAPI · Next.js 14 · scikit-learn · PuLP · SQLite · Recharts · APScheduler

---

## Quick Start

```bash
# Backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Or use the provided launcher:
```bash
bash start.sh
```

Frontend runs at `http://localhost:3000`, API at `http://localhost:8000` (Swagger: `http://localhost:8000/docs`).

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

### Multi-Exchange Data Ingestion

Scrapes DAM, RTM, and TAM market data from IEX, PXIL, and HPX via REST API. Supports on-demand fetching through FastAPI endpoints (`/api/scraper/*`) and automated nightly collection via APScheduler cron (01:10 IST). Data is stored in SQLite WAL (~40k rows).

### Price Forecasting

Trains a HistGradientBoosting model per market segment on real exchange data (Oct 2025 – Apr 2026). Supports configurable hyperparameters, cross-validated tuning, and 28 engineered features (lag days, rolling windows, EMA, demand-supply ratio). Returns 96-block predictions with 95% confidence intervals and per-block volatility. Achieved DAM 2.27% MAPE, RTM 3.14%, TAM 3.83%.

### LP-Based Bid Optimisation

Generates bid recommendations using a PuLP CBC LP solver with a λ-weighted objective: maximise procurement value while penalising DSM band breaches, severe deviations, and forecast uncertainty. Three strategy profiles (conservative, balanced, aggressive) tune the penalty weights, producing ~10% average price difference between extremes.

### Policy-as-Code DSM Enforcement

CERC DSM regulations are stored as YAML files (`cerc_dsm_2019.yaml`, `cerc_dsm_2024_draft.yaml`) loaded at runtime — no hardcoded constants. Active regulation is switchable via the Policy management UI or API (`/api/policy/*`). Constraint violations (price band, technical minimum, deviation band) are flagged before submission with corrective suggestions.

### Rule-Based Compliance Approval

Before submission, an automated approval agent runs 7 compliance checks (4 hard rules, 3 soft rules) and returns a structured verdict with per-check reasoning. Hard rule failures block submission; soft rule warnings require manual override.

### Risk Assessment

Computes parametric Value-at-Risk at 95% confidence, estimates expected and worst-case DSM penalties via Monte Carlo simulation, and triggers alerts when portfolio exposure exceeds configurable thresholds. Threshold is passable per request via `/api/risk/assess`.

### Post-Market Learning Loop

Compares forecasted vs actual cleared prices per block. Reports MAPE, bid hit rate, basket rate, and total DSM penalty. Outcomes feed back into the next training cycle via APScheduler auto-retrain at 01:10 IST.

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
| GET    | `/api/bids/recommend`         | ML bid recommendations           |
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

- **Sources:** IEX REST API (DAM, RTM) · IEX RSC endpoint (TAM/DAC) · PXIL · HPX
- **Volume:** ~40,600 rows across 3 market segments
- **Period:** October 2025 – April 2026
- **Granularity:** 96 blocks per day (15-minute intervals)
- **Fields:** date, block, segment, MCP, MCV, demand, supply, renewable generation, temperature

---

## DSM Regulation (Policy-as-Code)

Regulations are loaded from YAML at runtime. Switch active policy via `/api/policy/activate`.

| Parameter             | CERC 2019 | CERC 2024 Draft |
| --------------------- | --------- | --------------- |
| Price floor           | ₹0.0/kWh  | ₹0.0/kWh        |
| Price ceiling         | ₹12.0/kWh | ₹12.0/kWh       |
| Permissible deviation | ±10%      | ±7%             |
| Penalty multiplier    | 1.5×      | 1.5×            |

---

See [STATUS.md](STATUS.md) for detailed progress tracking and planned work.
