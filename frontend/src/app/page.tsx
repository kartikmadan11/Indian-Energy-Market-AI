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
  autoTuneLambdas,
  requestApproval,
  type ApprovalResult,
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
  | "reviewing"
  | "reviewed"
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
  { idx: 3, label: "Review" },
  { idx: 4, label: "Submitted" },
];

const OVERRIDE_REASONS = [
  "Market intelligence",
  "Demand forecast adjustment",
  "Risk mitigation",
  "Regulatory requirement",
  "Manager directive",
  "Other",
];

// Lambda defaults mirror backend/common/solver_config.py
const LAMBDA1_DEFAULT = 2.0;
const LAMBDA2_DEFAULT = 1.5;

// FastAPI detail can be a string or a Pydantic v2 array of {loc,msg,type,…} objects.
function apiError(e: any, fallback: string): string {
  const detail = e?.response?.data?.detail;
  if (!detail) return fallback;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail
      .map((d: any) => `${d.loc?.slice(-1)[0] ?? "field"}: ${d.msg}`)
      .join(" · ");
  return fallback;
}

// Risk tolerance by strategy — mirrors backend/common/config.py STRATEGY_PROFILES
const STRATEGY_RISK_TOLERANCE: Record<string, number> = {
  conservative: 0.3,
  balanced: 0.6,
  aggressive: 0.9,
};

function stageToStep(s: Stage): number {
  if (s === "idle" || s === "forecasting") return -1;
  if (s === "forecasted" || s === "loading_bids") return 0;
  if (s === "ready") return 1;
  if (s === "validating" || s === "validated") return 2;
  if (s === "reviewing" || s === "reviewed") return 3;
  if (s === "submitting" || s === "submitted") return 4;
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
          (step.idx === 3 && stage === "reviewing") ||
          (step.idx === 4 && stage === "submitting");
        return (
          <div key={step.idx} className="flex items-center">
            <div className="flex items-center gap-1.5">
              <div
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${
                  done
                    ? "bg-[#00B398] text-white"
                    : active
                      ? "bg-[#006DAE] text-white"
                      : "bg-gray-200 text-gray-500"
                }`}
              >
                {spinning ? (
                  <svg
                    className="animate-spin w-3 h-3"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                ) : done ? (
                  "✓"
                ) : (
                  step.idx + 1
                )}
              </div>
              <span
                className={`text-[10px] font-medium ${
                  done
                    ? "text-[#00B398]"
                    : active
                      ? "text-[#006DAE]"
                      : "text-gray-400"
                }`}
              >
                {step.label}
              </span>
            </div>
            {i < WORKFLOW_STEPS.length - 1 && (
              <div
                className={`w-8 h-px mx-1 ${done ? "bg-[#00B398]" : "bg-gray-200"}`}
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
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 hover:shadow-md transition-shadow">
      <span className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider block mb-1">
        {label}
      </span>
      <span className="text-lg font-bold block" style={{ color }}>
        {value}
      </span>
      {sub && (
        <span className="text-[10px] text-gray-500 mt-0.5 block">{sub}</span>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function WorkspacePage() {
  // Controls
  const [segment, setSegment] = useState<string>("DAM");
  const [strategy, setStrategy] =
    useState<(typeof STRATEGIES)[number]>("balanced");
  const [targetDate, setTargetDate] = useState(getTomorrowDate());
  const [demandMw, setDemandMw] = useState(500);
  const [demandMwInput, setDemandMwInput] = useState("500");
  const [lambda1, setLambda1] = useState<number | null>(null); // null = use solver_config default
  const [lambda2, setLambda2] = useState<number | null>(null);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [autoTuning, setAutoTuning] = useState(false);
  const [tuneMultiplier, setTuneMultiplier] = useState<number | null>(null);

  // Reset lambda overrides whenever the strategy changes so the panel
  // reflects the new strategy's implied pressure, not a stale manual value.
  useEffect(() => {
    setLambda1(null);
    setLambda2(null);
  }, [strategy]);

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
  const [approvalResult, setApprovalResult] = useState<ApprovalResult | null>(null);
  const [approvalOpen, setApprovalOpen] = useState(true);
  const [error, setError] = useState("");

  // UI
  const [chartOpen, setChartOpen] = useState(true);
  const [editingReasonBlock, setEditingReasonBlock] = useState<number | null>(
    null,
  );

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
          })),
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
    setApprovalResult(null);
    try {
      const data = await predictPrices(targetDate, segment);
      forecastRef.current = data.blocks;
      setForecastBlocks(data.blocks);
      setStage("forecasted");
    } catch (e: any) {
      setError(apiError(e, "Forecast failed. Check backend."));
      setStage("idle");
    }
  };

  const handleGetBids = async (
    l1Override?: number | null,
    l2Override?: number | null,
  ) => {
    if (forecastRef.current.length === 0) {
      setError("Run forecast first.");
      return;
    }
    setStage("loading_bids");
    setError("");
    setSubmitResult(null);
    setValidationResult(null);
    setApprovalResult(null);
    // Use freshly-passed values (e.g. from auto-tune) or fall back to state.
    const rt = STRATEGY_RISK_TOLERANCE[strategy];
    const l1 = l1Override !== undefined ? l1Override : lambda1;
    const l2 = l2Override !== undefined ? l2Override : lambda2;
    try {
      const recs = await recommendBids(
        targetDate,
        strategy,
        segment,
        demandMw,
        {
          // Reverse-compute base from effective so the LP's (1−rt)×base == effective.
          lambda1_base: l1 !== null ? l1 / (1 - rt) : null,
          lambda2_base: l2 !== null ? l2 / (1 - rt) : null,
        },
      );
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
      setError(apiError(e, "Failed to get recommendations."));
      setStage("forecasted");
    }
  };

  const handleCellEdit = (
    block: number,
    field: "price" | "volume_mw",
    value: string,
  ) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    setBidRows((prev) =>
      prev.map((b) =>
        b.block === block ? { ...b, [field]: num, is_overridden: true } : b,
      ),
    );
    // Invalidate validation so user must re-validate before submitting
    setStage((s) => (s === "validated" ? "ready" : s));
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
        })),
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
        })),
      );
      setSubmitResult(result);
      setStage("submitted");
    } catch (e: any) {
      setError(apiError(e, "Submission failed."));
      setStage("reviewed");
    }
  };

  const handleRequestApproval = async () => {
    setStage("reviewing");
    setApprovalResult(null);
    try {
      const result = await requestApproval(
        `ws-${Date.now()}`,
        targetDate,
        segment,
        strategy,
        bidRows.map((b) => ({
          block: b.block,
          segment: b.segment,
          price: b.price,
          volume_mw: b.volume_mw,
          is_overridden: b.is_overridden,
          override_reason: b.override_reason || undefined,
          constraint_violations: b.constraint_violations?.length
            ? b.constraint_violations
            : undefined,
        })),
      );
      setApprovalResult(result);
      setApprovalOpen(true);
      setStage("reviewed");
    } catch (e: any) {
      setError(apiError(e, "Agent review failed."));
      setStage("validated");
    }
  };

  // ── Derived metrics ──────────────────────────────────────────────────────

  const strategyRiskTolerance = STRATEGY_RISK_TOLERANCE[strategy];
  // lambda1/lambda2 state now holds effective lambda (post risk-tolerance scaling).
  // When null = auto, derive from strategy; when set, use directly.
  const effectiveLambda1 =
    lambda1 ?? (1 - strategyRiskTolerance) * LAMBDA1_DEFAULT;
  const effectiveLambda2 =
    lambda2 ?? (1 - strategyRiskTolerance) * LAMBDA2_DEFAULT;

  const handleAutoTune = async () => {
    if (forecastBlocks.length === 0) {
      setError("Run forecast first before auto-tuning.");
      return;
    }
    setAutoTuning(true);
    try {
      const result = await autoTuneLambdas(
        targetDate,
        strategy,
        segment,
        demandMw,
      );
      // Convert returned bases to effective lambdas for the slider state.
      const newL1 = result.best_lambda1_base * (1 - strategyRiskTolerance);
      const newL2 = result.best_lambda2_base * (1 - strategyRiskTolerance);
      setLambda1(newL1);
      setLambda2(newL2);
      setTuneMultiplier(
        result.dsm_multiplier ?? 1 / Math.max(1 - strategyRiskTolerance, 0.01),
      );
      // Re-fetch bids immediately with the new values — don’t wait for state flush.
      if (forecastRef.current.length > 0) {
        await handleGetBids(newL1, newL2);
      }
    } catch {
      setError("Auto-tune failed. Check backend.");
    }
    setAutoTuning(false);
  };

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
    0,
  );
  // Lambdas actually applied in the last LP solve — comes from optimizer response.
  // Falls back to derived effective values if bid rows haven't loaded yet.
  const appliedLambda1: number =
    (bidRows[0] as any)?.effective_lambda1 ?? effectiveLambda1;
  const appliedLambda2: number =
    (bidRows[0] as any)?.effective_lambda2 ?? effectiveLambda2;

  const avgForecastPrice =
    forecastBlocks.length > 0
      ? forecastBlocks.reduce((s, b) => s + b.predicted_price, 0) /
        forecastBlocks.length
      : 0;

  const stratMeta = STRATEGY_META[strategy];

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="max-w-[1400px] mx-auto flex flex-col gap-4">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            Trading Workstation
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            AI-powered bid optimization for electricity markets
          </p>
        </div>
      </div>

      {/* ── Configuration Panel ─────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-gray-800">
            Trading Parameters
          </h2>
          <button
            onClick={() => setTuneOpen((o) => !o)}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all hover:shadow-md ${
              tuneOpen || lambda1 !== null || lambda2 !== null
                ? "border-[#006DAE] text-white bg-[#006DAE] shadow-sm"
                : "border-gray-300 text-gray-600 hover:border-[#006DAE] hover:text-[#006DAE]"
            }`}
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
              />
            </svg>
            {tuneOpen || lambda1 !== null || lambda2 !== null
              ? "Optimizer Settings ●"
              : "Advanced Settings"}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Date */}
          <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
            <label className="block text-xs font-semibold text-gray-700 mb-2">
              Trading Date
            </label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="w-full px-3 py-2 text-sm border-2 border-gray-300 rounded-lg focus:outline-none focus:border-[#006DAE] focus:ring-2 focus:ring-[#006DAE]/20 transition-all"
            />
          </div>

          {/* Segment */}
          <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
            <label className="block text-xs font-semibold text-gray-700 mb-2">
              Market Segment
            </label>
            <div className="flex h-9 rounded-lg overflow-hidden border-2 border-gray-300">
              {SEGMENTS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSegment(s)}
                  className={`flex-1 text-xs font-bold transition-all ${
                    segment === s
                      ? "bg-[#006DAE] text-white shadow-inner"
                      : "bg-white text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Strategy */}
          <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
            <label className="block text-xs font-semibold text-gray-700 mb-2">
              Trading Strategy
            </label>
            <div className="flex h-9 rounded-lg overflow-hidden border-2 border-gray-300">
              {STRATEGIES.map((s) => (
                <button
                  key={s}
                  onClick={() => setStrategy(s)}
                  className={`flex-1 text-[10px] font-bold capitalize transition-all ${
                    strategy === s
                      ? STRATEGY_META[s].activeClass + " shadow-inner"
                      : "bg-white text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {s === "conservative"
                    ? "Cons"
                    : s === "balanced"
                      ? "Bal"
                      : "Agg"}
                </button>
              ))}
            </div>
            <p className="text-[9px] text-gray-500 mt-1.5 text-center">
              {STRATEGY_META[strategy].hint}
            </p>
          </div>

          {/* Demand */}
          <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
            <label className="block text-xs font-semibold text-gray-700 mb-2">
              Total Demand
            </label>
            <div className="relative">
              <input
                type="number"
                value={demandMwInput}
                onChange={(e) => {
                  setDemandMwInput(e.target.value);
                  const n = parseFloat(e.target.value);
                  if (!isNaN(n) && n > 0) setDemandMw(n);
                }}
                onBlur={() => {
                  const n = parseFloat(demandMwInput);
                  if (isNaN(n) || n <= 0) {
                    setDemandMwInput(String(demandMw));
                  } else {
                    setDemandMw(n);
                    setDemandMwInput(String(n));
                  }
                }}
                className="w-full pl-3 pr-12 py-2 text-sm font-bold border-2 border-gray-300 rounded-lg focus:outline-none focus:border-[#006DAE] focus:ring-2 focus:ring-[#006DAE]/20 transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">
                MW
              </span>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-4 bg-gray-50 border border-gray-300 rounded-lg p-3 flex flex-col gap-3">
          {/* Button group — full width */}
          <div className="flex items-center w-full rounded-md border border-gray-300 overflow-hidden divide-x divide-gray-300 shadow-sm">
            {/* 1. Generate Forecast */}
            <button
              onClick={handleForecast}
              disabled={stage === "forecasting"}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed focus:z-10 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#006DAE] ${
                stage === "forecasting"
                  ? "bg-[#006DAE] text-white"
                  : forecastBlocks.length > 0
                    ? "bg-gray-100 text-gray-500 hover:bg-[#006DAE] hover:text-white"
                    : "bg-white text-gray-700 hover:bg-[#006DAE] hover:text-white disabled:opacity-40"
              }`}
            >
              {stage === "forecasting" ? (
                <>
                  <svg
                    className="animate-spin w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                  Forecasting...
                </>
              ) : (
                <>
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                  </svg>
                  1. Generate Forecast
                </>
              )}
            </button>

            {/* 2. Optimize Bids */}
            <button
              onClick={() => handleGetBids()}
              disabled={forecastBlocks.length === 0 || stage === "loading_bids"}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed focus:z-10 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#006DAE] ${
                stage === "loading_bids"
                  ? "bg-gray-700 text-white"
                  : bidRows.length > 0
                    ? "bg-gray-100 text-gray-500 hover:bg-gray-700 hover:text-white"
                    : "bg-white text-gray-700 hover:bg-gray-700 hover:text-white disabled:opacity-40"
              }`}
            >
              {stage === "loading_bids" ? (
                <>
                  <svg
                    className="animate-spin w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                  Optimizing...
                </>
              ) : (
                <>
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                  </svg>
                  2. Optimize Bids
                </>
              )}
            </button>

            {/* 3. Validate */}
            <button
              onClick={handleValidate}
              disabled={bidRows.length === 0 || stage === "validating" || stage === "validated" || stage === "submitting" || stage === "submitted"}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed focus:z-10 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#006DAE] ${
                stage === "validating"
                  ? "bg-gray-700 text-white"
                  : (stage === "validated" || stage === "submitting" || stage === "submitted")
                    ? "bg-gray-100 text-gray-500 hover:bg-gray-700 hover:text-white"
                    : "bg-white text-gray-700 hover:bg-gray-700 hover:text-white disabled:opacity-40"
              }`}
            >
              {stage === "validating" ? (
                <>
                  <svg
                    className="animate-spin w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                  Checking...
                </>
              ) : (
                <>
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  3. Validate
                </>
              )}
            </button>

            {/* 4. Agent Review */}
            <button
              onClick={handleRequestApproval}
              disabled={
                bidRows.length === 0 ||
                stage === "reviewing" ||
                stage === "submitting" ||
                stage === "submitted"
              }
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed focus:z-10 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#006DAE] ${
                stage === "reviewing"
                  ? "bg-gray-700 text-white"
                  : stage === "reviewed"
                    ? "bg-gray-100 text-gray-500 hover:bg-gray-700 hover:text-white"
                    : "bg-white text-gray-700 hover:bg-gray-700 hover:text-white disabled:opacity-40"
              }`}
            >
              {stage === "reviewing" ? (
                <>
                  <svg
                    className="animate-spin w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                  Reviewing...
                </>
              ) : (
                <>
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                    />
                  </svg>
                  4. Agent Review
                </>
              )}
            </button>

            {/* 5. Submit to IEX */}
            <button
              onClick={handleSubmit}
              disabled={
                !(stage === "reviewed" && approvalResult?.can_submit)
              }
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed focus:z-10 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#006DAE] ${
                stage === "submitting"
                  ? "bg-gray-700 text-white"
                  : stage === "submitted"
                    ? "bg-[#00B398] text-white"
                    : "bg-white text-gray-700 hover:bg-[#00B398] hover:text-white disabled:opacity-40"
              }`}
            >
              {stage === "submitting" ? (
                <>
                  <svg
                    className="animate-spin w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                  Submitting...
                </>
              ) : stage === "submitted" ? (
                <>
                  <svg
                    className="w-3.5 h-3.5"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Submitted ✓
                </>
              ) : (
                <>
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  5. Submit to IEX
                </>
              )}
            </button>
          </div>

          {/* Metrics + stepper row */}
          <div className="flex items-center gap-4">
            {bidRows.length > 0 && (
              <div className="flex items-center gap-4 text-xs">
                <div>
                  <div className="text-gray-500">Total Volume</div>
                  <div className="font-bold text-[#006DAE]">
                    {totalVol.toFixed(1)} MW
                  </div>
                </div>
                <div>
                  <div className="text-gray-500">Avg Price</div>
                  <div className="font-bold text-[#006DAE]">
                    ₹{avgBidPrice.toFixed(3)}
                  </div>
                </div>
              </div>
            )}
            <div className="flex-1">
              <div className="text-[9px] text-gray-400 font-semibold uppercase tracking-wider mb-1.5">
                Progress
              </div>
              <WorkflowStepper stage={stage} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Optimizer tuning panel ────────────────────────────────────── */}
      {tuneOpen && (
        <div className="card border-2 border-[#006DAE]/30 bg-white">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <svg
                  className="w-5 h-5 text-[#006DAE]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
                  />
                </svg>
                <h3 className="text-sm font-bold text-gray-900">
                  Advanced Optimizer Tuning
                </h3>
              </div>
              <p className="text-xs text-gray-600 leading-relaxed max-w-2xl">
                Fine-tune how the Linear Programming optimizer balances
                compliance risk vs. forecast confidence. Changes take effect on
                the next "Optimize Bids" run.
                {tuneMultiplier !== null &&
                  typeof tuneMultiplier === "number" && (
                    <span className="ml-2 text-xs font-semibold text-[#006DAE] bg-white px-2 py-0.5 rounded-full border border-[#006DAE]/30">
                      Last auto-tune: DSM weight = {tuneMultiplier.toFixed(2)}×
                    </span>
                  )}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {(lambda1 !== null || lambda2 !== null) && (
                <button
                  onClick={() => {
                    setLambda1(null);
                    setLambda2(null);
                  }}
                  className="text-xs font-medium text-gray-600 hover:text-[#006DAE] hover:underline transition-colors"
                >
                  Reset All
                </button>
              )}
              <button
                onClick={handleAutoTune}
                disabled={autoTuning}
                className="flex items-center gap-2 text-sm font-bold px-4 py-2 rounded-lg border-2 border-[#006DAE] transition-all disabled:opacity-50 bg-[#006DAE] text-white hover:bg-[#005a9e] hover:shadow-lg disabled:hover:shadow-none"
              >
                {autoTuning ? (
                  <>
                    <svg
                      className="animate-spin w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8v8H4z"
                      />
                    </svg>
                    Searching Optimal Values...
                  </>
                ) : (
                  <>
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 10V3L4 14h7v7l9-11h-7z"
                      />
                    </svg>
                    Auto-Tune Parameters
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* DSM Compliance pressure */}
            <div className="bg-white rounded-xl border-2 border-gray-200 px-5 py-4 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-gray-900">
                      λ₁: DSM Compliance Pressure
                    </span>
                    {lambda1 !== null && (
                      <span className="text-[9px] font-bold text-white bg-[#006DAE] px-2 py-0.5 rounded-full">
                        OVERRIDE
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-600 leading-relaxed">
                    Controls how aggressively the optimizer stays within CERC
                    deviation bands.
                    <span className="block mt-1 text-[10px] text-gray-500">
                      <strong>Higher:</strong> Volume spread conservatively to
                      avoid penalties
                      <br />
                      <strong>Lower:</strong> Chases value even if risking
                      deviation charges
                    </span>
                  </p>
                </div>
                {lambda1 !== null && (
                  <button
                    onClick={() => setLambda1(null)}
                    className="shrink-0 ml-3 text-xs font-medium text-[#006DAE] hover:underline"
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-xs text-gray-500 shrink-0">
                    Lenient
                  </span>
                  <input
                    type="range"
                    min={0.05}
                    max={5.0}
                    step={0.05}
                    value={effectiveLambda1}
                    onChange={(e) => setLambda1(parseFloat(e.target.value))}
                    className="flex-1 accent-[#006DAE] cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 shrink-0">Strict</span>
                  <span
                    className={`text-sm font-semibold w-12 text-right shrink-0 tabular-nums ${lambda1 !== null ? "text-[#006DAE]" : "text-gray-500"}`}
                  >
                    {effectiveLambda1.toFixed(2)}
                  </span>
                </div>
                <p
                  className={`text-xs mt-1 ${lambda1 === null ? "text-gray-400" : "text-[#006DAE]"}`}
                >
                  {lambda1 === null
                    ? `Using strategy default: ${effectiveLambda1.toFixed(2)}`
                    : effectiveLambda1 >= 2.2
                      ? "Very strict - broad volume spread"
                      : effectiveLambda1 >= 1.2
                        ? "Moderately strict compliance"
                        : effectiveLambda1 <= 0.4
                          ? "Lenient - focused volume"
                          : "Balanced approach"}
                </p>
              </div>
            </div>

            {/* Forecast Confidence Caution */}
            <div className="bg-white rounded-xl border-2 border-gray-200 px-5 py-4 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-gray-800">
                      λ₂: Forecast Confidence Caution
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 leading-relaxed">
                    Controls how much the optimizer avoids blocks with uncertain
                    price forecasts.
                    <span className="block mt-1 text-[10px] text-gray-500">
                      <strong>Higher:</strong> Volume shifted away from volatile
                      time-blocks
                      <br />
                      <strong>Lower:</strong> Treats all blocks equally despite
                      uncertainty
                    </span>
                  </p>
                </div>
                {lambda2 !== null && (
                  <button
                    onClick={() => setLambda2(null)}
                    className="shrink-0 ml-3 text-xs font-medium text-[#006DAE] hover:underline"
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-xs text-gray-500 shrink-0">Ignore</span>
                  <input
                    type="range"
                    min={0.05}
                    max={1.1}
                    step={0.05}
                    value={effectiveLambda2}
                    onChange={(e) => setLambda2(parseFloat(e.target.value))}
                    className="flex-1 accent-[#006DAE] cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 shrink-0">Avoid</span>
                  <span
                    className={`text-sm font-semibold w-12 text-right shrink-0 tabular-nums ${lambda2 !== null ? "text-[#006DAE]" : "text-gray-500"}`}
                  >
                    {effectiveLambda2.toFixed(2)}
                  </span>
                </div>
                <p
                  className={`text-xs mt-1 ${lambda2 === null ? "text-gray-400" : "text-[#006DAE]"}`}
                >
                  {lambda2 === null
                    ? `Using strategy default: ${effectiveLambda2.toFixed(2)}`
                    : effectiveLambda2 >= 0.9
                      ? "Strongly avoids uncertain blocks"
                      : effectiveLambda2 >= 0.6
                        ? "Moderately cautious"
                        : effectiveLambda2 <= 0.3
                          ? "Largely ignores uncertainty"
                          : "Balanced caution"}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Status banners ────────────────────────────────────────────── */}
      {error && (
        <div className="card py-2 bg-red-50 border-red-200 flex items-center gap-2">
          <span className="text-red-600 text-xs">{error}</span>
          <button
            onClick={() => setError("")}
            className="ml-auto text-gray-400 hover:text-gray-700 text-xs"
          >
            ✕
          </button>
        </div>
      )}
      {validationResult && (
        <details
          className={`card py-2 group ${
            validationResult.valid
              ? "bg-teal-50 border-teal-200"
              : "bg-red-50 border-red-200"
          }`}
        >
          <summary className="flex items-center gap-2 cursor-pointer list-none">
            <span
              className={`text-xs font-medium flex-1 ${
                validationResult.valid ? "text-teal-700" : "text-red-600"
              }`}
            >
              {validationResult.valid
                ? "✓ All constraints passed — ready to submit"
                : `⚠ ${validationResult.violation_count} constraint violation(s) — review highlighted rows`}
            </span>
            <span className="text-[10px] text-gray-400 group-open:hidden">
              ▾ details
            </span>
            <span className="text-[10px] text-gray-400 hidden group-open:inline">
              ▴ hide
            </span>
          </summary>
          <div className="mt-3 pt-3 border-t border-teal-200/60 space-y-2 text-[11px] text-gray-600">
            <p className="font-semibold text-gray-700">
              Checks performed against active DSM policy
            </p>
            <ul className="space-y-1 ml-2">
              <li>
                — <span className="font-medium">Price floor / ceiling</span> —
                every bid price must be within the CERC-notified band for the
                active policy
              </li>
              <li>
                — <span className="font-medium">Technical minimum</span> — for
                DAM / RTM, any non-zero volume must be ≥ the policy’s minimum
                block size
              </li>
              <li>
                — <span className="font-medium">Non-negative volume</span> — no
                block may have a negative bid quantity
              </li>
            </ul>
            {bidRows[0] && (
              <p className="text-[10px] text-gray-500">
                Policy enforced:{" "}
                <span className="font-mono font-medium text-gray-700">
                  {(bidRows[0] as any).active_policy}
                </span>
              </p>
            )}
            {!validationResult.valid &&
              validationResult.violations?.length > 0 && (
                <div className="mt-2">
                  <p className="font-semibold text-red-600 mb-1">Violations:</p>
                  <ul className="space-y-0.5">
                    {validationResult.violations.map((v: any, i: number) => (
                      <li key={i} className="text-red-600">
                        Block {v.block} · {v.field}: {v.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
          </div>
        </details>
      )}
      {/* ── Agent Approval Verdict Card ─────────────────────────────────── */}
      {approvalResult && (
        <div
          className={`card ${
            approvalResult.verdict === "APPROVED"
              ? "bg-teal-50 border-teal-300"
              : approvalResult.verdict === "APPROVED_WITH_FLAGS"
                ? "bg-amber-50 border-amber-300"
                : "bg-red-50 border-red-300"
          }`}
        >
          <div className="flex items-center gap-3 mb-3" style={{marginBottom: approvalOpen ? undefined : 0}}>
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                approvalResult.verdict === "APPROVED"
                  ? "bg-teal-100 text-teal-700"
                  : approvalResult.verdict === "APPROVED_WITH_FLAGS"
                    ? "bg-amber-100 text-amber-700"
                    : approvalResult.verdict === "NEEDS_REVISION"
                      ? "bg-orange-100 text-orange-700"
                      : "bg-red-100 text-red-700"
              }`}
            >
              {approvalResult.verdict === "APPROVED" && "✓ "}
              {approvalResult.verdict === "APPROVED_WITH_FLAGS" && "⚠ "}
              {approvalResult.verdict === "NEEDS_REVISION" && "✎ "}
              {approvalResult.verdict === "REJECTED" && "✕ "}
              {approvalResult.verdict.replace(/_/g, " ")}
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      approvalResult.score >= 80
                        ? "bg-teal-500"
                        : approvalResult.score >= 55
                          ? "bg-amber-400"
                          : "bg-red-400"
                    }`}
                    style={{ width: `${approvalResult.score}%` }}
                  />
                </div>
                <span className="text-xs font-bold text-gray-700 w-10 text-right">
                  {approvalResult.score}/100
                </span>
              </div>
            </div>
            <span className="text-[10px] text-gray-500 font-medium">
              AI Agent · {approvalResult.checks.length} checks
            </span>
            <button
              onClick={() => setApprovalOpen((o) => !o)}
              className="text-[10px] text-gray-400 hover:text-gray-600 transition-colors px-1.5 py-0.5 rounded hover:bg-black/5"
            >
              {approvalOpen ? "▴ hide" : "▾ show"}
            </button>
          </div>
          {approvalOpen && (
          <><p className="text-[11px] text-gray-700 mb-3">{approvalResult.summary}</p>
          <div className="space-y-1">
            {approvalResult.checks.map((check) => (
              <div
                key={check.name}
                className={`flex items-start gap-2 text-[11px] rounded-md px-2 py-1 ${
                  check.status === "pass"
                    ? "bg-teal-50/60"
                    : check.status === "warn"
                      ? "bg-amber-50/60"
                      : "bg-red-50/60"
                }`}
              >
                <span className="shrink-0 text-[12px] mt-px">
                  {check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✕"}
                </span>
                <div className="flex-1 min-w-0">
                  <span
                    className={`text-[9px] font-bold uppercase tracking-wider mr-1.5 px-1 py-0.5 rounded ${
                      check.category === "hard"
                        ? "bg-gray-800 text-white"
                        : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {check.category}
                  </span>
                  <span className="font-medium text-gray-800">
                    {check.name.replace(/_/g, " ")}
                  </span>
                  <span className="text-gray-600"> — {check.message}</span>
                  {check.affected_blocks.length > 0 && (
                    <span className="text-[10px] text-gray-400 ml-1">
                      (blocks: {check.affected_blocks.slice(0, 5).join(", ")}
                      {check.affected_blocks.length > 5 && ` +${check.affected_blocks.length - 5} more`})
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {!approvalResult.can_submit && (
            <p className="mt-3 text-[10px] text-gray-500 border-t border-red-200/60 pt-2">
              Resolve the critical issue(s) above, then re-run Agent Review.
            </p>
          )}
          </>
          )}
        </div>
      )}
      {submitResult && (
        <details className="card py-2 group">
          <summary className="flex items-center gap-2 cursor-pointer list-none">
            <span className="text-teal-700 text-xs font-medium flex-1">
              ✓ Submitted — Session {submitResult.session_id} ·{" "}
              {submitResult.bid_count} bids ·{" "}
              {submitResult.violations?.length ?? 0} violations
            </span>
            <span className="text-[10px] text-gray-400 group-open:hidden">
              ▾ IEX payload
            </span>
            <span className="text-[10px] text-gray-400 hidden group-open:inline">
              ▴ hide
            </span>
          </summary>
          <div className="mt-3 pt-3 border-t border-gray-200 space-y-2 text-[11px] text-gray-600">
            <p className="font-semibold text-gray-700">Mock IEX API Request</p>
            <div className="max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-lg">
              <pre className="p-3 text-[10px] font-mono text-gray-700 leading-relaxed">
                {`POST https://api.iexindia.com/market/bids
Authorization: Bearer <participant-token>
Content-Type: application/json

{
  "participant_id": "STG-TRADER-001",
  "market_segment": "${segment}",
  "delivery_date": "${targetDate}",
  "session_id": "${submitResult.session_id}",
  "bid_count": ${submitResult.bid_count},
  "strategy": "${strategy}",
  "bids": [
${bidRows.map((b, i) =>
  `    { "block": ${b.block}, "price": ${b.price?.toFixed(4) ?? "—"}, "volume_mw": ${b.volume_mw?.toFixed(1) ?? "—"} }${i < bidRows.length - 1 ? "," : ""}`
).join("\n")}
  ]
}`}
              </pre>
            </div>
            <p className="text-[10px] text-gray-400">
              IEX confirms acceptance with a{" "}
              <span className="font-mono">200 OK</span> and a{" "}
              <span className="font-mono">bid_reference_id</span>. Rejections
              return <span className="font-mono">422</span> with a constraint
              reason code.
            </p>
          </div>
        </details>
      )}

      {/* ── Main area: left grid + right risk panel ────────────────────── */}
      <div className="flex gap-4 items-start">
        {/* ── Left ── */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          {/* Forecast chart (collapsible) */}
          {forecastBlocks.length > 0 && (
            <div className="card border-2 border-[#006DAE]/20 hover:border-[#006DAE]/40 transition-colors">
              <div
                className="flex items-center justify-between cursor-pointer select-none group"
                onClick={() => setChartOpen((o) => !o)}
              >
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-[#006DAE] text-white flex items-center justify-center">
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                        />
                      </svg>
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-gray-900">
                        AI Price Forecast
                      </h3>
                      <p className="text-xs text-gray-500">
                        {segment} · {targetDate}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <div className="bg-[#006DAE]/10 border border-[#006DAE]/30 rounded-lg px-3 py-1.5">
                      <span className="text-gray-600">Avg Price: </span>
                      <span className="font-bold text-[#006DAE]">
                        ₹{avgForecastPrice.toFixed(3)}/kWh
                      </span>
                    </div>
                    <div className="bg-gray-100 border border-gray-300 rounded-lg px-3 py-1.5">
                      <span className="text-gray-600">Blocks: </span>
                      <span className="font-bold text-gray-900">
                        {forecastBlocks.length}
                      </span>
                    </div>
                  </div>
                </div>
                <button className="flex items-center gap-2 text-xs font-semibold text-[#006DAE] hover:text-[#005A91] transition-colors px-3 py-1.5 rounded-lg hover:bg-[#006DAE]/5">
                  {chartOpen ? (
                    <>
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 15l7-7 7 7"
                        />
                      </svg>
                      Collapse Chart
                    </>
                  ) : (
                    <>
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                      Expand Chart
                    </>
                  )}
                </button>
              </div>

              {chartOpen && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <div className="h-48 bg-gradient-to-br from-gray-50/50 to-blue-50/30 rounded-lg p-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={chartData}
                        margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
                      >
                        <defs>
                          <linearGradient
                            id="confGradWS"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop
                              offset="5%"
                              stopColor="#006DAE"
                              stopOpacity={0.3}
                            />
                            <stop
                              offset="95%"
                              stopColor="#006DAE"
                              stopOpacity={0}
                            />
                          </linearGradient>
                        </defs>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="#E5E7EB"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="block"
                          stroke="#9CA3AF"
                          fontSize={10}
                          interval={11}
                          tickFormatter={(b) => blockToTime(b)}
                        />
                        <YAxis
                          stroke="#9CA3AF"
                          fontSize={10}
                          tickFormatter={(v) => `₹${v}`}
                          width={50}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "#FFFFFF",
                            border: "2px solid #E2E8F0",
                            borderRadius: "8px",
                            fontSize: "11px",
                            color: "#1E293B",
                            boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
                          }}
                          labelFormatter={(b) =>
                            `Block ${b} · ${blockToTime(Number(b))}`
                          }
                          formatter={(v: number, name: string) => [
                            `₹${v.toFixed(3)}`,
                            name,
                          ]}
                        />
                        <ReferenceLine
                          y={avgForecastPrice}
                          stroke="#006DAE"
                          strokeDasharray="4 4"
                          strokeOpacity={0.6}
                          strokeWidth={2}
                        />
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
                          fill="#F9FAFB"
                          name="CI Low"
                        />
                        <Area
                          type="monotone"
                          dataKey="price"
                          stroke="#006DAE"
                          strokeWidth={2.5}
                          fill="none"
                          dot={false}
                          name="Forecast"
                          activeDot={{
                            r: 5,
                            fill: "#006DAE",
                            strokeWidth: 2,
                            stroke: "white",
                          }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-3 flex items-center justify-center gap-4 text-xs text-gray-600">
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-0.5 bg-[#006DAE]"></span>
                      Predicted Price
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 bg-[#006DAE]/20 border border-[#006DAE]"></span>
                      Confidence Interval
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        className="w-3 h-0.5 bg-[#006DAE] opacity-60"
                        style={{ borderTop: "2px dashed #006DAE" }}
                      ></span>
                      Average Line
                    </span>
                  </div>
                </div>
              )}

              {/* Top Price Drivers — inline below chart */}
              {(() => {
                const agg = new Map<string, number>();
                for (const b of forecastBlocks) {
                  for (const f of b.top_features ?? []) {
                    agg.set(f.feature, (agg.get(f.feature) ?? 0) + f.importance);
                  }
                }
                const sorted = Array.from(agg.entries())
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5);
                const maxVal = sorted[0]?.[1] ?? 1;
                const LABELS: Record<string, string> = {
                  lag_price_1d: "Price 1-day lag",
                  lag_price_7d: "Price 7-day lag",
                  price_momentum: "Price momentum",
                  ema_price: "EMA price (7d)",
                  demand_supply_ratio: "Demand/supply ratio",
                  mcp_lag_1: "Price 1-day lag",
                  mcp_lag_7: "Price 7-day lag",
                  mcp_rolling_mean_3: "3-day rolling avg",
                  mcp_rolling_mean_7: "7-day rolling avg",
                  mcp_rolling_std_7: "7-day price std dev",
                  hour: "Hour of day",
                  block: "Block number",
                  day_of_week: "Day of week",
                  month: "Month",
                  is_weekend: "Weekend flag",
                  demand_mw: "Demand (MW)",
                  supply_mw: "Supply (MW)",
                  renewable_gen_mw: "Renewable gen (MW)",
                  temperature: "Temperature",
                };
                const TOOLTIPS: Record<string, string> = {
                  lag_price_1d: "Yesterday's closing price — strongest single predictor",
                  lag_price_7d: "Price from same block 7 days ago",
                  price_momentum: "Rate of price change over recent days",
                  ema_price: "Exponential moving average of recent prices",
                  demand_supply_ratio: "Ratio of grid demand to available supply",
                  mcp_lag_1: "Yesterday's closing price — strongest single predictor",
                  mcp_lag_7: "Price from same block 7 days ago",
                  hour: "Intraday hour — captures peak/off-peak patterns",
                  block: "15-min block within the day",
                  day_of_week: "Weekday vs weekend demand patterns",
                  month: "Seasonal price patterns by month",
                  is_weekend: "Lower industrial demand on weekends",
                  demand_mw: "Total grid demand in MW",
                  supply_mw: "Available supply in MW",
                  renewable_gen_mw: "Solar/wind contribution affects price",
                  temperature: "Heat/cold drives residential and industrial load",
                };
                if (sorted.length === 0) return null;
                return (
                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
                      Top Price Drivers
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {sorted.map(([feat, val]) => {
                        const pct = (val / maxVal) * 100;
                        const tip = TOOLTIPS[feat];
                        return (
                          <div key={feat} className="group relative flex items-center gap-2">
                            <span className="text-[10px] text-gray-500 w-36 shrink-0 truncate">
                              {LABELS[feat] ?? feat.replace(/_/g, " ")}
                            </span>
                            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden cursor-default">
                              <div
                                className="h-full rounded-full bg-[#006DAE] transition-opacity group-hover:opacity-70"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-gray-400 w-8 text-right tabular-nums">
                              {pct.toFixed(0)}%
                            </span>
                            {tip && (
                              <div className="pointer-events-none absolute left-0 bottom-full mb-1.5 z-20 hidden group-hover:flex">
                                <span className="whitespace-nowrap bg-gray-800 text-white text-[10px] rounded px-2 py-1 shadow-lg">
                                  {tip}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* 96-block grid */}
          {bidRows.length > 0 && (
            <div className="card p-0 overflow-hidden border-2 border-gray-200">
              {/* Enhanced Table header bar */}
              <div className="bg-gradient-to-r from-gray-50 to-gray-100 px-5 py-3 border-b-2 border-gray-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#006DAE] to-[#00B398] text-white flex items-center justify-center font-bold text-sm">
                        96
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-gray-900">
                          Optimized Bid Schedule
                        </h3>
                        <p className="text-xs text-gray-600">
                          {segment} ·{" "}
                          <span className="capitalize">{strategy}</span>{" "}
                          Strategy
                        </p>
                      </div>
                    </div>
                    <span
                      className="text-xs px-3 py-1 rounded-lg font-semibold border-2"
                      style={{
                        color: stratMeta.color,
                        background: `${stratMeta.color}15`,
                        borderColor: `${stratMeta.color}40`,
                      }}
                    >
                      {stratMeta.hint}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    {overrideCount > 0 && (
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-100 border border-amber-300 px-3 py-1 rounded-lg">
                        <svg
                          className="w-3.5 h-3.5"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                        </svg>
                        {overrideCount} Manual Edits
                      </div>
                    )}
                    {violationCount > 0 && (
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-red-700 bg-red-100 border border-red-300 px-3 py-1 rounded-lg">
                        <svg
                          className="w-3.5 h-3.5"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                            clipRule="evenodd"
                          />
                        </svg>
                        {violationCount} Violations
                      </div>
                    )}
                    <div className="flex items-center gap-3 text-xs bg-white border-2 border-gray-300 rounded-lg px-4 py-1.5">
                      <div className="text-right">
                        <div className="text-gray-500 text-[10px]">Total</div>
                        <div className="font-bold text-[#006DAE]">
                          {totalVol.toFixed(1)} MW
                        </div>
                      </div>
                      <div className="w-px h-6 bg-gray-300"></div>
                      <div className="text-right">
                        <div className="text-gray-500 text-[10px]">
                          Avg Price
                        </div>
                        <div className="font-bold text-[#006DAE]">
                          ₹{avgBidPrice.toFixed(3)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Scrollable table */}
              <div className="overflow-y-auto max-h-[480px]">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 z-10 bg-gray-50 border-b border-gray-200">
                    <tr className="text-[10px] text-gray-500 uppercase tracking-wider">
                      <th className="text-left py-2 px-3 font-medium">#</th>
                      <th className="text-left py-2 px-2 font-medium">Time</th>
                      <th className="text-right py-2 px-2 font-medium">
                        Fcst ₹
                      </th>
                      <th className="text-right py-2 px-2 font-medium">
                        CI Band
                      </th>
                      <th className="text-right py-2 px-2 font-medium text-[#006DAE]">
                        Bid ₹
                      </th>
                      <th className="text-right py-2 px-2 font-medium text-[#006DAE]">
                        Vol MW
                      </th>
                      <th className="text-right py-2 px-2 font-medium">
                        DSM Est
                      </th>
                      <th className="text-right py-2 px-2 font-medium">
                        Uncert.
                      </th>
                      <th className="text-center py-2 px-2 font-medium">
                        Status
                      </th>
                      <th className="text-left py-2 px-2 font-medium">
                        Reason
                      </th>
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
                          className={`border-t border-gray-100 transition-colors ${
                            hasViolation
                              ? "bg-red-50"
                              : isEdited
                                ? "bg-amber-50"
                                : idx % 2 === 0
                                  ? "bg-transparent"
                                  : "bg-gray-50/60"
                          } hover:bg-blue-50/40`}
                        >
                          {/* Block # */}
                          <td className="py-1.5 px-3 font-mono font-medium text-gray-500">
                            {b.block}
                          </td>

                          {/* Time */}
                          <td className="py-1.5 px-2 text-gray-500 tabular-nums">
                            {blockToTime(b.block)}
                          </td>

                          {/* Forecast price */}
                          <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">
                            {b.predicted_price.toFixed(3)}
                          </td>

                          {/* CI Band */}
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            <span
                              className={`text-[10px] ${
                                highUncertainty
                                  ? "text-amber-600"
                                  : "text-gray-400"
                              }`}
                            >
                              {b.confidence_low.toFixed(2)}–
                              {b.confidence_high.toFixed(2)}
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
                                  ? "border-red-400 text-red-700 focus:border-red-500"
                                  : isEdited
                                    ? "border-amber-400 text-amber-700 focus:border-amber-500"
                                    : "border-gray-300 text-gray-900 focus:border-[#006DAE]"
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
                                handleCellEdit(
                                  b.block,
                                  "volume_mw",
                                  e.target.value,
                                )
                              }
                              className={`w-16 bg-transparent border-b tabular-nums text-right text-xs focus:outline-none transition-colors ${
                                isEdited
                                  ? "border-amber-400 text-amber-700 focus:border-amber-500"
                                  : "border-gray-300 text-gray-900 focus:border-[#006DAE]"
                              }`}
                            />
                          </td>

                          {/* DSM estimate */}
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            <span
                              className={`text-[10px] ${
                                b.dsm_penalty_estimate > 0
                                  ? "text-red-600"
                                  : "text-gray-400"
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
                                highUncertainty
                                  ? "text-amber-600"
                                  : "text-gray-400"
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
                                            ? {
                                                ...row,
                                                override_reason: reason,
                                              }
                                            : row,
                                        ),
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
                                    onClick={() =>
                                      setEditingReasonBlock(b.block)
                                    }
                                    className="text-[10px] text-amber-600 hover:underline text-left max-w-[100px] truncate"
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
            <div className="card flex flex-col items-center justify-center py-16 gap-2 text-center">
              <p className="text-gray-600 text-sm font-medium">
                Select a date, segment and strategy above
              </p>
              <p className="text-gray-400 text-xs max-w-sm">
                Click{" "}
                <span className="text-[#006DAE] font-medium">1 · Forecast</span>{" "}
                to generate price forecasts, then{" "}
                <span className="text-gray-500 font-medium">2 · Get Bids</span>{" "}
                to produce LP-optimised recommendations.
              </p>
            </div>
          )}

          {forecastBlocks.length > 0 && bidRows.length === 0 && (
            <div className="card flex flex-col items-center justify-center py-10 gap-2 text-center">
              <p className="text-gray-500 text-sm">
                Forecast ready — click{" "}
                <span className="text-[#006DAE] font-medium">2 · Get Bids</span>{" "}
                to generate bid recommendations.
              </p>
            </div>
          )}
        </div>

        {/* ── Right panel: Risk ───────────────────────────────────────── */}
        <div className="w-72 shrink-0 flex flex-col gap-3 sticky top-4">
          {/* Risk metrics card */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-gray-700">
                    Risk Panel
                  </h3>
                </div>
              </div>
              {riskLoading && (
                <span className="text-[10px] text-gray-600 flex items-center gap-1.5 bg-gray-100 border border-gray-300 px-2 py-1 rounded-full">
                  <svg
                    className="animate-spin w-3 h-3"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                  Updating...
                </span>
              )}
            </div>

            {liveRisk ? (
              <>
                {liveRisk.alert_triggered && (
                  <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2">
                    <p className="text-red-600 text-[10px] font-bold uppercase tracking-wider">
                      ⚠ Risk Alert
                    </p>
                    <p className="text-red-600 text-[10px] mt-0.5">
                      {liveRisk.alert_details?.message ??
                        "Exposure exceeds threshold"}
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
                    color={
                      liveRisk.expected_dsm_penalty > 10000
                        ? "#ef4444"
                        : "#00B398"
                    }
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
                    sub={
                      liveRisk.alert_triggered
                        ? "above threshold"
                        : "within limit"
                    }
                  />
                </div>

                <div className="pt-2 border-t border-[var(--border)]">
                  <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                    <span>Exposure vs threshold</span>
                    <span
                      className={
                        liveRisk.alert_triggered
                          ? "text-red-600"
                          : "text-teal-600"
                      }
                    >
                      {((liveRisk.total_exposure / 500000) * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
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
              <div className="py-10 text-center bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
                <div className="w-12 h-12 rounded-full bg-gray-200 mx-auto mb-3 flex items-center justify-center">
                  <svg
                    className="w-6 h-6 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                  </svg>
                </div>
                <p className="text-xs font-medium text-gray-600">
                  {bidRows.length === 0
                    ? "No bids yet"
                    : "Calculating risks..."}
                </p>
                <p className="text-[10px] text-gray-500 mt-1">
                  {bidRows.length === 0
                    ? "Risk metrics will appear after optimization"
                    : "Please wait"}
                </p>
              </div>
            )}
          </div>

          {/* LP Optimizer summary */}
          {bidRows.length > 0 && (
            <div className="card border-2 border-gray-200">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-500 text-white flex items-center justify-center">
                  <svg
                    className="w-4 h-4"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-900">
                    LP Summary
                  </h3>
                  <p className="text-[10px] text-gray-500">
                    Optimization results
                  </p>
                </div>
              </div>
              <div className="space-y-1.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-gray-500">Total volume</span>
                  <span className="text-gray-900 font-medium">
                    {totalVol.toFixed(1)} MW
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Avg bid price</span>
                  <span className="text-gray-900 font-medium">
                    ₹{avgBidPrice.toFixed(3)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">DSM penalty est.</span>
                  <span
                    className={
                      totalDsmEst > 0
                        ? "text-red-600 font-medium"
                        : "text-teal-600 font-medium"
                    }
                  >
                    {totalDsmEst > 0 ? formatINR(totalDsmEst) : "₹0"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Overrides</span>
                  <span
                    className={
                      overrideCount > 0
                        ? "text-amber-600 font-medium"
                        : "text-gray-400"
                    }
                  >
                    {overrideCount} / 96
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Violations</span>
                  <span
                    className={
                      violationCount > 0
                        ? "text-red-600 font-medium"
                        : "text-teal-600 font-medium"
                    }
                  >
                    {violationCount}
                  </span>
                </div>
                <div className="flex justify-between pt-1.5 border-t border-gray-100">
                  <span className="text-gray-400">λ₁ applied</span>
                  <span
                    className={`font-mono text-[10px] font-medium ${lambda1 !== null ? "text-[#006DAE]" : "text-gray-400"}`}
                  >
                    {appliedLambda1.toFixed(3)}
                    {lambda1 !== null ? " ✎" : ""}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">λ₂ applied</span>
                  <span
                    className={`font-mono text-[10px] font-medium ${lambda2 !== null ? "text-[#006DAE]" : "text-gray-400"}`}
                  >
                    {appliedLambda2.toFixed(3)}
                    {lambda2 !== null ? " ✎" : ""}
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
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
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
                    {effectiveLambda1.toFixed(2)}
                    {lambda1 !== null && (
                      <span className="ml-1 text-[8px] text-[#006DAE]">✎</span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>λ₂ (Uncertainty weight)</span>
                  <span style={{ color: stratMeta.color }}>
                    {effectiveLambda2.toFixed(2)}
                    {lambda2 !== null && (
                      <span className="ml-1 text-[8px] text-[#006DAE]">✎</span>
                    )}
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
