"use client";

import { useState, useEffect, useRef } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from "recharts";
import {
  predictPrices,
  recommendBids,
  submitBids,
  validateBids,
  assessRisk,
} from "@/lib/api";
import {
  blockToTime,
  SEGMENTS,
  STRATEGIES,
  getTomorrowDate,
  formatINR,
} from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

interface ForecastBlock {
  block: number;
  predicted_price: number;
  confidence_low: number;
  confidence_high: number;
  volatility: number;
  top_features: { feature: string; importance: number }[];
}

interface BidRow {
  block: number;
  segment: string;
  price: number;
  volume_mw: number;
  predicted_price: number;
  confidence_low: number;
  confidence_high: number;
  dsm_penalty_estimate: number;
  uncertainty_score: number;
  strategy: string;
  is_overridden: boolean;
  override_reason: string;
  constraint_violations: { message: string }[];
}

type Stage =
  | "idle"
  | "forecasting"
  | "forecasted"
  | "loading_bids"
  | "ready"
  | "validating"
  | "validated"
  | "submitting"
  | "submitted";

// ── Constants ────────────────────────────────────────────────────────────────

const STRATEGY_META = {
  conservative: {
    label: "Conservative",
    color: "#22c55e",
    activeClass: "bg-green-700 text-white border-green-600",
    hint: "High λ · DSM-safe · spread volume",
  },
  balanced: {
    label: "Balanced",
    color: "#006DAE",
    activeClass: "bg-[#006DAE] text-white border-[#005A91]",
    hint: "Medium λ · balanced risk/value",
  },
  aggressive: {
    label: "Aggressive",
    color: "#ef4444",
    activeClass: "bg-red-700 text-white border-red-600",
    hint: "Low λ · max value · accepts DSM risk",
  },
} as const;

const WORKFLOW_STEPS = [
  { idx: 0, label: "Forecast" },
  { idx: 1, label: "Bids" },
  { idx: 2, label: "Validated" },
  { idx: 3, label: "Submitted" },
];

const OVERRIDE_REASONS = [
  "Market intelligence",
  "Demand forecast adjustment",
  "Risk mitigation",
  "Regulatory requirement",
  "Manager directive",
  "Other",
];

function stageToStep(s: Stage): number {
  if (s === "idle" || s === "forecasting") return -1;
  if (s === "forecasted" || s === "loading_bids") return 0;
  if (s === "ready") return 1;
  if (s === "validating" || s === "validated") return 2;
  if (s === "submitting" || s === "submitted") return 3;
  return -1;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function WorkflowStepper({ stage }: { stage: Stage }) {
  const activeStep = stageToStep(stage);
  return (
    <div className="flex items-center gap-0">
      {WORKFLOW_STEPS.map((step, i) => {
        const done = activeStep > step.idx;
        const active = activeStep === step.idx;
        const spinning =
          (step.idx === 0 && stage === "forecasting") ||
          (step.idx === 1 && stage === "loading_bids") ||
          (step.idx === 2 && stage === "validating") ||
          (step.idx === 3 && stage === "submitting");
        return (
          <div key={step.idx} className="flex items-center">
            <div className="flex items-center gap-1.5">
              <div
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${
                  done
                    ? "bg-[#00B398] text-white"
                    : active
                      ? "bg-[#006DAE] text-white"
                      : "bg-[#1A3558] text-gray-500"
                }`}
              >
                {spinning ? (
                  <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                ) : done ? (
                  "✓"
                ) : (
                  step.idx + 1
                )}
              </div>
              <span
                className={`text-[10px] font-medium ${
                  done ? "text-[#00B398]" : active ? "text-white" : "text-gray-600"
                }`}
              >
                {step.label}
              </span>
            </div>
            {i < WORKFLOW_STEPS.length - 1 && (
              <div
                className={`w-8 h-px mx-1 ${done ? "bg-[#00B398]" : "bg-[#1A3558]"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function RiskMetric({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color: string;
  sub?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</span>
      <span className="text-base font-bold" style={{ color }}>
        {value}
      </span>
      {sub && <span className="text-[10px] text-gray-600">{sub}</span>}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function WorkspacePage() {
  // Controls
  const [segment, setSegment] = useState<string>("DAM");
  const [strategy, setStrategy] = useState<(typeof STRATEGIES)[number]>("balanced");
  const [targetDate, setTargetDate] = useState(getTomorrowDate());
  const [demandMw, setDemandMw] = useState(500);

  // Data
  const [forecastBlocks, setForecastBlocks] = useState<ForecastBlock[]>([]);
  const forecastRef = useRef<ForecastBlock[]>([]);
  const [bidRows, setBidRows] = useState<BidRow[]>([]);
  const [liveRisk, setLiveRisk] = useState<any>(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const riskDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Workflow
  const [stage, setStage] = useState<Stage>("idle");
  const [submitResult, setSubmitResult] = useState<any>(null);
  const [validationResult, setValidationResult] = useState<any>(null);
  const [error, setError] = useState("");

  // UI
  const [chartOpen, setChartOpen] = useState(true);
  const [editingReasonBlock, setEditingReasonBlock] = useState<number | null>(null);

  // ── Live risk debounce ──────────────────────────────────────────────────
  useEffect(() => {
    if (bidRows.length === 0) {
      setLiveRisk(null);
      return;
    }
    if (riskDebounceRef.current) clearTimeout(riskDebounceRef.current);
    riskDebounceRef.current = setTimeout(async () => {
      setRiskLoading(true);
      try {
        const result = await assessRisk(
          `ws-${Date.now()}`,
          segment,
          bidRows.map((b) => ({
            block: b.block,
            segment: b.segment,
            price: b.price,
            volume_mw: b.volume_mw,
          }))
        );
        setLiveRisk(result);
      } catch {
        /* silent */
      }
      setRiskLoading(false);
    }, 600);
    return () => {
      if (riskDebounceRef.current) clearTimeout(riskDebounceRef.current);
    };
  }, [bidRows, segment]);

  // ── Actions ─────────────────────────────────────────────────────────────

  const handleForecast = async () => {
    setStage("forecasting");
    setError("");
    setBidRows([]);
    setLiveRisk(null);
    setSubmitResult(null);
    setValidationResult(null);
    try {
      const data = await predictPrices(targetDate, segment);
      forecastRef.current = data.blocks;
      setForecastBlocks(data.blocks);
      setStage("forecasted");
    } catch (e: any) {
      setError(e.response?.data?.detail || "Forecast failed. Check backend.");
      setStage("idle");
    }
  };

  const handleGetBids = async () => {
    if (forecastRef.current.length === 0) {
      setError("Run forecast first.");
      return;
    }
    setStage("loading_bids");
    setError("");
    setSubmitResult(null);
    setValidationResult(null);
    try {
      const recs = await recommendBids(targetDate, strategy, segment, demandMw);
      const merged: BidRow[] = recs.map((r: any) => {
        const fc = forecastRef.current.find((f) => f.block === r.block);
        return {
          ...r,
          predicted_price: fc?.predicted_price ?? r.price,
          confidence_low: fc?.confidence_low ?? r.price,
          confidence_high: fc?.confidence_high ?? r.price,
          dsm_penalty_estimate: r.dsm_penalty_estimate ?? 0,
          uncertainty_score: r.uncertainty_score ?? 0,
          is_overridden: false,
          override_reason: "",
        };
      });
      setBidRows(merged);
      setStage("ready");
    } catch (e: any) {
      setError(e.response?.data?.detail || "Failed to get recommendations.");
      setStage("forecasted");
    }
  };

  const handleCellEdit = (
    block: number,
    field: "price" | "volume_mw",
    value: string
  ) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    setBidRows((prev) =>
      prev.map((b) =>
        b.block === block ? { ...b, [field]: num, is_overridden: true } : b
      )
    );
  };

  const handleValidate = async () => {
    setStage("validating");
    try {
      const result = await validateBids(
        targetDate,
        strategy,
        segment,
        bidRows.map((b) => ({
          block: b.block,
          segment: b.segment,
          price: b.price,
          volume_mw: b.volume_mw,
          is_overridden: b.is_overridden,
          override_reason: b.override_reason || undefined,
        }))
      );
      setValidationResult(result);
      setStage("validated");
    } catch {
      setStage("ready");
    }
  };

  const handleSubmit = async () => {
    setStage("submitting");
    try {
      const result = await submitBids(
        targetDate,
        strategy,
        segment,
        bidRows.map((b) => ({
          block: b.block,
          segment: b.segment,
          price: b.price,
          volume_mw: b.volume_mw,
          is_overridden: b.is_overridden,
          override_reason: b.override_reason || undefined,
        }))
      );
      setSubmitResult(result);
      setStage("submitted");
    } catch (e: any) {
      setError(e.response?.data?.detail || "Submission failed.");
      setStage("validated");
    }
  };

  // ── Derived metrics ──────────────────────────────────────────────────────

  const chartData = forecastBlocks.map((b) => ({
    block: b.block,
    price: b.predicted_price,
    low: b.confidence_low,
    high: b.confidence_high,
  }));

  const totalVol = bidRows.reduce((s, b) => s + b.volume_mw, 0);
  const avgBidPrice =
    bidRows.length > 0
      ? bidRows.reduce((s, b) => s + b.price, 0) / bidRows.length
      : 0;
  const totalDsmEst = bidRows.reduce((s, b) => s + b.dsm_penalty_estimate, 0);
  const overrideCount = bidRows.filter((b) => b.is_overridden).length;
  const violationCount = bidRows.reduce(
    (s, b) => s + (b.constraint_violations?.length ?? 0),
    0
  );
  const avgForecastPrice =
    forecastBlocks.length > 0
      ? forecastBlocks.reduce((s, b) => s + b.predicted_price, 0) /
        forecastBlocks.length
      : 0;

  const stratMeta = STRATEGY_META[strategy];

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="max-w-[1400px] mx-auto flex flex-col gap-4">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3 card py-3">
        {/* Date */}
        <div>
          <label className="block text-[10px] text-gray-500 mb-1 uppercase tracking-wider">Date</label>
          <input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            className="input-field text-sm py-1.5"
          />
        </div>

        {/* Segment */}
        <div>
          <label className="block text-[10px] text-gray-500 mb-1 uppercase tracking-wider">Segment</label>
          <div className="flex rounded-md overflow-hidden border border-[var(--border)]">
            {SEGMENTS.map((s) => (
              <button
                key={s}
                onClick={() => setSegment(s)}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                  segment === s
                    ? "bg-[#006DAE] text-white"
                    : "bg-[#0C1A2E] text-gray-400 hover:text-gray-200"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Strategy */}
        <div>
          <label className="block text-[10px] text-gray-500 mb-1 uppercase tracking-wider">
            Strategy
          </label>
          <div className="flex rounded-md overflow-hidden border border-[var(--border)]">
            {STRATEGIES.map((s) => (
              <button
                key={s}
                onClick={() => setStrategy(s)}
                className={`px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
                  strategy === s
                    ? STRATEGY_META[s].activeClass
                    : "bg-[#0C1A2E] text-gray-400 hover:text-gray-200"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Demand */}
        <div>
          <label className="block text-[10px] text-gray-500 mb-1 uppercase tracking-wider">
            Demand (MW)
          </label>
          <input
            type="number"
            value={demandMw}
            onChange={(e) => setDemandMw(Number(e.target.value))}
            className="input-field text-sm py-1.5 w-24"
          />
        </div>

        {/* Divider */}
        <div className="h-8 w-px bg-[var(--border)] mx-1 hidden sm:block" />

        {/* Action buttons */}
        <button
          onClick={handleForecast}
          disabled={stage === "forecasting"}
          className="btn-primary text-xs py-1.5 px-4"
        >
          {stage === "forecasting" ? "Forecasting…" : "1 · Forecast"}
        </button>
        <button
          onClick={handleGetBids}
          disabled={forecastBlocks.length === 0 || stage === "loading_bids"}
          className="btn-secondary text-xs py-1.5 px-4 disabled:opacity-40"
        >
          {stage === "loading_bids" ? "Loading…" : "2 · Get Bids"}
        </button>
        <button
          onClick={handleValidate}
          disabled={bidRows.length === 0 || stage === "validating"}
          className="btn-secondary text-xs py-1.5 px-4 disabled:opacity-40"
        >
          3 · Validate
        </button>
        <button
          onClick={handleSubmit}
          disabled={bidRows.length === 0 || stage === "submitting" || stage === "submitted"}
          className="btn-teal text-xs py-1.5 px-4 disabled:opacity-40"
        >
          {stage === "submitting" ? "Submitting…" : "4 · Submit"}
        </button>

        {/* Stepper — right-aligned */}
        <div className="ml-auto hidden lg:flex">
          <WorkflowStepper stage={stage} />
        </div>
      </div>

      {/* ── Status banners ────────────────────────────────────────────── */}
      {error && (
        <div className="card py-2 bg-red-900/20 border-red-700/40 flex items-center gap-2">
          <span className="text-red-400 text-xs">{error}</span>
          <button onClick={() => setError("")} className="ml-auto text-gray-500 hover:text-white text-xs">✕</button>
        </div>
      )}
      {validationResult && (
        <div
          className={`card py-2 flex items-center gap-2 ${
            validationResult.valid
              ? "bg-[#00B398]/10 border-[#00B398]/30"
              : "bg-red-900/20 border-red-700/40"
          }`}
        >
          <span
            className={`text-xs font-medium ${
              validationResult.valid ? "text-[#00B398]" : "text-red-400"
            }`}
          >
            {validationResult.valid
              ? "✓ All constraints passed — ready to submit"
              : `⚠ ${validationResult.violation_count} constraint violation(s) — review highlighted rows`}
          </span>
        </div>
      )}
      {submitResult && (
        <div className="card py-2 bg-[#00B398]/10 border-[#00B398]/30 flex items-center gap-3">
          <span className="text-[#00B398] text-xs font-medium">
            ✓ Submitted — Session {submitResult.session_id} · {submitResult.bid_count} bids · {submitResult.violations?.length ?? 0} violations
          </span>
        </div>
      )}

      {/* ── Main area: left grid + right risk panel ────────────────────── */}
      <div className="flex gap-4 items-start">
        {/* ── Left ── */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          {/* Forecast chart (collapsible) */}
          {forecastBlocks.length > 0 && (
            <div className="card">
              <div
                className="flex items-center justify-between cursor-pointer select-none"
                onClick={() => setChartOpen((o) => !o)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-gray-300">
                    Price Forecast — {segment} — {targetDate}
                  </span>
                  <span className="text-[10px] text-gray-500">
                    avg ₹{avgForecastPrice.toFixed(3)}/kWh
                  </span>
                </div>
                <span className="text-gray-500 text-xs">{chartOpen ? "▲ collapse" : "▼ expand"}</span>
              </div>

              {chartOpen && (
                <div className="h-36 mt-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="confGradWS" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#006DAE" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#006DAE" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1A3558" vertical={false} />
                      <XAxis
                        dataKey="block"
                        stroke="#374151"
                        fontSize={9}
                        interval={11}
                        tickFormatter={(b) => blockToTime(b)}
                      />
                      <YAxis stroke="#374151" fontSize={9} tickFormatter={(v) => `₹${v}`} />
                      <Tooltip
                        contentStyle={{
                          background: "#0C1A2E",
                          border: "1px solid #1A3558",
                          borderRadius: "6px",
                          fontSize: "11px",
                        }}
                        labelFormatter={(b) => `Block ${b} · ${blockToTime(Number(b))}`}
                        formatter={(v: number, name: string) => [`₹${v.toFixed(3)}`, name]}
                      />
                      <ReferenceLine y={avgForecastPrice} stroke="#006DAE" strokeDasharray="4 4" strokeOpacity={0.5} />
                      <Area
                        type="monotone"
                        dataKey="high"
                        stroke="transparent"
                        fill="url(#confGradWS)"
                        name="CI High"
                      />
                      <Area
                        type="monotone"
                        dataKey="low"
                        stroke="transparent"
                        fill="#071225"
                        name="CI Low"
                      />
                      <Area
                        type="monotone"
                        dataKey="price"
                        stroke="#006DAE"
                        strokeWidth={2}
                        fill="none"
                        dot={false}
                        name="Forecast"
                        activeDot={{ r: 4, fill: "#006DAE" }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )}

          {/* 96-block grid */}
          {bidRows.length > 0 && (
            <div className="card p-0 overflow-hidden">
              {/* Table header bar */}
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)]">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-gray-300">
                    Bid Grid — {segment} · {strategy}
                  </span>
                  <span
                    className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                    style={{
                      color: stratMeta.color,
                      background: `${stratMeta.color}18`,
                      border: `1px solid ${stratMeta.color}33`,
                    }}
                  >
                    {stratMeta.hint}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-gray-500">
                  {overrideCount > 0 && (
                    <span className="text-amber-400">{overrideCount} edited</span>
                  )}
                  {violationCount > 0 && (
                    <span className="text-red-400">{violationCount} violations</span>
                  )}
                  <span>
                    {totalVol.toFixed(1)} MW total · ₹{avgBidPrice.toFixed(3)} avg
                  </span>
                </div>
              </div>

              {/* Scrollable table */}
              <div className="overflow-y-auto max-h-[480px]">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 z-10 bg-[#0C1A2E]">
                    <tr className="text-[10px] text-gray-500 uppercase tracking-wider">
                      <th className="text-left py-2 px-3 font-medium">#</th>
                      <th className="text-left py-2 px-2 font-medium">Time</th>
                      <th className="text-right py-2 px-2 font-medium">Fcst ₹</th>
                      <th className="text-right py-2 px-2 font-medium">CI Band</th>
                      <th className="text-right py-2 px-2 font-medium text-[#60AEDE]">Bid ₹</th>
                      <th className="text-right py-2 px-2 font-medium text-[#60AEDE]">Vol MW</th>
                      <th className="text-right py-2 px-2 font-medium">DSM Est</th>
                      <th className="text-right py-2 px-2 font-medium">Uncert.</th>
                      <th className="text-center py-2 px-2 font-medium">Status</th>
                      <th className="text-left py-2 px-2 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bidRows.map((b, idx) => {
                      const hasViolation = b.constraint_violations?.length > 0;
                      const isEdited = b.is_overridden;
                      const ciWidth = b.confidence_high - b.confidence_low;
                      const highUncertainty = ciWidth > 0.5;

                      return (
                        <tr
                          key={b.block}
                          className={`border-t border-[#132040] transition-colors ${
                            hasViolation
                              ? "bg-red-900/10"
                              : isEdited
                                ? "bg-amber-900/10"
                                : idx % 2 === 0
                                  ? "bg-transparent"
                                  : "bg-[#0C1A2E]/40"
                          } hover:bg-[#132040]/60`}
                        >
                          {/* Block # */}
                          <td className="py-1.5 px-3 font-mono font-medium text-gray-400">
                            {b.block}
                          </td>

                          {/* Time */}
                          <td className="py-1.5 px-2 text-gray-500 tabular-nums">
                            {blockToTime(b.block)}
                          </td>

                          {/* Forecast price */}
                          <td className="py-1.5 px-2 text-right tabular-nums text-gray-300">
                            {b.predicted_price.toFixed(3)}
                          </td>

                          {/* CI Band */}
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            <span
                              className={`text-[10px] ${
                                highUncertainty ? "text-amber-400" : "text-gray-600"
                              }`}
                            >
                              {b.confidence_low.toFixed(2)}–{b.confidence_high.toFixed(2)}
                            </span>
                          </td>

                          {/* Bid price — editable */}
                          <td className="py-1 px-2 text-right">
                            <input
                              type="number"
                              step="0.001"
                              value={b.price}
                              onChange={(e) =>
                                handleCellEdit(b.block, "price", e.target.value)
                              }
                              className={`w-20 bg-transparent border-b tabular-nums text-right text-xs focus:outline-none transition-colors ${
                                hasViolation
                                  ? "border-red-500 text-red-300 focus:border-red-400"
                                  : isEdited
                                    ? "border-amber-500 text-amber-200 focus:border-amber-400"
                                    : "border-[#1A3558] text-white focus:border-[#006DAE]"
                              }`}
                            />
                          </td>

                          {/* Volume — editable */}
                          <td className="py-1 px-2 text-right">
                            <input
                              type="number"
                              step="0.1"
                              value={b.volume_mw}
                              onChange={(e) =>
                                handleCellEdit(b.block, "volume_mw", e.target.value)
                              }
                              className={`w-16 bg-transparent border-b tabular-nums text-right text-xs focus:outline-none transition-colors ${
                                isEdited
                                  ? "border-amber-500 text-amber-200 focus:border-amber-400"
                                  : "border-[#1A3558] text-white focus:border-[#006DAE]"
                              }`}
                            />
                          </td>

                          {/* DSM estimate */}
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            <span
                              className={`text-[10px] ${
                                b.dsm_penalty_estimate > 0
                                  ? "text-red-400"
                                  : "text-gray-600"
                              }`}
                            >
                              {b.dsm_penalty_estimate > 0
                                ? formatINR(b.dsm_penalty_estimate)
                                : "—"}
                            </span>
                          </td>

                          {/* Uncertainty */}
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            <span
                              className={`text-[10px] ${
                                highUncertainty ? "text-amber-400" : "text-gray-600"
                              }`}
                            >
                              {b.uncertainty_score.toFixed(3)}
                            </span>
                          </td>

                          {/* Status badge */}
                          <td className="py-1.5 px-2 text-center">
                            {hasViolation ? (
                              <span
                                className="badge-violation cursor-help"
                                title={b.constraint_violations
                                  .map((v) => v.message)
                                  .join("; ")}
                              >
                                ⚠
                              </span>
                            ) : isEdited ? (
                              <span className="badge-warning">Edited</span>
                            ) : (
                              <span className="badge-ok">AI</span>
                            )}
                          </td>

                          {/* Override reason */}
                          <td className="py-1 px-2">
                            {isEdited && (
                              <>
                                {editingReasonBlock === b.block ? (
                                  <select
                                    className="select-field text-[10px] py-0.5 w-32"
                                    value={b.override_reason}
                                    onChange={(e) => {
                                      const reason = e.target.value;
                                      setBidRows((prev) =>
                                        prev.map((row) =>
                                          row.block === b.block
                                            ? { ...row, override_reason: reason }
                                            : row
                                        )
                                      );
                                      setEditingReasonBlock(null);
                                    }}
                                    autoFocus
                                    onBlur={() => setEditingReasonBlock(null)}
                                  >
                                    <option value="">Select…</option>
                                    {OVERRIDE_REASONS.map((r) => (
                                      <option key={r} value={r}>
                                        {r}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <button
                                    onClick={() => setEditingReasonBlock(b.block)}
                                    className="text-[10px] text-amber-400 hover:underline text-left max-w-[100px] truncate"
                                  >
                                    {b.override_reason || "Add reason…"}
                                  </button>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Empty state */}
          {bidRows.length === 0 && forecastBlocks.length === 0 && (
            <div className="card flex flex-col items-center justify-center py-16 gap-3 text-center">
              <div className="w-12 h-12 rounded-full bg-[#006DAE]/10 border border-[#006DAE]/20 flex items-center justify-center text-[#006DAE] text-xl">
                ⚡
              </div>
              <p className="text-gray-400 text-sm font-medium">Trading workstation ready</p>
              <p className="text-gray-600 text-xs max-w-xs">
                Select a date, segment and strategy above, then click{" "}
                <span className="text-white">1 · Forecast</span> to begin.
              </p>
            </div>
          )}

          {forecastBlocks.length > 0 && bidRows.length === 0 && (
            <div className="card flex flex-col items-center justify-center py-10 gap-2 text-center">
              <p className="text-gray-400 text-sm">Forecast ready — click <span className="text-white font-medium">2 · Get Bids</span> to generate LP-optimised bid recommendations.</p>
            </div>
          )}
        </div>

        {/* ── Right panel: Risk ───────────────────────────────────────── */}
        <div className="w-64 shrink-0 flex flex-col gap-3 sticky top-4">
          {/* Risk metrics card */}
          <div className="card flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-300">Risk Panel</span>
              {riskLoading && (
                <span className="text-[10px] text-gray-500 flex items-center gap-1">
                  <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                  Recalculating
                </span>
              )}
            </div>

            {liveRisk ? (
              <>
                {liveRisk.alert_triggered && (
                  <div className="rounded-md bg-red-900/30 border border-red-700/50 px-3 py-2">
                    <p className="text-red-400 text-[10px] font-bold uppercase tracking-wider">⚠ Risk Alert</p>
                    <p className="text-red-300 text-[10px] mt-0.5">
                      {liveRisk.alert_details?.message ?? "Exposure exceeds threshold"}
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <RiskMetric
                    label="VaR 95%"
                    value={formatINR(liveRisk.var_95)}
                    color="#006DAE"
                    sub="parametric"
                  />
                  <RiskMetric
                    label="Exp. DSM"
                    value={formatINR(liveRisk.expected_dsm_penalty)}
                    color={liveRisk.expected_dsm_penalty > 10000 ? "#ef4444" : "#00B398"}
                    sub="estimated"
                  />
                  <RiskMetric
                    label="Worst DSM"
                    value={formatINR(liveRisk.worst_case_penalty)}
                    color="#f59e0b"
                    sub="scenario"
                  />
                  <RiskMetric
                    label="Total Exp."
                    value={formatINR(liveRisk.total_exposure)}
                    color={liveRisk.alert_triggered ? "#ef4444" : "#00B398"}
                    sub={liveRisk.alert_triggered ? "above threshold" : "within limit"}
                  />
                </div>

                <div className="pt-2 border-t border-[var(--border)]">
                  <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                    <span>Exposure vs threshold</span>
                    <span className={liveRisk.alert_triggered ? "text-red-400" : "text-[#00B398]"}>
                      {((liveRisk.total_exposure / 500000) * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="w-full bg-[#132040] rounded-full h-1.5">
                    <div
                      className={`h-1.5 rounded-full transition-all ${
                        liveRisk.alert_triggered ? "bg-red-500" : "bg-[#00B398]"
                      }`}
                      style={{
                        width: `${Math.min((liveRisk.total_exposure / 500000) * 100, 100)}%`,
                      }}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="py-6 text-center">
                <p className="text-gray-600 text-[10px]">
                  {bidRows.length === 0
                    ? "Risk updates live once bids are generated"
                    : "Calculating…"}
                </p>
              </div>
            )}
          </div>

          {/* LP Optimizer summary */}
          {bidRows.length > 0 && (
            <div className="card flex flex-col gap-2">
              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">LP Summary</span>
              <div className="space-y-1.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-gray-500">Total volume</span>
                  <span className="text-white font-medium">{totalVol.toFixed(1)} MW</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Avg bid price</span>
                  <span className="text-white font-medium">₹{avgBidPrice.toFixed(3)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">DSM penalty est.</span>
                  <span className={totalDsmEst > 0 ? "text-red-400 font-medium" : "text-[#00B398] font-medium"}>
                    {totalDsmEst > 0 ? formatINR(totalDsmEst) : "₹0"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Overrides</span>
                  <span className={overrideCount > 0 ? "text-amber-400 font-medium" : "text-gray-500"}>
                    {overrideCount} / 96
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Violations</span>
                  <span className={violationCount > 0 ? "text-red-400 font-medium" : "text-[#00B398] font-medium"}>
                    {violationCount}
                  </span>
                </div>
              </div>

              <div className="pt-2 border-t border-[var(--border)] flex flex-col gap-1.5">
                <button
                  onClick={handleValidate}
                  disabled={stage === "validating"}
                  className="btn-secondary text-xs py-1.5 w-full"
                >
                  Validate Constraints
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={
                    stage === "submitting" ||
                    stage === "submitted" ||
                    bidRows.length === 0
                  }
                  className="btn-teal text-xs py-1.5 w-full disabled:opacity-40"
                >
                  {stage === "submitting"
                    ? "Submitting…"
                    : stage === "submitted"
                      ? "✓ Submitted"
                      : "Submit to Exchange"}
                </button>
              </div>
            </div>
          )}

          {/* Strategy λ info */}
          <div className="card">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
              LP Objective
            </span>
            <div className="mt-2 font-mono text-[10px] text-gray-500 leading-relaxed">
              <div>max Σ price[b]·vol[b]</div>
              <div className="text-[9px] mt-0.5">
                <span style={{ color: stratMeta.color }}>
                  − λ₁·DSM_penalty[b]
                </span>
              </div>
              <div className="text-[9px]">
                <span style={{ color: stratMeta.color }}>
                  − λ₂·CI_width[b]·vol[b]
                </span>
              </div>
              <div className="mt-2 text-[9px] space-y-0.5">
                <div className="flex justify-between">
                  <span>λ₁ (DSM weight)</span>
                  <span style={{ color: stratMeta.color }}>
                    {((1 - (strategy === "conservative" ? 0.3 : strategy === "balanced" ? 0.6 : 0.9)) * 2.0).toFixed(1)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>λ₂ (Uncertainty weight)</span>
                  <span style={{ color: stratMeta.color }}>
                    {((1 - (strategy === "conservative" ? 0.3 : strategy === "balanced" ? 0.6 : 0.9)) * 1.5).toFixed(1)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
