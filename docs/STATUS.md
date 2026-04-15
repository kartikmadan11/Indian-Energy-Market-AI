# Project Status — Last updated: 2026-04-11

## Completed

### Data Ingestion
- [x] IEX REST API scraper (`scrape_iex.py`) — DAM + RTM market snapshots
- [x] TAM scraper (`scrape_tam.py`) — DAC trade-details via RSC endpoint
- [x] 40,620 rows of real market data (Oct 2025 – Mar 2026) across 3 segments
- [x] Fields: date, block (1-96), segment, MCP, MCV, demand, supply, renewable gen, temperature
- [x] Weather enrichment pipeline (`scrape_weather.py`) — Open-Meteo temperature/wind/solar enrichment
- [x] `/api/scraper/enrich` + status polling endpoint

### Price Forecasting
- [x] HistGradientBoostingRegressor with 28+ engineered features (lags, EWM, rolling stats, weather, holidays, cyclic encodings)
- [x] Parameterised training API with hyperparameter override, CV search, configurable feature groups
- [x] DAM: 2.27% MAPE, R²=0.9956 | RTM: 3.14% MAPE, R²=0.9903 | TAM: 3.83% MAPE, R²=0.9656
- [x] 95% confidence intervals and per-block volatility
- [x] Model persistence with feature-name and importance tracking
- [x] **Explainability — "Top Price Drivers" bars** in both dashboard and workspace, merged inside the forecast chart card, with hover tooltips explaining each feature

### Bid Optimization
- [x] LP solver (PuLP/CBC) with λ₁ DSM compliance + λ₂ forecast uncertainty objectives
- [x] 3 strategy profiles: Conservative / Balanced / Aggressive — meaningful λ-weighted differences
- [x] Manual Optimizer Tuning panel (λ sliders) + Auto-tune endpoint
- [x] Strategy comparison endpoint (`/bids/compare-strategies`)
- [x] DSM constraint enforcement (CERC 2024 draft): price ₹0–12/kWh, volume ≥1 MW
- [x] Constraint validation endpoint — violations flagged visually before submit
- [x] Human override with reason code dropdown; overrides logged in audit trail
- [x] Mock IEX submission payload shown after submit

### Risk Assessment
- [x] Value-at-Risk @ 95% confidence (parametric, portfolio-level)
- [x] DSM penalty estimation: expected + worst-case stress scenario
- [x] Threshold alert (total exposure vs ₹5L limit, configurable)
- [x] Live/debounced risk updates in workspace (600ms debounce)
- [x] Exposure-vs-threshold progress bar in UI

### Policy Engine
- [x] YAML-backed CERC DSM regulation engine (`dsm_policy.py`)
- [x] CERC DSM 2019 + 2024 draft policies loaded
- [x] Policy activation API + compare endpoint
- [x] Policy management UI at `/policy`

### Audit Trail
- [x] Immutable action log with session grouping
- [x] Filtering by session/action type

### Scheduler
- [x] APScheduler: daily scrape + auto-retrain pipeline at 01:10 IST
- [x] Configurable via environment variables (`SCHEDULER_*`)

### Frontend UI
- [x] Dashboard (`/`) — market overview, segment charts, forecast + bid workflow
- [x] Bid Workspace (`/workspace`) — full 4-step flow: Forecast → Bids → Validate → Submit
- [x] Model Training page (`/forecast`) — training with hyperparams + backtest
- [x] Risk panel (`/risk`) — standalone VaR + DSM assessment
- [x] Post-Market Analysis (`/analysis`) — backend exists, UI renders
- [x] Policy management (`/policy`)
- [x] Data Sync Center (`/sync`) — minimal styling, per-segment sync controls
- [x] Sidebar navigation

---

## Known Bugs / Active Issues

| # | File | Description | Priority |
|---|------|-------------|----------|
| BUG-1 | `frontend/src/app/analysis/page.tsx` | Frontend expects `result.forecast_mape`, `result.bid_hit_rate` (fraction), `result.daily_comparison[]` etc. Backend `PostMarketSummary` returns `mape`, `bid_hit_rate` (%), `blocks[]`. Schema mismatch — page likely shows wrong data. | **CRITICAL** |
| BUG-2 | `backend/audit_service/router.py` | DSM penalty loop: `deviation = abs((v or 0) - (v or 0) * 0.95)` always = 5% regardless of actual demand. Should compare bid vs actual. | High |
| BUG-3 | `backend/risk_service/router.py` | `/risk/assess` ignores `var_threshold` param from frontend input; always uses `DEFAULT_VAR_THRESHOLD = 500000`. | Medium |
| BUG-4 | `backend/risk_service/engine.py:76` | `np.random.seed(42)` in `assess_risk()` — deterministic simulation, same inputs always produce same output. | Low |
| BUG-5 | `frontend/src/app/bids/page.tsx` | Dead redirect to `/forecast`. Remove from sidebar or repurpose. | Low |
| BUG-6 | `frontend/src/app/analysis/page.tsx` | `dateRange` (7/14/30d toggle) is rendered but never passed to API call. Always single-day. | Low |

---

## TODOs — Remaining

### Must-Have (PS gaps)
- [ ] **BUG-1: Fix post-market analysis** — align `analysis/page.tsx` to actual `PostMarketSummary` schema OR create `/audit/post-market-v2` with richer response (`daily_comparison`, `error_distribution`, `recommendations[]`)
- [ ] **BUG-3: Risk threshold passthrough** — wire frontend threshold input to `/risk/assess` `var_threshold` param
- [ ] **Two-step approval workflow** — draft → operator-submit → manager-approve → exchange-submit state machine; currently single-step

### Good-to-Have
- [ ] **Multi-exchange simulation** — PXIL + HPX synthetic data with different pricing profiles; fallback logic on exchange outage
- [ ] **Arbitrage detection panel** — flag blocks where DAM vs RTM or cross-exchange spread creates opportunity
- [ ] **Real-time alerts** — WebSocket/SSE for price spikes, DSM threshold warnings, gate-closure countdowns
- [ ] **Automated learning loop completion** — post-market actuals feed back into next training cycle (scheduler retrains but doesn't use outcome feedback)
- [ ] **CSV export + graceful degradation** — stale-data indicators with timestamps, manual CSV upload fallback for exchange outages

### Deliverables
- [ ] **3-minute demo video / live walkthrough script** — required PS deliverable; flow: forecast → override → risk → submit → post-market

### Other
- [ ] BUG-2, BUG-4, BUG-5, BUG-6 (see table above)
- [ ] Unit + integration tests
- [ ] Dockerfile / docker-compose for easier local setup
