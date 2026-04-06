import axios from "axios";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "/api",
  headers: { "Content-Type": "application/json" },
});

// ---- Forecast ----
export interface TrainConfig {
  segment: string;
  test_size?: number;
  shuffle?: boolean;
  hyperparams?: {
    max_iter?: number;
    max_depth?: number | null;
    learning_rate?: number;
    min_samples_leaf?: number;
    l2_regularization?: number;
    max_bins?: number;
    max_leaf_nodes?: number | null;
    early_stopping?: boolean;
    n_iter_no_change?: number;
    validation_fraction?: number;
  };
  tuning?: {
    method?: "grid" | "random";
    n_iter?: number;
    cv_folds?: number;
    scoring?: "neg_mean_absolute_percentage_error" | "neg_mean_squared_error" | "r2";
    param_grid?: Record<string, any> | null;
  } | null;
  features?: {
    extra_lags?: number[];
    rolling_windows?: number[];
    include_demand_supply_ratio?: boolean;
    include_price_momentum?: boolean;
    include_ema?: boolean;
    ema_span?: number;
  };
}

export async function trainModel(config: TrainConfig) {
  const res = await api.post("/forecast/train", config);
  return res.data;
}

export async function predictPrices(
  targetDate: string,
  segment: string,
  blockStart = 1,
  blockEnd = 96,
) {
  const res = await api.get("/forecast/predict", {
    params: { target_date: targetDate, segment, block_start: blockStart, block_end: blockEnd },
  });
  return res.data;
}

export async function predictPricesRange(
  dateFrom: string,
  dateTo: string,
  segment: string,
  blockStart = 1,
  blockEnd = 96,
) {
  const res = await api.get("/forecast/predict-range", {
    params: { date_from: dateFrom, date_to: dateTo, segment, block_start: blockStart, block_end: blockEnd },
  });
  return res.data;
}

// ---- Bids ----
export interface BidOptConfig {
  price_offset?: number | null;
  risk_tolerance?: number | null;
  volume_scale?: number | null;
  per_block_cap_factor?: number;
}

export async function recommendBids(
  targetDate: string,
  strategy: string,
  segment: string,
  demandMw: number = 500,
  overrides: BidOptConfig = {}
) {
  const res = await api.get("/bids/recommend", {
    params: {
      target_date: targetDate,
      strategy,
      segment,
      demand_mw: demandMw,
      ...(overrides.price_offset != null && { price_offset: overrides.price_offset }),
      ...(overrides.risk_tolerance != null && { risk_tolerance: overrides.risk_tolerance }),
      ...(overrides.volume_scale != null && { volume_scale: overrides.volume_scale }),
      ...(overrides.per_block_cap_factor != null && { per_block_cap_factor: overrides.per_block_cap_factor }),
    },
  });
  return res.data;
}

export async function submitBids(
  targetDate: string,
  strategy: string,
  segment: string,
  bids: any[]
) {
  const res = await api.post("/bids/submit", bids, {
    params: { target_date: targetDate, strategy, segment },
  });
  return res.data;
}

export async function validateBids(
  targetDate: string,
  strategy: string,
  segment: string,
  bids: any[]
) {
  const res = await api.post("/bids/validate", bids, {
    params: { target_date: targetDate, strategy, segment },
  });
  return res.data;
}

// ---- Risk ----
export async function assessRisk(
  sessionId: string,
  segment: string,
  bids: any[]
) {
  const res = await api.post("/risk/assess", bids, {
    params: { session_id: sessionId, segment },
  });
  return res.data;
}

// ---- Audit ----
export async function getAuditLog(sessionId?: string, limit: number = 100) {
  const params: any = { limit };
  if (sessionId) params.session_id = sessionId;
  const res = await api.get("/audit/log", { params });
  return res.data;
}

export async function postMarketAnalysis(
  targetDate: string,
  segment: string,
  sessionId?: string
) {
  const params: any = { target_date: targetDate, segment };
  if (sessionId) params.session_id = sessionId;
  const res = await api.get("/audit/post-market", { params });
  return res.data;
}

// ---- Health / Fallback ----
export async function getHealth() {
  const res = await api.get("/forecast/health");
  return res.data;
}

export async function getLatestForecast(segment: string) {
  const res = await api.get("/forecast/latest", { params: { segment } });
  return res.data;
}

export async function getHistory(segment: string, days: number = 7) {
  const res = await api.get("/forecast/history", { params: { segment, days } });
  return res.data as { date: string; block: number; mcp: number }[];
}

export async function exportForecastCsv(segment: string) {
  const res = await api.get("/forecast/export-csv", {
    params: { segment },
    responseType: "blob",
  });
  return res.data;
}

export async function triggerScrape(
  segment: string,
  days: number = 3,
  startDate?: string,
  endDate?: string
) {
  const params: Record<string, string | number> = { segment, days };
  if (startDate) params.start_date = startDate;
  if (endDate) params.end_date = endDate;
  const res = await api.post("/scraper/trigger", null, { params });
  return res.data as {
    status: string;
    segment: string;
    start_date: string;
    end_date: string;
    scraped: number;
    inserted: number;
    dates_with_data: string[];
    errors: string[];
  };
}

export async function triggerScrapeAll(days: number = 3) {
  const res = await api.post("/scraper/trigger-all", null, { params: { days } });
  return res.data as {
    start_date: string;
    end_date: string;
    segments: Record<
      string,
      { status: string; scraped: number; inserted: number; dates_with_data: string[]; errors: string[] }
    >;
  };
}

export async function getScrapeStatus() {
  const res = await api.get("/scraper/status");
  return res.data as {
    segments: Record<
      string,
      { latest_date: string | null; earliest_date: string | null; row_count: number }
    >;
  };
}

export default api;
