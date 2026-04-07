"use client";

import { useState, useEffect, useRef } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  predictPrices,
  predictPricesRange,
  trainModel,
  getLatestForecast,
  exportForecastCsv,
  recommendBids,
  submitBids,
  validateBids,
  assessRisk,
  compareStrategies,
  type TrainConfig,
  type BidOptConfig,
} from "@/lib/api";
import {
  blockToTime,
  SEGMENTS,
  STRATEGIES,
  getTomorrowDate,
  formatINR,
} from "@/lib/utils";

/* ─── Types ──────────────────────────────────────────────────────────── */
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
  strategy: string;
  is_overridden: boolean;
  override_reason: string;
  constraint_violations: any[];
}

const OVERRIDE_REASONS = [
  "Market intelligence",
  "Demand forecast adjustment",
  "Risk mitigation",
  "Regulatory requirement",
  "Manager directive",
  "Other",
];

/* ─── Small helpers ───────────────────────────────────────────────────── */
function NumInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.01,
  className = "",
  tooltip,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  tooltip?: string;
}) {
  return (
    <label className={`flex flex-col gap-0.5 ${className}`}>
      <span className="flex items-center gap-1 text-[10px] text-gray-400 uppercase tracking-wider">
        {label}
        {tooltip && (
          <span className="group relative inline-flex items-center">
            <span className="flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-[9px] font-bold text-gray-400 cursor-help hover:border-gray-500 hover:text-gray-600 leading-none">
              ?
            </span>
            <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-md bg-gray-800 px-2.5 py-2 text-[11px] normal-case font-normal text-white shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed">
              {tooltip}
            </span>
          </span>
        )}
      </span>
      <input
        type="number"
        className="input-field text-xs py-1 w-full"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <span className="relative inline-block w-9 h-5">
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          className={`absolute inset-0 rounded-full transition-colors ${checked ? "bg-[#006DAE]" : "bg-gray-300"}`}
        />
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? "translate-x-4" : ""}`}
        />
      </span>
      <span className="text-xs text-gray-600">{label}</span>
    </label>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-gray-200 rounded-lg">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-600 bg-gray-50 hover:bg-gray-100 transition-colors"
      >
        {title}
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="p-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 bg-white">
          {children}
        </div>
      )}
    </div>
  );
}

/* ─── Default configs ─────────────────────────────────────────────────── */
const DEFAULT_HYPERPARAMS = {
  max_iter: 300,
  max_depth: 8,
  learning_rate: 0.05,
  min_samples_leaf: 10,
  l2_regularization: 0.0,
  max_bins: 255,
  early_stopping: true,
  n_iter_no_change: 10,
  validation_fraction: 0.1,
};
const DEFAULT_TUNING = {
  enabled: false,
  method: "random" as "random" | "grid",
  n_iter: 30,
  cv_folds: 5,
  scoring: "neg_mean_absolute_percentage_error" as const,
};
const DEFAULT_FEATURES = {
  extra_lags: "",
  rolling_windows: "7",
  include_demand_supply_ratio: true,
  include_price_momentum: true,
  include_ema: true,
  ema_span: 7,
};
const RANGE_COLORS = [
  "#006DAE",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#8B5CF6",
  "#EC4899",
  "#14B8A6",
  "#F97316",
];

// Blocks: 1 = 00:15, 24 = 06:00, 25 = 06:15 … 88 = 22:00, 96 = 24:00
const BLOCK_PRESETS: Record<string, [number, number] | null> = {
  all: [1, 96],
  peak: [25, 88], // 06:00–22:00
  morning: [25, 40], // 06:00–10:00
  business: [37, 68], // 09:15–17:00
  evening: [69, 88], // 17:15–22:00
  offpeak: [1, 24], // 00:15–06:00
  next4h: [1, 16], // next 4 hours (RTM near-term)
  next8h: [1, 32], // next 8 hours
  custom: null,
};
const PRESET_LABEL: Record<string, string> = {
  all: "All (1–96)",
  peak: "Peak hours (25–88 · 06:00–22:00)",
  morning: "Morning peak (25–40 · 06:00–10:00)",
  business: "Business hours (37–68 · 09:15–17:00)",
  evening: "Evening peak (69–88 · 17:15–22:00)",
  offpeak: "Off-peak (1–24 · 00:15–06:00)",
  next4h: "Next 4 h (1–16)",
  next8h: "Next 8 h (1–32)",
  custom: "Custom…",
};
const SEGMENT_META: Record<
  string,
  { maxDays: number; defaultRangeDays: number; presets: string[]; hint: string }
> = {
  DAM: {
    maxDays: 14,
    defaultRangeDays: 3,
    presets: [
      "all",
      "peak",
      "morning",
      "business",
      "evening",
      "offpeak",
      "custom",
    ],
    hint: "Day-ahead · bids close 12:00 daily",
  },
  RTM: {
    maxDays: 3,
    defaultRangeDays: 1,
    presets: [
      "all",
      "next4h",
      "next8h",
      "peak",
      "morning",
      "evening",
      "custom",
    ],
    hint: "Real-time · 4-block (1 h) delivery lead",
  },
  TAM: {
    maxDays: 30,
    defaultRangeDays: 7,
    presets: ["all", "peak", "offpeak", "business", "custom"],
    hint: "Term-ahead · week/month horizon",
  },
};
function addDays(date: string, n: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

const DEFAULT_BID_OPT: BidOptConfig & { useOverrides: boolean } = {
  useOverrides: false,
  price_offset: 0.0,
  risk_tolerance: 0.6,
  volume_scale: 1.0,
  per_block_cap_factor: 4.0,
};

/* ═══════════════════════════════════════════════════════════════════════ */
export default function TradingDeskPage() {
  const [tab, setTab] = useState<"forecast" | "bids">("forecast");

  /* ── Shared ── */
  const [segment, setSegment] = useState("DAM");
  const [targetDate, setTargetDate] = useState(getTomorrowDate());

  /* ── Forecast tab ── */
  const [blocks, setBlocks] = useState<ForecastBlock[]>([]);
  const [forecasting, setForecasting] = useState(false);
  const [training, setTraining] = useState(false);
  const [trainResult, setTrainResult] = useState<any>(null);
  const [selectedBlock, setSelectedBlock] = useState<ForecastBlock | null>(
    null,
  );
  const [isStale, setIsStale] = useState(false);
  const [offlineError, setOfflineError] = useState("");

  // Forecast range + block filter state
  const [forecastMode, setForecastMode] = useState<"single" | "range">(
    "single",
  );
  const [dateFrom, setDateFrom] = useState(getTomorrowDate());
  const [dateTo, setDateTo] = useState(() => addDays(getTomorrowDate(), 2));
  const [blockPreset, setBlockPreset] = useState("all");
  const [blockStart, setBlockStart] = useState(1);
  const [blockEnd, setBlockEnd] = useState(96);
  const [rangeResults, setRangeResults] = useState<
    { date: string; blocks: ForecastBlock[] }[]
  >([]);
  const [selectedRangeDate, setSelectedRangeDate] = useState("");

  // Reset block preset + clamp date range when segment changes
  useEffect(() => {
    const meta = SEGMENT_META[segment];
    if (!meta.presets.includes(blockPreset)) {
      setBlockPreset("all");
      setBlockStart(1);
      setBlockEnd(96);
    }
    const maxTo = addDays(dateFrom, meta.maxDays - 1);
    if (dateTo > maxTo) setDateTo(maxTo);
  }, [segment]); // eslint-disable-line react-hooks/exhaustive-deps

  // Train config state
  const [testSize, setTestSize] = useState(0.2);
  const [shuffle, setShuffle] = useState(false);
  const [hp, setHp] = useState({ ...DEFAULT_HYPERPARAMS });
  const [tuning, setTuning] = useState({ ...DEFAULT_TUNING });
  const [features, setFeatures] = useState({ ...DEFAULT_FEATURES });

  /* ── Bids tab ── */
  const [strategy, setStrategy] = useState("balanced");
  const [demandMw, setDemandMw] = useState(500);
  const [bidOpt, setBidOpt] = useState({ ...DEFAULT_BID_OPT });
  const [bids, setBids] = useState<BidRow[]>([]);
  const [bidLoading, setBidLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<any>(null);
  const [validationResult, setValidationResult] = useState<any>(null);
  const [editingBlock, setEditingBlock] = useState<number | null>(null);
  const [liveRisk, setLiveRisk] = useState<any>(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskTimestamp, setRiskTimestamp] = useState("");
  const riskDebounceRef = useRef<NodeJS.Timeout | null>(null);

  /* ── Strategy comparison ── */
  const [strategyCompare, setStrategyCompare] = useState<any>(null);
  const [strategyCompareLoading, setStrategyCompareLoading] = useState(false);

  /* ── Auto risk on bid change ── */
  useEffect(() => {
    if (bids.length === 0) {
      setLiveRisk(null);
      return;
    }
    if (riskDebounceRef.current) clearTimeout(riskDebounceRef.current);
    riskDebounceRef.current = setTimeout(async () => {
      setRiskLoading(true);
      try {
        const r = await assessRisk(
          `live-${Date.now()}`,
          segment,
          bids.map((b) => ({
            block: b.block,
            segment: b.segment,
            price: b.price,
            volume_mw: b.volume_mw,
          })),
        );
        setLiveRisk(r);
        setRiskTimestamp(new Date().toLocaleTimeString());
      } catch {
        /* silent */
      }
      setRiskLoading(false);
    }, 600);
    return () => {
      if (riskDebounceRef.current) clearTimeout(riskDebounceRef.current);
    };
  }, [bids, segment]);

  /* ── Handlers: Forecast ── */
  const handlePredict = async () => {
    setForecasting(true);
    setIsStale(false);
    setOfflineError("");
    setBlocks([]);
    setRangeResults([]);
    try {
      if (forecastMode === "range") {
        const data = await predictPricesRange(
          dateFrom,
          dateTo,
          segment,
          blockStart,
          blockEnd,
        );
        setRangeResults(data.days);
        setSelectedRangeDate(data.days[0]?.date || "");
        setSelectedBlock(data.days[0]?.blocks[0] || null);
      } else {
        const data = await predictPrices(
          targetDate,
          segment,
          blockStart,
          blockEnd,
        );
        setBlocks(data.blocks);
        setSelectedBlock(data.blocks[0]);
      }
    } catch (e: any) {
      if (forecastMode === "single") {
        try {
          const cached = await getLatestForecast(segment);
          setBlocks(cached.blocks);
          setSelectedBlock(cached.blocks[0]);
          setIsStale(true);
          setOfflineError(
            e.response?.data?.detail ||
              "Live forecast unavailable — showing last cached prediction.",
          );
        } catch {
          setOfflineError("Data feed offline. No cached forecasts available.");
        }
      } else {
        setOfflineError(e.response?.data?.detail || "Range forecast failed.");
      }
    }
    setForecasting(false);
  };

  const handleTrain = async () => {
    setTraining(true);
    setTrainResult(null);
    const config: TrainConfig = {
      segment,
      test_size: testSize,
      shuffle,
      hyperparams: { ...hp },
      features: {
        extra_lags: features.extra_lags
          .split(",")
          .map((s) => parseInt(s.trim()))
          .filter((n) => !isNaN(n) && n > 0),
        rolling_windows: features.rolling_windows
          .split(",")
          .map((s) => parseInt(s.trim()))
          .filter((n) => !isNaN(n) && n > 0),
        include_demand_supply_ratio: features.include_demand_supply_ratio,
        include_price_momentum: features.include_price_momentum,
        include_ema: features.include_ema,
        ema_span: features.ema_span,
      },
      tuning: tuning.enabled
        ? {
            method: tuning.method,
            n_iter: tuning.n_iter,
            cv_folds: tuning.cv_folds,
            scoring: tuning.scoring,
            // param_grid intentionally omitted — backend uses its own defaults
          }
        : null,
    };
    try {
      const result = await trainModel(config);
      setTrainResult(result);
    } catch (e: any) {
      alert(e.response?.data?.detail || "Training failed");
    }
    setTraining(false);
  };

  const handleExportCsv = async () => {
    try {
      const blob = await exportForecastCsv(segment);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `forecast_${segment}_${targetDate}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("No forecast data to export.");
    }
  };

  /* ── Handlers: Bids ── */
  const handleRecommend = async () => {
    setBidLoading(true);
    setSubmitResult(null);
    setValidationResult(null);
    try {
      const overrides: BidOptConfig = bidOpt.useOverrides
        ? {
            price_offset: bidOpt.price_offset,
            risk_tolerance: bidOpt.risk_tolerance,
            volume_scale: bidOpt.volume_scale,
            per_block_cap_factor: bidOpt.per_block_cap_factor,
          }
        : {};
      const recs = await recommendBids(
        targetDate,
        strategy,
        segment,
        demandMw,
        overrides,
      );
      setBids(
        recs.map((r: any) => ({
          ...r,
          is_overridden: false,
          override_reason: "",
        })),
      );
    } catch (e: any) {
      alert(
        e.response?.data?.detail ||
          "Failed to generate recommendations. Run forecast first.",
      );
    }
    setBidLoading(false);
  };

  const handleCellEdit = (
    block: number,
    field: "price" | "volume_mw",
    value: string,
  ) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    setBids((prev) =>
      prev.map((b) =>
        b.block === block ? { ...b, [field]: num, is_overridden: true } : b,
      ),
    );
  };

  const handleValidate = async () => {
    try {
      const r = await validateBids(
        targetDate,
        strategy,
        segment,
        bids.map((b) => ({
          block: b.block,
          segment: b.segment,
          price: b.price,
          volume_mw: b.volume_mw,
          is_overridden: b.is_overridden,
          override_reason: b.override_reason || undefined,
        })),
      );
      setValidationResult(r);
    } catch {
      alert("Validation failed");
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const r = await submitBids(
        targetDate,
        strategy,
        segment,
        bids.map((b) => ({
          block: b.block,
          segment: b.segment,
          price: b.price,
          volume_mw: b.volume_mw,
          is_overridden: b.is_overridden,
          override_reason: b.override_reason || undefined,
        })),
      );
      setSubmitResult(r);
    } catch (e: any) {
      alert(e.response?.data?.detail || "Submission failed");
    }
    setSubmitting(false);
  };

  /* ── Derived ── */
  const displayBlocks =
    forecastMode === "range" ? rangeResults.flatMap((r) => r.blocks) : blocks;
  const activeDateBlocks =
    forecastMode === "range"
      ? rangeResults.find((r) => r.date === selectedRangeDate)?.blocks || []
      : blocks;
  const chartData = blocks.map((b) => ({
    block: b.block,
    time: blockToTime(b.block),
    price: b.predicted_price,
    low: b.confidence_low,
    high: b.confidence_high,
  }));
  const rangeChartData =
    rangeResults.length > 0
      ? Array.from({ length: blockEnd - blockStart + 1 }, (_, i) => {
          const block = blockStart + i;
          const row: any = { block, time: blockToTime(block) };
          rangeResults.forEach((day) => {
            const b = day.blocks.find((d) => d.block === block);
            if (b) row[day.date] = b.predicted_price;
          });
          return row;
        })
      : [];
  const peakBlock = displayBlocks.length
    ? displayBlocks.reduce((a, b) =>
        a.predicted_price > b.predicted_price ? a : b,
      )
    : null;
  const minBlock = displayBlocks.length
    ? displayBlocks.reduce((a, b) =>
        a.predicted_price < b.predicted_price ? a : b,
      )
    : null;
  const avgPrice = displayBlocks.length
    ? displayBlocks.reduce((s, b) => s + b.predicted_price, 0) /
      displayBlocks.length
    : 0;
  const totalVolume = bids.reduce((s, b) => s + b.volume_mw, 0);
  const avgBidPrice = bids.length
    ? bids.reduce((s, b) => s + b.price, 0) / bids.length
    : 0;
  const overrideCount = bids.filter((b) => b.is_overridden).length;
  const violationCount = bids.reduce(
    (s, b) => s + (b.constraint_violations?.length || 0),
    0,
  );

  /* ═══ RENDER ════════════════════════════════════════════════════════ */
  return (
    <div className="max-w-7xl mx-auto space-y-4">
      {/* Header + tabs */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Trading Desk</h1>
          <p className="text-gray-500 text-xs mt-0.5">
            Forecast · Train · Optimise · Bid
          </p>
        </div>
        <div className="flex rounded-lg overflow-hidden border border-gray-200 text-sm font-medium">
          {(["forecast", "bids"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-2 transition-colors capitalize ${tab === t ? "bg-[#006DAE] text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
            >
              {t === "forecast" ? "Price Forecast" : "Bid Optimiser"}
            </button>
          ))}
        </div>
      </div>

      {/* Shared controls row — flat siblings so flex-wrap works cleanly */}
      <div className="card flex items-end gap-3 flex-wrap">
        {/* Segment */}
        <div>
          <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
            Segment
          </label>
          <select
            value={segment}
            onChange={(e) => setSegment(e.target.value)}
            className="select-field"
            title={SEGMENT_META[segment].hint}
          >
            {SEGMENTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        {/* Bids tab: just a date picker */}
        {tab === "bids" && (
          <div>
            <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
              Target Date
            </label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="input-field"
            />
          </div>
        )}

        {/* Forecast tab controls — each as a flat sibling */}
        {tab === "forecast" && (
          <div>
            <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
              Mode
            </label>
            <div className="flex rounded-lg overflow-hidden border border-gray-200">
              {(["single", "range"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setForecastMode(m)}
                  className={`px-3 py-2 text-sm transition-colors ${forecastMode === m ? "bg-[#006DAE] text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                >
                  {m === "single" ? "Single Day" : "Date Range"}
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === "forecast" && forecastMode === "single" && (
          <div>
            <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
              Date
            </label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="input-field"
            />
          </div>
        )}

        {tab === "forecast" && forecastMode === "range" && (
          <div>
            <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
              From
            </label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="input-field"
            />
          </div>
        )}

        {tab === "forecast" && forecastMode === "range" && (
          <div>
            <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
              To{" "}
              <span className="normal-case text-gray-300">
                (max {SEGMENT_META[segment].maxDays}d)
              </span>
            </label>
            <input
              type="date"
              value={dateTo}
              max={addDays(dateFrom, SEGMENT_META[segment].maxDays - 1)}
              onChange={(e) => setDateTo(e.target.value)}
              className="input-field"
            />
          </div>
        )}

        {tab === "forecast" && (
          <div>
            <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
              Block Range
            </label>
            <select
              className="select-field"
              value={blockPreset}
              onChange={(e) => {
                setBlockPreset(e.target.value);
                const p = BLOCK_PRESETS[e.target.value];
                if (p) {
                  setBlockStart(p[0]);
                  setBlockEnd(p[1]);
                }
              }}
            >
              {SEGMENT_META[segment].presets.map((key) => (
                <option key={key} value={key}>
                  {PRESET_LABEL[key]}
                </option>
              ))}
            </select>
          </div>
        )}

        {tab === "forecast" && blockPreset === "custom" && (
          <div>
            <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
              From Block
            </label>
            <input
              type="number"
              min={1}
              max={96}
              value={blockStart}
              onChange={(e) =>
                setBlockStart(Math.max(1, Math.min(96, Number(e.target.value))))
              }
              className="input-field w-16"
            />
          </div>
        )}

        {tab === "forecast" && blockPreset === "custom" && (
          <div>
            <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
              To Block
            </label>
            <input
              type="number"
              min={1}
              max={96}
              value={blockEnd}
              onChange={(e) =>
                setBlockEnd(Math.max(1, Math.min(96, Number(e.target.value))))
              }
              className="input-field w-16"
            />
          </div>
        )}

        {tab === "forecast" ? (
          <>
            <button
              onClick={handlePredict}
              disabled={forecasting}
              className="btn-primary"
            >
              {forecasting ? "Forecasting…" : "Generate Forecast"}
            </button>
            <button
              onClick={handleTrain}
              disabled={training}
              className="btn-secondary text-sm"
            >
              {training ? "Training…" : `Train ${segment} Model`}
            </button>
            {blocks.length > 0 && (
              <button
                onClick={handleExportCsv}
                className="btn-secondary text-sm"
              >
                Download CSV
              </button>
            )}
          </>
        ) : (
          <>
            <div>
              <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
                Strategy
              </label>
              <div className="flex rounded-lg overflow-hidden border border-gray-200">
                {STRATEGIES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setStrategy(s)}
                    className={`px-3 py-2 text-sm capitalize transition-colors ${
                      strategy === s
                        ? s === "conservative"
                          ? "bg-green-600 text-white"
                          : s === "balanced"
                            ? "bg-[#006DAE] text-white"
                            : "bg-red-500 text-white"
                        : "bg-white text-gray-500 hover:bg-gray-50"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
                Demand (MW)
              </label>
              <input
                type="number"
                value={demandMw}
                onChange={(e) => setDemandMw(Number(e.target.value))}
                className="input-field w-24"
              />
            </div>
            <button
              onClick={handleRecommend}
              disabled={bidLoading}
              className="btn-primary"
            >
              {bidLoading ? "Optimising…" : "Get AI Recommendations"}
            </button>
          </>
        )}
      </div>

      {/* ─── FORECAST TAB ───────────────────────────────────────────── */}
      {tab === "forecast" && (
        <div className="space-y-4">
          {/* Advanced config */}
          <div className="card space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Model Configuration
            </p>
            <div className="flex items-end gap-6 flex-wrap">
              <div>
                <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
                  Test Size{" "}
                  <span className="normal-case font-normal text-gray-300">
                    (held-out validation)
                  </span>
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0.05}
                    max={0.45}
                    step={0.05}
                    value={testSize}
                    onChange={(e) => setTestSize(Number(e.target.value))}
                    className="w-32 accent-[#006DAE]"
                  />
                  <span className="text-sm font-mono text-[#006DAE] w-10">
                    {Math.round(testSize * 100)}%
                  </span>
                </div>
              </div>
              <div className="flex items-end pb-0.5">
                <Toggle
                  label="Shuffle training data"
                  checked={shuffle}
                  onChange={setShuffle}
                />
              </div>
            </div>
            <Section title="Hyperparameters (HistGradientBoosting)">
              <NumInput
                label="Max Iterations"
                value={hp.max_iter}
                onChange={(v) => setHp((p) => ({ ...p, max_iter: v }))}
                min={50}
                max={5000}
                step={50}
                tooltip="Total number of boosting rounds. More iterations = better fit but slower training. Early stopping will halt before this if validation loss stops improving."
              />
              <NumInput
                label="Max Depth"
                value={hp.max_depth}
                onChange={(v) => setHp((p) => ({ ...p, max_depth: v }))}
                min={2}
                max={30}
                step={1}
                tooltip="Maximum depth of each decision tree. Deeper trees capture more complex patterns but are prone to overfitting. Typical sweet spot: 4–12."
              />
              <NumInput
                label="Learning Rate"
                value={hp.learning_rate}
                onChange={(v) => setHp((p) => ({ ...p, learning_rate: v }))}
                min={0.001}
                max={1}
                step={0.005}
                tooltip="Shrinkage applied to each tree's contribution. Lower values (0.01–0.1) generalise better but require more iterations. Pair with higher max_iter."
              />
              <NumInput
                label="Min Samples Leaf"
                value={hp.min_samples_leaf}
                onChange={(v) => setHp((p) => ({ ...p, min_samples_leaf: v }))}
                min={1}
                max={200}
                step={1}
                tooltip="Minimum number of training samples required in a leaf node. Higher values smooth the model and reduce overfitting on noisy price data."
              />
              <NumInput
                label="L2 Regularisation"
                value={hp.l2_regularization}
                onChange={(v) => setHp((p) => ({ ...p, l2_regularization: v }))}
                min={0}
                max={10}
                step={0.1}
                tooltip="L2 (ridge) penalty on leaf values. Penalises large weights to prevent overfitting. 0 = no penalty; increase if the model overfits historical spikes."
              />
              <NumInput
                label="Max Bins"
                value={hp.max_bins}
                onChange={(v) => setHp((p) => ({ ...p, max_bins: v }))}
                min={10}
                max={255}
                step={5}
                tooltip="Number of bins used to discretise continuous features. More bins = finer splits and higher accuracy, but more memory. 255 is the maximum."
              />
              <NumInput
                label="N Iter No Change"
                value={hp.n_iter_no_change}
                onChange={(v) => setHp((p) => ({ ...p, n_iter_no_change: v }))}
                min={1}
                max={100}
                step={1}
                tooltip="Number of iterations with no improvement on the validation set before early stopping triggers. Only active when Early Stopping is enabled."
              />
              <NumInput
                label="Val Fraction"
                value={hp.validation_fraction}
                onChange={(v) =>
                  setHp((p) => ({ ...p, validation_fraction: v }))
                }
                min={0.05}
                max={0.4}
                step={0.05}
                tooltip="Fraction of training data held out internally for early-stopping validation. Separate from the outer Test Size split. Only used when Early Stopping is on."
              />
              <div className="col-span-2 flex items-center pt-1">
                <Toggle
                  label="Early stopping"
                  checked={hp.early_stopping}
                  onChange={(v) => setHp((p) => ({ ...p, early_stopping: v }))}
                />
              </div>
            </Section>
            <Section title="Feature Engineering">
              <label className="flex flex-col gap-0.5 col-span-2">
                <span className="flex items-center gap-1 text-[10px] text-gray-400 uppercase tracking-wider">
                  Extra Lag Days (comma-separated)
                  <span className="group relative inline-flex items-center">
                    <span className="flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-[9px] font-bold text-gray-400 cursor-help hover:border-gray-500 hover:text-gray-600 leading-none">
                      ?
                    </span>
                    <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-md bg-gray-800 px-2.5 py-2 text-[11px] normal-case font-normal text-white shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed">
                      Additional historical days to use as features. E.g.
                      &quot;2,3,14&quot; adds price from 2, 3, and 14 days ago.
                      The default lag of 1 day (yesterday) is always included.
                      Useful for capturing weekly or fortnightly price cycles.
                    </span>
                  </span>
                </span>
                <input
                  className="input-field text-xs py-1"
                  value={features.extra_lags}
                  placeholder="e.g. 2,3,14"
                  onChange={(e) =>
                    setFeatures((p) => ({ ...p, extra_lags: e.target.value }))
                  }
                />
              </label>
              <label className="flex flex-col gap-0.5 col-span-2">
                <span className="flex items-center gap-1 text-[10px] text-gray-400 uppercase tracking-wider">
                  Rolling Windows (days)
                  <span className="group relative inline-flex items-center">
                    <span className="flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-[9px] font-bold text-gray-400 cursor-help hover:border-gray-500 hover:text-gray-600 leading-none">
                      ?
                    </span>
                    <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-md bg-gray-800 px-2.5 py-2 text-[11px] normal-case font-normal text-white shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed">
                      Window sizes (in days) for rolling mean and std features.
                      E.g. &quot;7,14&quot; adds a 7-day and 14-day rolling
                      average of historical prices. Larger windows smooth out
                      noise; smaller windows capture recent trends.
                    </span>
                  </span>
                </span>
                <input
                  className="input-field text-xs py-1"
                  value={features.rolling_windows}
                  placeholder="e.g. 7,14"
                  onChange={(e) =>
                    setFeatures((p) => ({
                      ...p,
                      rolling_windows: e.target.value,
                    }))
                  }
                />
              </label>
              <NumInput
                label="EMA Span"
                value={features.ema_span}
                onChange={(v) => setFeatures((p) => ({ ...p, ema_span: v }))}
                min={2}
                max={30}
                step={1}
                tooltip="Window size for the exponential moving average feature. Smaller = more reactive to recent prices; larger = smoother trend signal."
              />
              <div className="col-span-3 flex flex-wrap gap-4 items-center pt-1">
                <Toggle
                  label="D/S ratio"
                  checked={features.include_demand_supply_ratio}
                  onChange={(v) =>
                    setFeatures((p) => ({
                      ...p,
                      include_demand_supply_ratio: v,
                    }))
                  }
                />
                <Toggle
                  label="Price momentum"
                  checked={features.include_price_momentum}
                  onChange={(v) =>
                    setFeatures((p) => ({ ...p, include_price_momentum: v }))
                  }
                />
                <Toggle
                  label="EMA"
                  checked={features.include_ema}
                  onChange={(v) =>
                    setFeatures((p) => ({ ...p, include_ema: v }))
                  }
                />
              </div>
            </Section>
            <Section title="Auto-Tuning (Hyperparameter Search)">
              <div className="col-span-4 flex items-center gap-6 pb-1">
                <Toggle
                  label="Enable auto-tuning"
                  checked={tuning.enabled}
                  onChange={(v) => setTuning((p) => ({ ...p, enabled: v }))}
                />
              </div>
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] text-gray-400 uppercase tracking-wider">
                  Method
                </span>
                <select
                  className="select-field text-xs py-1"
                  value={tuning.method}
                  onChange={(e) =>
                    setTuning((p) => ({ ...p, method: e.target.value as any }))
                  }
                >
                  <option value="random">Random Search</option>
                  <option value="grid">Grid Search</option>
                </select>
              </label>
              <NumInput
                label="Iterations"
                value={tuning.n_iter}
                onChange={(v) => setTuning((p) => ({ ...p, n_iter: v }))}
                min={5}
                max={200}
                step={5}
                tooltip="Number of random parameter combinations to evaluate. Higher = better chance of finding the optimum, but much slower. Ignored for Grid Search."
              />
              <NumInput
                label="CV Folds"
                value={tuning.cv_folds}
                onChange={(v) => setTuning((p) => ({ ...p, cv_folds: v }))}
                min={2}
                max={10}
                step={1}
                tooltip="Number of cross-validation folds. More folds = more robust score estimate but proportionally longer run time. 5 is a practical default."
              />
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] text-gray-400 uppercase tracking-wider">
                  Scoring
                </span>
                <select
                  className="select-field text-xs py-1"
                  value={tuning.scoring}
                  onChange={(e) =>
                    setTuning((p) => ({ ...p, scoring: e.target.value as any }))
                  }
                >
                  <option value="neg_mean_absolute_percentage_error">
                    MAPE
                  </option>
                  <option value="neg_mean_squared_error">MSE</option>
                  <option value="r2">R²</option>
                </select>
              </label>
            </Section>
          </div>

          {trainResult && (
            <div className="card bg-green-50 border-green-200">
              <p className="text-green-700 text-sm font-medium">
                Model trained — MAPE: {trainResult.metrics?.mape}% · Train:{" "}
                {trainResult.metrics?.train_size?.toLocaleString()} · Test:{" "}
                {trainResult.metrics?.test_size?.toLocaleString()}
              </p>
            </div>
          )}

          {offlineError && (
            <div
              className={`card ${isStale ? "bg-yellow-50 border-yellow-200" : "bg-red-50 border-red-200"}`}
            >
              <p
                className={`text-sm font-medium ${isStale ? "text-yellow-700" : "text-red-700"}`}
              >
                {offlineError}
              </p>
            </div>
          )}

          {blocks.length > 0 && (
            <>
              <div className="grid grid-cols-4 gap-3">
                {[
                  {
                    label: "Avg Price",
                    val: `₹${avgPrice.toFixed(2)}`,
                    color: "text-[#006DAE]",
                  },
                  {
                    label: "Peak",
                    val: `₹${peakBlock?.predicted_price.toFixed(2)}`,
                    sub: `Block ${peakBlock?.block}`,
                    color: "text-red-500",
                  },
                  {
                    label: "Trough",
                    val: `₹${minBlock?.predicted_price.toFixed(2)}`,
                    sub: `Block ${minBlock?.block}`,
                    color: "text-green-600",
                  },
                  {
                    label: "Avg Volatility",
                    val: displayBlocks.length
                      ? `₹${(displayBlocks.reduce((s, b) => s + b.volatility, 0) / displayBlocks.length).toFixed(3)}`
                      : "—",
                    color: "text-amber-500",
                  },
                ].map(({ label, val, sub, color }) => (
                  <div key={label} className="card text-center py-3">
                    <div className="text-[10px] text-gray-400 uppercase tracking-wider">
                      {label}
                    </div>
                    <div className={`text-xl font-bold ${color}`}>{val}</div>
                    {sub && (
                      <div className="text-[10px] text-gray-400">{sub}</div>
                    )}
                  </div>
                ))}
              </div>

              <div className="card">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">
                  Price Forecast — {segment} —{" "}
                  {forecastMode === "range"
                    ? `${dateFrom} → ${dateTo}`
                    : targetDate}
                  {(blockStart > 1 || blockEnd < 96) && (
                    <span className="ml-2 font-normal normal-case text-gray-400">
                      Blocks {blockStart}–{blockEnd} ({blockToTime(blockStart)}–
                      {blockToTime(blockEnd)})
                    </span>
                  )}
                </h2>
                {forecastMode === "single" ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient
                          id="confGrad"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="5%"
                            stopColor="#006DAE"
                            stopOpacity={0.15}
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
                        stroke="#F1F5F9"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="time"
                        stroke="#D1D5DB"
                        fontSize={9}
                        interval={7}
                        tick={{ fill: "#9CA3AF" }}
                        tickLine={false}
                      />
                      <YAxis
                        stroke="#D1D5DB"
                        fontSize={9}
                        tick={{ fill: "#9CA3AF" }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v) => `₹${v}`}
                        width={40}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "#fff",
                          border: "1px solid #E2E8F0",
                          borderRadius: "8px",
                          fontSize: "11px",
                        }}
                        formatter={(v: number) => `₹${v.toFixed(3)}`}
                      />
                      <Legend wrapperStyle={{ fontSize: "10px" }} />
                      <Area
                        type="monotone"
                        dataKey="high"
                        stroke="transparent"
                        fill="url(#confGrad)"
                        name="CI High"
                        legendType="none"
                      />
                      <Area
                        type="monotone"
                        dataKey="low"
                        stroke="transparent"
                        fill="#fff"
                        name="CI Low"
                        legendType="none"
                      />
                      <Area
                        type="monotone"
                        dataKey="price"
                        stroke="#006DAE"
                        strokeWidth={2}
                        fill="url(#confGrad)"
                        dot={false}
                        name="Predicted Price"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={rangeChartData}>
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="#F1F5F9"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="time"
                        stroke="#D1D5DB"
                        fontSize={9}
                        interval={Math.max(
                          1,
                          Math.floor((blockEnd - blockStart) / 8),
                        )}
                        tick={{ fill: "#9CA3AF" }}
                        tickLine={false}
                      />
                      <YAxis
                        stroke="#D1D5DB"
                        fontSize={9}
                        tick={{ fill: "#9CA3AF" }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v) => `₹${v}`}
                        width={40}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "#fff",
                          border: "1px solid #E2E8F0",
                          borderRadius: "8px",
                          fontSize: "11px",
                        }}
                        formatter={(v: number) => `₹${v.toFixed(3)}`}
                      />
                      <Legend wrapperStyle={{ fontSize: "10px" }} />
                      {rangeResults.map((day, i) => (
                        <Line
                          key={day.date}
                          type="monotone"
                          dataKey={day.date}
                          stroke={RANGE_COLORS[i % RANGE_COLORS.length]}
                          strokeWidth={1.5}
                          dot={false}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2 card">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      Block Details
                    </h2>
                    {forecastMode === "range" && rangeResults.length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {rangeResults.map((r) => (
                          <button
                            key={r.date}
                            onClick={() => setSelectedRangeDate(r.date)}
                            className={`text-[10px] px-2 py-0.5 rounded transition-colors ${selectedRangeDate === r.date ? "bg-[#006DAE] text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                          >
                            {r.date}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="text-gray-400 sticky top-0 bg-white">
                        <tr>
                          {[
                            "Block",
                            "Time",
                            "Price",
                            "Low",
                            "High",
                            "Volatility",
                          ].map((h) => (
                            <th
                              key={h}
                              className={`py-1.5 px-2 ${h !== "Block" && h !== "Time" ? "text-right" : "text-left"}`}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {activeDateBlocks.map((b) => (
                          <tr
                            key={b.block}
                            onClick={() => setSelectedBlock(b)}
                            className={`cursor-pointer border-t border-gray-100 transition-colors ${selectedBlock?.block === b.block ? "bg-blue-50" : "hover:bg-gray-50"}`}
                          >
                            <td className="py-1 px-2">{b.block}</td>
                            <td className="py-1 px-2 text-gray-400">
                              {blockToTime(b.block)}
                            </td>
                            <td className="py-1 px-2 text-right font-medium text-gray-800">
                              ₹{b.predicted_price.toFixed(3)}
                            </td>
                            <td className="py-1 px-2 text-right text-gray-400">
                              ₹{b.confidence_low.toFixed(3)}
                            </td>
                            <td className="py-1 px-2 text-right text-gray-400">
                              ₹{b.confidence_high.toFixed(3)}
                            </td>
                            <td className="py-1 px-2 text-right text-amber-500">
                              {b.volatility.toFixed(4)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="card">
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                    Feature Importance — Block {selectedBlock?.block}
                  </h2>
                  {selectedBlock?.top_features.map((f) => (
                    <div key={f.feature} className="mb-3">
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-gray-600">{f.feature}</span>
                        <span className="text-[#006DAE] font-medium">
                          {(f.importance * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-1.5">
                        <div
                          className="bg-[#006DAE] h-1.5 rounded-full"
                          style={{
                            width: `${Math.min(f.importance * 100 * 3, 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── BIDS TAB ───────────────────────────────────────────────── */}
      {tab === "bids" && (
        <div className="space-y-4">
          {/* LP override config */}
          <div className="card space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                LP Optimiser Overrides
              </p>
              <Toggle
                label="Override strategy defaults"
                checked={bidOpt.useOverrides}
                onChange={(v) => setBidOpt((p) => ({ ...p, useOverrides: v }))}
              />
            </div>
            {bidOpt.useOverrides && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                <div>
                  <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
                    Price Offset{" "}
                    <span className="normal-case text-gray-300">
                      (pred ± offset×vol)
                    </span>
                  </label>
                  <input
                    type="range"
                    min={-3}
                    max={3}
                    step={0.1}
                    value={bidOpt.price_offset ?? 0}
                    onChange={(e) =>
                      setBidOpt((p) => ({
                        ...p,
                        price_offset: Number(e.target.value),
                      }))
                    }
                    className="w-full accent-[#006DAE]"
                  />
                  <div className="text-center text-xs font-mono text-[#006DAE]">
                    {(bidOpt.price_offset ?? 0).toFixed(1)}
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
                    Risk Tolerance{" "}
                    <span className="normal-case text-gray-300">
                      (0=safe, 1=aggressive)
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={bidOpt.risk_tolerance ?? 0.6}
                    onChange={(e) =>
                      setBidOpt((p) => ({
                        ...p,
                        risk_tolerance: Number(e.target.value),
                      }))
                    }
                    className="w-full accent-[#006DAE]"
                  />
                  <div className="text-center text-xs font-mono text-[#006DAE]">
                    {(bidOpt.risk_tolerance ?? 0.6).toFixed(2)}
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
                    Volume Scale{" "}
                    <span className="normal-case text-gray-300">
                      (mult of demand_mw)
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0.1}
                    max={2}
                    step={0.05}
                    value={bidOpt.volume_scale ?? 1}
                    onChange={(e) =>
                      setBidOpt((p) => ({
                        ...p,
                        volume_scale: Number(e.target.value),
                      }))
                    }
                    className="w-full accent-[#006DAE]"
                  />
                  <div className="text-center text-xs font-mono text-[#006DAE]">
                    {(bidOpt.volume_scale ?? 1).toFixed(2)}×
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">
                    Block Cap Factor{" "}
                    <span className="normal-case text-gray-300">
                      (max vol per block)
                    </span>
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    step={0.5}
                    value={bidOpt.per_block_cap_factor ?? 4}
                    onChange={(e) =>
                      setBidOpt((p) => ({
                        ...p,
                        per_block_cap_factor: Number(e.target.value),
                      }))
                    }
                    className="w-full accent-[#006DAE]"
                  />
                  <div className="text-center text-xs font-mono text-[#006DAE]">
                    {(bidOpt.per_block_cap_factor ?? 4).toFixed(1)}×
                  </div>
                </div>
              </div>
            )}
            {!bidOpt.useOverrides && (
              <p className="text-xs text-gray-400">
                Using{" "}
                <span className="font-medium text-gray-600 capitalize">
                  {strategy}
                </span>{" "}
                profile defaults: price_offset ={" "}
                {strategy === "conservative"
                  ? "−0.8"
                  : strategy === "balanced"
                    ? "0.0"
                    : "+0.6"}
                , risk_tolerance ={" "}
                {strategy === "conservative"
                  ? "0.3"
                  : strategy === "balanced"
                    ? "0.6"
                    : "0.9"}
                , volume_scale ={" "}
                {strategy === "conservative"
                  ? "0.85"
                  : strategy === "balanced"
                    ? "1.0"
                    : "1.15"}
              </p>
            )}
          </div>

          {submitResult && (
            <div
              className={`card ${submitResult.status === "submitted" ? "bg-green-50 border-green-200" : "bg-yellow-50 border-yellow-200"}`}
            >
              <p
                className={`text-sm font-medium ${submitResult.status === "submitted" ? "text-green-700" : "text-yellow-700"}`}
              >
                Bids {submitResult.status} · Session: {submitResult.session_id}{" "}
                · {submitResult.bid_count} bids ·{" "}
                {submitResult.violations?.length || 0} violations
              </p>
            </div>
          )}

          {validationResult && (
            <div
              className={`card ${validationResult.valid ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}
            >
              <p
                className={`text-sm font-medium ${validationResult.valid ? "text-green-700" : "text-red-700"}`}
              >
                {validationResult.valid
                  ? "All bids pass constraint validation"
                  : `${validationResult.violation_count} constraint violation(s) found`}
              </p>
            </div>
          )}

          {bids.length > 0 && (
            <>
              <div className="grid grid-cols-4 gap-3">
                {[
                  {
                    label: "Total Volume",
                    val: `${totalVolume.toFixed(1)} MW`,
                    color: "text-gray-800",
                  },
                  {
                    label: "Avg Bid Price",
                    val: `₹${avgBidPrice.toFixed(3)}`,
                    color: "text-[#006DAE]",
                  },
                  {
                    label: "Overrides",
                    val: String(overrideCount),
                    color: "text-amber-500",
                  },
                  {
                    label: "Violations",
                    val: String(violationCount),
                    color:
                      violationCount > 0 ? "text-red-500" : "text-green-600",
                  },
                ].map(({ label, val, color }) => (
                  <div key={label} className="card text-center py-3">
                    <div className="text-[10px] text-gray-400 uppercase tracking-wider">
                      {label}
                    </div>
                    <div className={`text-xl font-bold ${color}`}>{val}</div>
                  </div>
                ))}
              </div>

              <div className="card">
                <div className="flex justify-between items-center mb-3">
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Bid Table · {segment} · {strategy}
                  </h2>
                  <div className="flex gap-2">
                    <button
                      onClick={handleValidate}
                      className="btn-secondary text-xs"
                    >
                      Validate
                    </button>
                    <button
                      onClick={handleSubmit}
                      disabled={submitting}
                      className="btn-primary text-xs"
                    >
                      {submitting ? "Submitting…" : "Submit Bids"}
                    </button>
                  </div>
                </div>
                <div className="max-h-[480px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="text-gray-400 sticky top-0 bg-white z-10">
                      <tr>
                        {[
                          "Block",
                          "Time",
                          "Price (₹/kWh)",
                          "Volume (MW)",
                          "Status",
                          "Override Reason",
                        ].map((h, i) => (
                          <th
                            key={h}
                            className={`py-2 px-2 ${i >= 2 ? "text-right" : "text-left"} ${i === 3 ? "text-center" : ""}`}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {bids.map((b) => {
                        const hasViol = b.constraint_violations?.length > 0;
                        return (
                          <tr
                            key={b.block}
                            className={`border-t border-gray-100 ${hasViol ? "bg-red-50" : ""}`}
                          >
                            <td className="py-1.5 px-2 font-medium">
                              {b.block}
                            </td>
                            <td className="py-1.5 px-2 text-gray-400">
                              {blockToTime(b.block)}
                            </td>
                            <td className="py-1.5 px-2 text-right">
                              <input
                                type="number"
                                step="0.001"
                                value={b.price}
                                onChange={(e) =>
                                  handleCellEdit(
                                    b.block,
                                    "price",
                                    e.target.value,
                                  )
                                }
                                className={`w-20 bg-transparent border-b text-right focus:outline-none focus:border-[#006DAE] ${hasViol ? "border-red-400 text-red-500" : b.is_overridden ? "border-amber-400 text-amber-600" : "border-gray-200 text-gray-800"}`}
                              />
                            </td>
                            <td className="py-1.5 px-2 text-right">
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
                                className={`w-20 bg-transparent border-b text-right focus:outline-none focus:border-[#006DAE] ${b.is_overridden ? "border-amber-400 text-amber-600" : "border-gray-200 text-gray-800"}`}
                              />
                            </td>
                            <td className="py-1.5 px-2 text-center">
                              {hasViol ? (
                                <span
                                  className="text-[10px] bg-red-100 text-red-600 border border-red-200 px-1.5 py-0.5 rounded cursor-help"
                                  title={b.constraint_violations
                                    .map((v: any) => v.message)
                                    .join("; ")}
                                >
                                  ⚠ Violation
                                </span>
                              ) : b.is_overridden ? (
                                <span className="text-[10px] bg-amber-50 text-amber-600 border border-amber-200 px-1.5 py-0.5 rounded">
                                  Edited
                                </span>
                              ) : (
                                <span className="text-[10px] bg-blue-50 text-[#006DAE] border border-blue-200 px-1.5 py-0.5 rounded">
                                  AI
                                </span>
                              )}
                            </td>
                            <td className="py-1.5 px-2">
                              {b.is_overridden &&
                                (editingBlock === b.block ? (
                                  <select
                                    className="select-field text-xs py-0.5"
                                    value={b.override_reason}
                                    autoFocus
                                    onBlur={() => setEditingBlock(null)}
                                    onChange={(e) => {
                                      setBids((prev) =>
                                        prev.map((r) =>
                                          r.block === b.block
                                            ? {
                                                ...r,
                                                override_reason: e.target.value,
                                              }
                                            : r,
                                        ),
                                      );
                                      setEditingBlock(null);
                                    }}
                                  >
                                    <option value="">Select reason…</option>
                                    {OVERRIDE_REASONS.map((r) => (
                                      <option key={r} value={r}>
                                        {r}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <button
                                    onClick={() => setEditingBlock(b.block)}
                                    className="text-xs text-amber-500 hover:underline"
                                  >
                                    {b.override_reason || "Add reason…"}
                                  </button>
                                ))}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {liveRisk && (
                <>
                  {liveRisk.alert_triggered && (
                    <div className="card bg-red-50 border-red-300 animate-pulse">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">🚨</span>
                        <div>
                          <h3 className="text-red-600 font-bold text-sm">
                            RISK ALERT
                          </h3>
                          <p className="text-red-500 text-xs">
                            {liveRisk.alert_details?.message}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="card">
                    <div className="flex justify-between items-center mb-3">
                      <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        Live Risk Assessment
                      </h2>
                      <span className="text-[10px] text-gray-400">
                        {riskLoading
                          ? "Recalculating…"
                          : `Updated ${riskTimestamp}`}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-3">
                      {[
                        {
                          label: "VaR (95%)",
                          val: formatINR(liveRisk.var_95),
                          color: "text-[#006DAE]",
                        },
                        {
                          label: "DSM Penalty",
                          val: formatINR(liveRisk.expected_dsm_penalty),
                          color: "text-amber-500",
                        },
                        {
                          label: "Worst Case",
                          val: formatINR(liveRisk.worst_case_penalty),
                          color: "text-red-500",
                        },
                        {
                          label: "Total Exposure",
                          val: formatINR(liveRisk.total_exposure),
                          color: liveRisk.alert_triggered
                            ? "text-red-500"
                            : "text-green-600",
                        },
                      ].map(({ label, val, color }) => (
                        <div key={label} className="text-center">
                          <div className="text-[10px] text-gray-400 uppercase tracking-wider">
                            {label}
                          </div>
                          <div className={`text-lg font-bold ${color}`}>
                            {val}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {/* ── Strategy Comparison ──────────────────────────────────── */}
          <div className="card space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Strategy Comparison
              </p>
              <button
                className="btn-secondary text-sm"
                disabled={strategyCompareLoading}
                onClick={async () => {
                  setStrategyCompareLoading(true);
                  try {
                    const res = await compareStrategies(targetDate, segment, demandMw);
                    setStrategyCompare(res);
                  } catch (e: any) {
                    alert(e.response?.data?.detail || "Strategy comparison failed");
                  }
                  setStrategyCompareLoading(false);
                }}
              >
                {strategyCompareLoading ? "Comparing…" : "Compare All Strategies"}
              </button>
            </div>

            {strategyCompare && (
              <div className="space-y-4">
                {!strategyCompare.has_actuals && (
                  <p className="text-xs text-amber-500">
                    No actual prices for {strategyCompare.target_date} — showing bid-side metrics only. Clearing simulation will appear once actuals are available.
                  </p>
                )}

                {/* KPI Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-400">
                        <th className="text-left py-2 pr-4">Metric</th>
                        {strategyCompare.strategies.map((s: any) => (
                          <th
                            key={s.strategy}
                            className={`text-right py-2 px-3 capitalize ${
                              s.strategy === "conservative"
                                ? "text-green-600"
                                : s.strategy === "balanced"
                                  ? "text-[#006DAE]"
                                  : "text-red-500"
                            }`}
                          >
                            {s.strategy}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="text-gray-600">
                      {[
                        { label: "Avg Bid Price (₹/kWh)", key: "avg_bid_price", fmt: (v: number) => `₹${v.toFixed(2)}` },
                        { label: "Total Volume (MW)", key: "total_volume_mw", fmt: (v: number) => v.toLocaleString() },
                        { label: "Total Bid Value (₹)", key: "total_bid_value", fmt: (v: number) => formatINR(v) },
                        { label: "Est. DSM Penalty (₹)", key: "estimated_dsm_penalty", fmt: (v: number) => formatINR(v) },
                        { label: "Constraint Violations", key: "violation_count", fmt: (v: number) => String(v) },
                        ...(strategyCompare.has_actuals
                          ? [
                              { label: "Hit Rate", key: "hit_rate", fmt: (v: number) => `${v.toFixed(1)}%` },
                              { label: "Basket Rate (₹/kWh)", key: "basket_rate", fmt: (v: number) => `₹${v.toFixed(2)}` },
                              { label: "vs Baseline", key: "basket_rate_change_pct", fmt: (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%` },
                              { label: "Cost Savings (₹)", key: "cost_savings", fmt: (v: number) => (v != null ? formatINR(v) : "—") },
                            ]
                          : []),
                      ].map(({ label, key, fmt }) => (
                        <tr key={key} className="border-b border-gray-100">
                          <td className="py-1.5 pr-4 text-gray-400">{label}</td>
                          {strategyCompare.strategies.map((s: any) => {
                            const val = s[key];
                            const isBest =
                              key === "estimated_dsm_penalty" || key === "violation_count"
                                ? val === Math.min(...strategyCompare.strategies.map((x: any) => x[key]))
                                : key === "hit_rate" || key === "cost_savings"
                                  ? val === Math.max(...strategyCompare.strategies.map((x: any) => x[key] ?? -Infinity))
                                  : false;
                            return (
                              <td
                                key={s.strategy}
                                className={`text-right py-1.5 px-3 font-mono ${isBest ? "font-semibold text-green-600" : ""}`}
                              >
                                {fmt(val)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Visual comparison bars */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {strategyCompare.strategies.map((s: any) => {
                    const color =
                      s.strategy === "conservative"
                        ? "bg-green-500"
                        : s.strategy === "balanced"
                          ? "bg-[#006DAE]"
                          : "bg-red-500";
                    const borderColor =
                      s.strategy === "conservative"
                        ? "border-green-200"
                        : s.strategy === "balanced"
                          ? "border-blue-200"
                          : "border-red-200";
                    const maxVol = Math.max(
                      ...strategyCompare.strategies.map((x: any) => x.total_volume_mw),
                    );
                    const maxPenalty = Math.max(
                      ...strategyCompare.strategies.map((x: any) => x.estimated_dsm_penalty),
                      1,
                    );
                    return (
                      <div
                        key={s.strategy}
                        className={`border ${borderColor} rounded-lg p-3 space-y-2`}
                      >
                        <p className={`text-xs font-semibold uppercase tracking-wider capitalize ${
                          s.strategy === "conservative"
                            ? "text-green-600"
                            : s.strategy === "balanced"
                              ? "text-[#006DAE]"
                              : "text-red-500"
                        }`}>
                          {s.strategy}
                        </p>
                        <div>
                          <div className="flex justify-between text-[10px] text-gray-400 mb-0.5">
                            <span>Volume</span>
                            <span>{s.total_volume_mw.toLocaleString()} MW</span>
                          </div>
                          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full ${color} rounded-full transition-all`}
                              style={{ width: `${(s.total_volume_mw / maxVol) * 100}%` }}
                            />
                          </div>
                        </div>
                        <div>
                          <div className="flex justify-between text-[10px] text-gray-400 mb-0.5">
                            <span>DSM Penalty</span>
                            <span>{formatINR(s.estimated_dsm_penalty)}</span>
                          </div>
                          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-amber-400 rounded-full transition-all"
                              style={{ width: `${(s.estimated_dsm_penalty / maxPenalty) * 100}%` }}
                            />
                          </div>
                        </div>
                        {strategyCompare.has_actuals && (
                          <div className="flex justify-between text-xs pt-1 border-t border-gray-100">
                            <span className="text-gray-400">Hit Rate</span>
                            <span className="font-semibold">{s.hit_rate.toFixed(1)}%</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
