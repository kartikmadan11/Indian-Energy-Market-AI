import axios from "axios";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "/api",
  headers: { "Content-Type": "application/json" },
});

// ---- Forecast ----
export async function trainModel(segment: string) {
  const res = await api.post(`/forecast/train?segment=${segment}`);
  return res.data;
}

export async function predictPrices(targetDate: string, segment: string) {
  const res = await api.get("/forecast/predict", {
    params: { target_date: targetDate, segment },
  });
  return res.data;
}

// ---- Bids ----
export async function recommendBids(
  targetDate: string,
  strategy: string,
  segment: string,
  demandMw: number = 500
) {
  const res = await api.get("/bids/recommend", {
    params: {
      target_date: targetDate,
      strategy,
      segment,
      demand_mw: demandMw,
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

export async function exportForecastCsv(segment: string) {
  const res = await api.get("/forecast/export-csv", {
    params: { segment },
    responseType: "blob",
  });
  return res.data;
}

export default api;
