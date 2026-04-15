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
  max_days?: number | null;
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
    scoring?:
      | "neg_mean_absolute_percentage_error"
      | "neg_mean_squared_error"
      | "r2";
    param_grid?: Record<string, any> | null;
  } | null;
  features?: {
    extra_lags?: number[];
    rolling_windows?: number[];
    include_demand_supply_ratio?: boolean;
    include_price_momentum?: boolean;
    include_ema?: boolean;
    ema_span?: number;
    include_weather?: boolean;
    include_holidays?: boolean;
    include_month_cyclic?: boolean;
    include_price_range?: boolean;
    include_summer_signal?: boolean;
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
    params: {
      target_date: targetDate,
      segment,
      block_start: blockStart,
      block_end: blockEnd,
    },
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
    params: {
      date_from: dateFrom,
      date_to: dateTo,
      segment,
      block_start: blockStart,
      block_end: blockEnd,
    },
  });
  return res.data;
}

// ---- Bids ----
export interface BidOptConfig {
  price_offset?: number | null;
  risk_tolerance?: number | null;
  volume_scale?: number | null;
  per_block_cap_factor?: number;
  lambda1_base?: number | null;
  lambda2_base?: number | null;
}

export async function recommendBids(
  targetDate: string,
  strategy: string,
  segment: string,
  demandMw: number = 500,
  overrides: BidOptConfig = {},
) {
  const res = await api.get("/bids/recommend", {
    params: {
      target_date: targetDate,
      strategy,
      segment,
      demand_mw: demandMw,
      ...(overrides.price_offset != null && {
        price_offset: overrides.price_offset,
      }),
      ...(overrides.risk_tolerance != null && {
        risk_tolerance: overrides.risk_tolerance,
      }),
      ...(overrides.volume_scale != null && {
        volume_scale: overrides.volume_scale,
      }),
      ...(overrides.per_block_cap_factor != null && {
        per_block_cap_factor: overrides.per_block_cap_factor,
      }),
      ...(overrides.lambda1_base != null && {
        lambda1_base: overrides.lambda1_base,
      }),
      ...(overrides.lambda2_base != null && {
        lambda2_base: overrides.lambda2_base,
      }),
    },
  });
  return res.data;
}

export async function submitBids(
  targetDate: string,
  strategy: string,
  segment: string,
  bids: any[],
) {
  const res = await api.post("/bids/submit", bids, {
    params: { target_date: targetDate, strategy, segment },
  });
  return res.data;
}

export async function autoTuneLambdas(
  targetDate: string,
  strategy: string,
  segment: string,
  demandMw: number = 500,
) {
  const res = await api.get("/bids/tune", {
    params: { target_date: targetDate, strategy, segment, demand_mw: demandMw },
  });
  return res.data as {
    best_lambda1_base: number;
    best_lambda2_base: number;
    best_score: number;
    dsm_multiplier: number;
    grid: {
      lambda1_base: number;
      lambda2_base: number;
      total_bid_value: number;
      total_dsm_penalty: number;
      score: number;
    }[];
  };
}

export async function compareStrategies(
  targetDate: string,
  segment: string,
  demandMw: number = 500,
) {
  const res = await api.get("/bids/compare-strategies", {
    params: { target_date: targetDate, segment, demand_mw: demandMw },
  });
  return res.data;
}

export async function validateBids(
  targetDate: string,
  strategy: string,
  segment: string,
  bids: any[],
) {
  const res = await api.post("/bids/validate", bids, {
    params: { target_date: targetDate, strategy, segment },
  });
  return res.data;
}

// ---- Approval ----
export interface ApprovalCheck {
  name: string;
  category: "hard" | "soft";
  status: "pass" | "warn" | "fail";
  message: string;
  affected_blocks: number[];
}

export interface ApprovalResult {
  session_id: string;
  target_date: string;
  segment: string;
  strategy: string;
  verdict: "APPROVED" | "APPROVED_WITH_FLAGS" | "NEEDS_REVISION" | "REJECTED";
  score: number;
  checks: ApprovalCheck[];
  summary: string;
  can_submit: boolean;
}

export async function requestApproval(
  sessionId: string,
  targetDate: string,
  segment: string,
  strategy: string,
  bids: any[],
): Promise<ApprovalResult> {
  const res = await api.post("/bids/request-approval", bids, {
    params: {
      session_id: sessionId,
      target_date: targetDate,
      segment,
      strategy,
    },
  });
  return res.data;
}

// ---- Risk ----
export async function assessRisk(
  sessionId: string,
  segment: string,
  bids: any[],
  varThreshold?: number,
) {
  const params: Record<string, unknown> = { session_id: sessionId, segment };
  if (varThreshold !== undefined) params.var_threshold = varThreshold;
  const res = await api.post("/risk/assess", bids, { params });
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
  sessionId?: string,
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

export async function getDataCoverage(segment: string) {
  const res = await api.get("/forecast/data-coverage", { params: { segment } });
  return res.data as { segment: string; dates: string[] };
}

export async function evaluateForecast(
  startDate: string,
  endDate: string,
  segment: string,
) {
  const res = await api.get("/forecast/evaluate", {
    params: { start_date: startDate, end_date: endDate, segment },
  });
  return res.data;
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
  endDate?: string,
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
  const res = await api.post("/scraper/trigger-all", null, {
    params: { days },
  });
  return res.data as {
    start_date: string;
    end_date: string;
    segments: Record<
      string,
      {
        status: string;
        scraped: number;
        inserted: number;
        dates_with_data: string[];
        errors: string[];
      }
    >;
  };
}

// ---- DSM Policy ----
export interface DSMPolicy {
  regulation_id: string;
  name: string;
  description: string;
  effective_date: string;
  status: string;
  price_floor: number;
  price_ceiling: number;
  deviation_band: number;
  penalty_rate: number;
  severe_deviation_threshold: number;
  severe_penalty_multiplier: number;
  technical_minimum_mw: number;

  is_active?: boolean;
}

export interface PolicyDiff {
  field: string;
  policy_a_value: number;
  policy_b_value: number;
  pct_change: number | null;
  direction: string;
}

export interface PolicyComparison {
  policy_a: DSMPolicy;
  policy_b: DSMPolicy;
  diffs: PolicyDiff[];
  summary: string;
}

export async function listPolicies(): Promise<DSMPolicy[]> {
  const res = await api.get("/policy/list");
  return res.data;
}

export async function getActivePolicy(): Promise<DSMPolicy> {
  const res = await api.get("/policy/active");
  return res.data;
}

export async function activatePolicy(
  regulationId: string,
): Promise<{ message: string; policy: DSMPolicy }> {
  const res = await api.post(`/policy/activate/${regulationId}`);
  return res.data;
}

export async function comparePolicies(
  policyA: string,
  policyB: string,
): Promise<PolicyComparison> {
  const res = await api.get("/policy/compare", {
    params: { policy_a: policyA, policy_b: policyB },
  });
  return res.data;
}

export async function updatePolicy(
  regulationId: string,
  updates: Partial<Omit<DSMPolicy, "regulation_id" | "is_active">>,
): Promise<{ message: string; policy: DSMPolicy }> {
  const res = await api.put(`/policy/${regulationId}`, updates);
  return res.data;
}

export async function getScrapeStatus() {
  const res = await api.get("/scraper/status");
  return res.data as {
    segments: Record<
      string,
      {
        latest_date: string | null;
        earliest_date: string | null;
        row_count: number;
      }
    >;
  };
}

// ---- Enrichment (weather + holidays) ----
export async function getEnrichStatus() {
  const res = await api.get("/scraper/enrich/status");
  return res.data as {
    unenriched_rows: number;
    date_range: { earliest: string | null; latest: string | null } | null;
    note: string;
  };
}

export async function triggerEnrich(params?: {
  start_date?: string;
  end_date?: string;
  overwrite?: boolean;
}) {
  const res = await api.post("/scraper/enrich", null, { params });
  return res.data as {
    status: string;
    start_date: string;
    end_date: string;
    weather: { updated: number; skipped: number; errors: number };
  };
}

// ---- Beckn Protocol / UEI ----

export interface BecknExchangeQuote {
  exchange_id: string;
  exchange_name: string;
  transaction_id: string;
  segment: string;
  target_date: string;
  block_start: number;
  block_end: number;
  items: {
    block: number;
    time: string;
    price_inr_kwh: number;
    volume_mw: number;
    confidence_low: number;
    confidence_high: number;
  }[];
  avg_price: number;
  total_volume_mw: number;
  total_value_inr: number;
}

export interface BecknSearchResponse {
  transaction_id: string;
  providers: BecknExchangeQuote[];
  search_params: {
    segment: string;
    target_date: string;
    block_start: number;
    block_end: number;
    demand_mw: number;
  };
}

export interface BecknOrder {
  order_id: string;
  transaction_id: string;
  status: "draft" | "confirmed";
  exchange_id: string;
  segment: string;
  target_date: string;
  block_start: number;
  block_end: number;
  demand_mw: number;
  items: BecknExchangeQuote["items"];
  total_volume_mw: number;
  total_value_inr: number;
  avg_price: number;
  created_at: string;
  confirmed_at: string | null;
  billing_entity: string;
}

export async function becknSearch(
  segment: string,
  targetDate: string,
  blockStart = 1,
  blockEnd = 96,
  demandMw = 500,
): Promise<BecknSearchResponse> {
  const res = await api.post("/beckn/search", {
    segment,
    target_date: targetDate,
    block_start: blockStart,
    block_end: blockEnd,
    demand_mw: demandMw,
  });
  return res.data;
}

export async function becknSelect(
  transactionId: string,
  exchangeId: string,
  segment: string,
  targetDate: string,
  blockStart: number,
  blockEnd: number,
  demandMw: number,
) {
  const res = await api.post("/beckn/select", {
    transaction_id: transactionId,
    exchange_id: exchangeId,
    segment,
    target_date: targetDate,
    block_start: blockStart,
    block_end: blockEnd,
    demand_mw: demandMw,
  });
  return res.data as { transaction_id: string; quote: BecknExchangeQuote; beckn_quote: Record<string, unknown> };
}

export async function becknInit(
  transactionId: string,
  exchangeId: string,
  segment: string,
  targetDate: string,
  blockStart: number,
  blockEnd: number,
  demandMw: number,
  billingEntity = "DISCOM-Default",
) {
  const res = await api.post("/beckn/init", {
    transaction_id: transactionId,
    exchange_id: exchangeId,
    segment,
    target_date: targetDate,
    block_start: blockStart,
    block_end: blockEnd,
    demand_mw: demandMw,
    billing_entity: billingEntity,
  });
  return res.data as {
    transaction_id: string;
    order_id: string;
    status: string;
    exchange_id: string;
    items: BecknExchangeQuote["items"];
    total_volume_mw: number;
    total_value_inr: number;
    fulfillment: Record<string, unknown>;
  };
}

export async function becknConfirm(orderId: string, transactionId: string) {
  const res = await api.post("/beckn/confirm", {
    order_id: orderId,
    transaction_id: transactionId,
  });
  return res.data as {
    order_id: string;
    status: string;
    message: string;
    exchange_id: string;
    segment: string;
    target_date: string;
  };
}

export async function becknListOrders(): Promise<{ orders: BecknOrder[]; total: number }> {
  const res = await api.get("/beckn/orders");
  return res.data;
}

export async function becknListExchanges() {
  const res = await api.get("/beckn/exchanges");
  return res.data as {
    exchanges: {
      id: string;
      name: string;
      price_premium_pct: number;
      bpp_uri: string;
      description: string;
    }[];
  };
}

export default api;
