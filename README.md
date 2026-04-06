# AI-Powered Market Participation & Bid Preparation Platform

Power trading platform for Indian electricity markets (IEX) with AI-driven price forecasting, bid optimization, risk assessment, and post-market analytics.

**Stack:** Python 3.13 · FastAPI · Next.js 14 · scikit-learn · SQLite · Recharts

---

## Quick Start

```bash
./start.sh
# Backend: http://localhost:8000 (Swagger: /docs)
# Frontend: http://localhost:3000
```

Or manually:
```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000  # terminal 1
cd frontend && npm run dev                       # terminal 2
```

---

## Project Structure

```
backend/
├── main.py                     # FastAPI app, CORS, Swagger UI
├── common/
│   ├── config.py               # DSM regs, market constants (96 blocks, price bands)
│   ├── database.py             # Async SQLAlchemy + SQLite
│   ├── models.py               # ORM: PriceHistory, Forecast, Bid, RiskSnapshot, AuditLog
│   └── schemas.py              # Pydantic: TrainRequest, HyperParams, TuningConfig, etc.
├── forecast_service/
│   ├── model.py                # HistGradientBoosting with CV tuning, 28 features
│   └── router.py               # POST /train, GET /predict
├── bid_engine_service/
│   ├── optimizer.py            # Strategy-based bid generation (conservative/balanced/aggressive)
│   └── router.py               # GET /recommend, POST /submit, POST /validate
├── risk_service/
│   ├── engine.py               # VaR@95%, DSM penalty estimation, alerts
│   └── router.py               # POST /assess, GET /threshold
├── audit_service/
│   └── router.py               # POST+GET /log, GET /post-market
└── data/
    ├── platform.db             # SQLite database (auto-created)
    ├── scrape_iex.py           # IEX REST API scraper (DAM, RTM)
    ├── scrape_tam.py           # TAM scraper via RSC endpoint (DAC trade-details)
    └── models/                 # Trained .pkl files (DAM, RTM, TAM)

frontend/src/
├── app/
│   ├── page.tsx                # Dashboard / landing
│   ├── forecast/page.tsx       # Train & visualize 96-block price forecasts
│   ├── bids/page.tsx           # AI bid recommendations + manual overrides
│   ├── risk/page.tsx           # VaR, DSM penalties, risk alerts
│   └── analysis/page.tsx       # Post-market: forecast accuracy, bid performance
├── components/Sidebar.tsx      # Navigation
└── lib/
    ├── api.ts                  # Axios API client
    └── utils.ts                # formatINR, blockToTime, constants
```

---

## What's Done

### 1. Data Ingestion
- [x] IEX REST API scraper (`scrape_iex.py`) using `https://www.iexindia.com/api/v1/{segment}/market-snapshot`
- [x] 34,752 rows of real market data (Oct 2025 – Mar 2026), DAM + RTM
- [x] TAM scraper (`scrape_tam.py`) using IEX RSC endpoint for DAC trade-details (block-level)
- [x] 5,868 TAM rows (Oct 2025 – Mar 2026), 142 trading days, DAC-NR contract type
- [x] **Total: 40,620 rows** across 3 market segments
- [x] Fields: date, block (1-96), segment, MCP, MCV, demand, supply, renewable gen, temperature

### 2. Price Forecasting Engine
- [x] HistGradientBoostingRegressor (scikit-learn)
- [x] 28 engineered features: temporal, lag (1d/2d/3d/7d/14d), rolling stats (3d/7d/14d avg/std/median), EMA, demand-supply ratio, price momentum, cyclic block encoding
- [x] Parameterised `POST /train` API with full config:
  - Direct hyperparameter override (`HyperParams` schema)
  - Hyperparameter search: `RandomizedSearchCV` / `GridSearchCV` with `TimeSeriesSplit`
  - Configurable feature engineering (`FeatureConfig`: extra lags, rolling windows, EMA span)
  - Configurable train/test split ratio
- [x] Metrics returned: MAPE, sMAPE, filtered MAPE, RMSE, MAE, R², per-block error, best params from CV
- [x] Model persistence with feature names for forward-compatible prediction
- [x] **DAM: 2.27% MAPE, R²=0.9956** | **RTM: 3.14% filtered MAPE, R²=0.9903** | **TAM: 3.83% MAPE, R²=0.9656**

### 3. Bid Optimization
- [x] 3 strategy profiles: conservative (risk-averse), balanced, aggressive
- [x] Inverse price-weighted volume allocation across 96 blocks
- [x] Price = predicted + (strategy offset × volatility)
- [x] DSM constraint enforcement (CERC 2024 draft): price ₹0–12/kWh, volume ≥1 MW
- [x] Constraint validation endpoint (`POST /validate`)

### 4. Risk Assessment
- [x] Value-at-Risk @ 95% confidence (parametric)
- [x] DSM penalty estimation: expected + worst-case
- [x] Alert triggering when VaR > ₹5,00,000 threshold
- [x] Total portfolio exposure calculation

### 5. Post-Market Analysis
- [x] Predicted vs actual price comparison per block
- [x] Metrics: MAPE, bid hit rate, basket rate, basket rate change %, total DSM penalty

### 6. Audit Trail
- [x] Immutable action log: create_bid, override, submit, approve
- [x] Session-based grouping (session_id)
- [x] Query with filtering by session/action

### 7. Frontend (Next.js 14 + Tailwind + Recharts)
- [x] Dashboard with workflow overview
- [x] Forecast page: train models, visualize price bands (AreaChart with confidence intervals)
- [x] Bid workspace: AI recommendations, editable overrides with reason field
- [x] Risk panel: VaR / DSM bar charts, alert indicators
- [x] Post-market analysis: accuracy metrics, audit log table
- [x] Sidebar navigation across all pages

### 8. Infrastructure
- [x] FastAPI gateway with 4 microservice routers
- [x] SQLite + async SQLAlchemy (no Docker needed)
- [x] Custom Swagger UI (unpkg.com CDN — works behind corporate proxy)
- [x] CORS configured for local dev
- [x] `start.sh` to launch both services
- [x] `.gitignore` covering __pycache__, .venv, node_modules, .next, .pkl, .db

---

## What's Left (TODOs)

> Cross-referenced against the problem setter's walkthrough (transcript). Items marked with `[PS]` were explicitly called out as must-have or good-to-have by the problem setter.

### Must-Have (from PS walkthrough) — not yet done

- [ ] **[PS] IEX API integration for live bid submission** — PS explicitly said the API signature should match IEX's actual endpoint so it works in a real scenario. Currently bids are stored locally; there is no outbound call to IEX for submission. Need to wire `POST /api/bids/submit` to hit the IEX submission endpoint (or clearly mock it with matching payload schema).
- [ ] **[PS] Two-step approval workflow** — PS said a *Trading Operator* fills and reviews the bid, a *Trading Manager* approves it before it goes to the exchange. Currently there is only one user role and no approval gate. Need: draft → operator-submit → manager-approve → exchange-submit state machine.
- [ ] **[PS] Contract compliance check (not just DSM)** — PS explicitly said there are *two* compliance layers: DSM regulation and bilateral contract terms (e.g. a 10-year PPA). The risk engine currently only checks DSM (CERC 2024 draft). Contract constraint validation (min/max volume, counterparty, duration) is missing.
- [ ] **[PS] Feedback / continuous learning loop** — PS said post-market outcomes (actual vs forecast) must feed back into the model as a continuous improvement cycle. Currently `GET /api/audit/post-market` computes the error metrics but nothing triggers a retrain or updates feature weights from this data.
- [ ] **[PS] Explainability output visible to the trader** — PS specifically asked for "explainable AI" so the trader understands *why* a forecast was made. `top_features` is returned by the model but the frontend does not display feature importance per block. Needs a visible breakdown in the forecast UI.

### Must-Have (from PS walkthrough) — already done ✅

- [x] **[PS] 96-block (15-min) price forecasting for DAM, RTM, TAM** — Done. All 3 segments trained. DAM 2.27% MAPE, RTM 3.14%, TAM 3.83%.
- [x] **[PS] Confidence intervals on forecasts** — Done. `model.predict()` returns 95% CI (`confidence_low`/`confidence_high`) + volatility per block; FE renders as AreaChart bands.
- [x] **[PS] DSM compliance enforcement** — Done. `POST /api/bids/validate` checks CERC price/volume limits; risk engine estimates penalty.
- [x] **[PS] Human override before submission** — Done. Bid workspace allows editing any block's price/volume with a required reason field before submission.
- [x] **[PS] Audit trail** — Done. Immutable action log captures create_bid, override, submit, approve with session grouping.
- [x] **[PS] Post-market performance analysis** — Done. Predicted vs actual comparison, MAPE/hit-rate/basket-rate metrics, penalty breakdown.
- [x] **[PS] Real IEX data** — Done. 40,620 rows scraped from IEX REST API (Oct 2025–Mar 2026).
- [x] **[PS] Daily scrape + auto-retrain scheduler** — Done. APScheduler cron at 01:10 IST, running on GCP VM.

### Good-to-Have (from PS walkthrough)

- [ ] **[PS] UPI/ONDC small-party participation** — PS mentioned enabling common individuals (e.g. rooftop solar farmers) via UPI or a beacon-based platform. Out of scope for core submission but noted as extension.
- [ ] **[PS] Multi-exchange support (PXIL, HPX)** — PS said data should come from IEX but acknowledged PXIL and HPX exist; DB has `exchange` column but only IEX is scraped.
- [ ] **[PS] Arbitrage detection across segments** — Flag blocks where DAM vs RTM or cross-exchange spreads create a profitable opportunity.
- [ ] **[PS] Real-time market monitoring post-submission** — After a bid is submitted, the system should poll IEX to track whether the bid was cleared, partially matched, or rejected. Currently there is no status-tracking loop.

### Not in PS Scope but Still Gaps

- [ ] **Weather API integration** — `temperature` column in DB always 0; plugging in IMD/OpenWeatherMap would meaningfully improve forecast accuracy (temperature is a key demand driver).
- [ ] **Unit & integration tests** — API route tests, constraint validation edge cases, model training reproducibility.
- [ ] **Authentication / RBAC** — Operator vs Manager role separation required for the two-step approval workflow above.
- [ ] **Dockerfile + docker-compose** — Currently requires manual venv + npm setup.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/forecast/train` | Train model (accepts `TrainRequest` JSON body with hyperparams, tuning, features config) |
| GET | `/api/forecast/predict` | 96-block price forecast (`?target_date=YYYY-MM-DD&segment=DAM`) |
| GET | `/api/bids/recommend` | AI bid recommendations (`?target_date&segment&strategy&demand_mw`) |
| POST | `/api/bids/submit` | Submit bid set with constraint validation |
| POST | `/api/bids/validate` | Validate bids without submitting |
| POST | `/api/risk/assess` | Calculate VaR + DSM penalties for a bid set (returns `X-Risk-Latency-Ms` header) |
| GET | `/api/risk/threshold` | Get current risk alert threshold |
| GET | `/api/forecast/latest` | Last cached forecast for a segment (stale-data fallback) |
| GET | `/api/forecast/export-csv` | Download forecast as CSV for manual exchange upload |
| GET | `/api/forecast/health` | Health check: DB status + latest data/forecast timestamps per segment |
| POST | `/api/audit/log` | Create audit log entry |
| GET | `/api/audit/log` | Query audit log (`?session_id&action`) |
| GET | `/api/audit/post-market` | Post-market analysis (`?target_date&segment`) |

### Example: Train with Hyperparameter Tuning

```bash
curl -X POST http://localhost:8000/api/forecast/train \
  -H "Content-Type: application/json" \
  -d '{
    "segment": "DAM",
    "tuning": {
      "method": "random",
      "n_iter": 40,
      "cv_folds": 5
    },
    "features": {
      "extra_lags": [2, 3, 14],
      "rolling_windows": [3, 7, 14],
      "include_demand_supply_ratio": true,
      "include_price_momentum": true,
      "include_ema": true,
      "ema_span": 5
    }
  }'
```

---

## Model Performance

| Segment | MAPE | sMAPE | RMSE | R² | Features | Best Params |
|---------|------|-------|------|----|----------|-------------|
| DAM | 2.27% | 2.22% | 0.16 | 0.9956 | 28 | max_iter=1200, depth=8, lr=0.1, l2=0.1 |
| RTM | 3.14%* | 6.23% | 0.22 | 0.9903 | 28 | max_iter=1200, depth=10, lr=0.1, l2=0.0 |
| TAM | 3.83% | 3.66% | 0.44 | 0.9656 | 28 | max_iter=800, depth=4, lr=0.05, l2=1.0 |

*RTM filtered MAPE (excludes near-zero MCP values that inflate standard MAPE)

---

## DSM Regulation Parameters (CERC 2024 Draft)

- Price floor: ₹0.0/kWh
- Price ceiling: ₹12.0/kWh
- Permissible deviation: ±10%
- Penalty multiplier: 1.5×
- Default VaR alert threshold: ₹5,00,000
