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

### High Priority — PS Gaps (Must-Have)

- [x] ~~**Confidence intervals on forecasts**~~ — Already implemented: `model.predict()` returns 95% CI (`confidence_low`/`confidence_high`) + volatility per block; FE renders CI bands in AreaChart
- [x] ~~**Data outage graceful degradation**~~ — Done! `GET /forecast/latest` returns cached predictions, `GET /forecast/export-csv` for manual upload, FE shows yellow offline banner with stale timestamp, CSV download button
- [x] ~~**Risk alert latency (<2s)**~~ — Done! Measured 1.8ms server-side (via `X-Risk-Latency-Ms` header). Async DB persist via BackgroundTasks. FE: auto-re-assess on bid edits (600ms debounce) with live risk panel in Bid Workspace

### High Priority — Strengthens the Submission

- [ ] **Unit & integration tests** — API route tests (forecast, bids, risk), model training tests, constraint validation edge cases
- [ ] **PuLP-based bid optimization** — Replace heuristic weighting with LP/MILP formulation (PuLP already in requirements.txt, just not wired)
- [x] ~~**TAM segment**~~ — Done! 5,868 rows scraped via RSC, 3.83% MAPE model trained
- [ ] **Weather API integration** — `temperature` column exists but always 0; plug in OpenWeatherMap or IMD for real temperature data to improve forecast accuracy

### Medium Priority — PS Good-to-Have

- [ ] **Multi-exchange data** — DB has `exchange` column (IEX/PXIL/HPX) but only IEX is scraped; PS wants fallback logic for exchange outages
- [ ] **Arbitrage detection** — PS good-to-have: flag blocks where DAM vs RTM or cross-exchange price spreads create profitable opportunities
- [ ] **Automated learning loop** — Feed post-market outcomes back into the forecasting model (even mock counts per PS)
- [ ] **Two-step approval workflow** — Route high-value bids to Trading Manager for approval; include draft versioning
- [ ] **Real-time alerts** — Push notifications for price spikes, DSM deviation thresholds, submission deadlines
- [ ] **Scheduled data refresh** — Cron/APScheduler for daily scraping + auto-retraining

### Lower Priority — Production Readiness

- [ ] **Authentication / RBAC** — Currently single-user (`user="trader"`); add JWT or session-based auth
- [ ] **Dockerfile + docker-compose** — Containerized deployment
- [ ] **CI/CD pipeline** — GitHub Actions for lint + test + build
- [ ] **Renewable generation forecast model** — Dedicated solar/wind generation predictor

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
