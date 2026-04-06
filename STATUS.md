# Project Status

## Completed

### Data Ingestion
- [x] IEX REST API scraper (`scrape_iex.py`) — DAM + RTM market snapshots
- [x] TAM scraper (`scrape_tam.py`) — DAC trade-details via RSC endpoint
- [x] 40,620 rows of real market data (Oct 2025 – Mar 2026) across 3 segments
- [x] Fields: date, block (1-96), segment, MCP, MCV, demand, supply, renewable gen, temperature

### Price Forecasting
- [x] HistGradientBoostingRegressor with 28 engineered features
- [x] Parameterised training API with hyperparameter override, CV search, configurable features
- [x] DAM: 2.27% MAPE, R²=0.9956 | RTM: 3.14% MAPE, R²=0.9903 | TAM: 3.83% MAPE, R²=0.9656
- [x] 95% confidence intervals and per-block volatility
- [x] Model persistence with feature-name tracking

### Bid Optimization
- [x] 3 strategy profiles: conservative, balanced, aggressive
- [x] Inverse price-weighted volume allocation across 96 blocks
- [x] DSM constraint enforcement (CERC 2024 draft): price ₹0–12/kWh, volume ≥1 MW
- [x] Constraint validation endpoint

### Risk Assessment
- [x] Value-at-Risk @ 95% confidence (parametric)
- [x] DSM penalty estimation: expected + worst-case
- [x] Alert triggering when VaR exceeds threshold

### Post-Market Analysis
- [x] Predicted vs actual price comparison per block
- [x] MAPE, bid hit rate, basket rate, DSM penalty breakdown

### Audit Trail
- [x] Immutable action log with session grouping
- [x] Filtering by session/action

### Frontend
- [x] Dashboard, forecast visualisation, bid workspace, risk panel, post-market analysis
- [x] Human override with reason field before bid submission

### Infrastructure
- [x] FastAPI gateway with 4 microservice routers
- [x] SQLite + async SQLAlchemy
- [x] Daily scrape + auto-retrain scheduler (APScheduler)
- [x] `start.sh` launcher

---

## TODOs

### Must-Have

- [ ] **IEX API integration for live bid submission** — Wire `POST /bids/submit` to IEX submission endpoint (or mock with matching payload schema)
- [ ] **Two-step approval workflow** — draft → operator-submit → manager-approve → exchange-submit state machine
- [ ] **Contract compliance check** — Bilateral contract terms (PPA min/max volume, counterparty, duration) alongside DSM
- [ ] **Feedback / continuous learning loop** — Post-market actuals auto-trigger retrain or update feature weights
- [ ] **Explainability in UI** — Display per-block feature importance breakdown in forecast page

### Good-to-Have

- [ ] Multi-exchange support (PXIL, HPX)
- [ ] Arbitrage detection across segments
- [ ] Real-time post-submission market monitoring
- [ ] UPI/ONDC small-party participation

### Other Gaps

- [ ] Weather API integration (temperature column currently unused)
- [ ] Unit & integration tests
- [ ] Authentication / RBAC
- [ ] Dockerfile + docker-compose
