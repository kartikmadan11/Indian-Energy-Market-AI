"use client";

import { useState } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from "recharts";
import { evaluateForecast } from "@/lib/api";
import { SEGMENTS, blockToTime, formatINR } from "@/lib/utils";

/* ── helpers ─────────────────────────────────────────────────────────── */
function getPastDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

function gradeColor(mape: number) {
  if (mape < 3) return "text-green-600";
  if (mape < 6) return "text-blue-700";
  if (mape < 10) return "text-amber-600";
  return "text-red-600";
}

function gradeLabel(mape: number) {
  if (mape < 3) return "Excellent";
  if (mape < 6) return "Good";
  if (mape < 10) return "Fair";
  return "Weak";
}

function getMapeTooltip(mape: number): string {
  if (mape < 3)
    return "Excellent (< 3%) — Model predicts IEX clearing prices within 3% on average. At this accuracy, bid prices closely track actuals, keeping you well within the CERC ±10% DSM deviation band across nearly all blocks.";
  if (mape < 6)
    return "Good (3–6%) — Average error is low enough for balanced and conservative bid strategies. Occasional DSM band breaches possible in volatile off-peak or RTM spike blocks.";
  if (mape < 10)
    return "Fair (6–10%) — Model underperforms on volatile sessions. Consider retraining with a larger window or enabling hyperparameter tuning. Some blocks may breach the DSM 10% band.";
  return "Weak (> 10%) — High systematic error. Bids placed at predicted prices risk exceeding DSM deviation thresholds, increasing penalty exposure. Retrain before live use.";
}

function getMaeTooltip(mae: number): string {
  if (mae < 0.3)
    return `Excellent (< ₹0.30/kWh) — At typical IEX DAM prices of ₹3–9/kWh, this represents < 5% absolute deviation per block. Bid prices will be highly accurate.`;
  if (mae < 0.8)
    return `Good (₹0.30–0.80/kWh) — Within acceptable range for most bid strategy profiles. Balanced and conservative strategies can rely on these predictions confidently.`;
  if (mae < 1.5)
    return `Moderate (₹0.80–1.50/kWh) — Noticeable bid price error. For blocks near the DSM ceiling (₹12/kWh) or floor (₹0), mispricing could cause clearing failures or excess deviations.`;
  return `High (> ₹1.50/kWh) — Significant price miscalculation. Predicted bid prices deviate from actuals by over ₹1.50/kWh on average — conservative bidding strategy is strongly recommended.`;
}

function getRmseTooltip(rmse: number): string {
  if (rmse < 0.5)
    return "Excellent (< ₹0.50/kWh) — Very consistent predictions with few outlier blocks. Confidence intervals will be tight, enabling precise LP-based volume allocation.";
  if (rmse < 1.5)
    return "Good (₹0.50–1.50/kWh) — Acceptable for next-day DAM bidding. Some blocks may show higher error but the average is manageable.";
  if (rmse < 3.0)
    return "Moderate (₹1.50–3.00/kWh) — Elevated RMSE suggests difficulty at peak/off-peak transitions (blocks 28–40, 72–84). Review block-level drill-down to identify worst performing blocks.";
  return "High (> ₹3.00/kWh) — High variance in prediction errors. Certain blocks are significantly over/underpredicted, which can cascade into large DSM penalty exposure across an entire session.";
}

function getR2Tooltip(r2: number): string {
  if (r2 >= 0.98)
    return "Excellent (≥ 0.98) — Model explains 98%+ of IEX price variance. Predictions closely track real clearing price movements including intraday cycles and demand-supply patterns.";
  if (r2 >= 0.95)
    return "Good (0.95–0.98) — Strong predictive power. Reliable for all three bid strategy profiles (conservative, balanced, aggressive).";
  if (r2 >= 0.9)
    return "Fair (0.90–0.95) — Model captures most price trends but may miss intraday volatility spikes. Recommended to use conservative strategy to absorb unexplained variance.";
  return "Weak (< 0.90) — Price movements are poorly explained. Large unexplained variance increases DSM penalty risk. Consider retraining with more data or additional features (weather, renewable gen).";
}

interface DayResult {
  date: string;
  data_split: "train" | "test" | "unseen";
  mape: number;
  mae: number;
  rmse: number;
  avg_predicted: number;
  avg_actual: number;
  blocks: {
    block: number;
    predicted: number;
    actual: number;
    error_pct: number;
  }[];
}

/* ── KPI card ────────────────────────────────────────────────────────── */
function KpiCard({
  label,
  value,
  sub,
  colorClass,
  tooltip,
}: {
  label: string;
  value: string;
  sub?: string;
  colorClass?: string;
  tooltip?: string;
}) {
  return (
    <div className="card p-4">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 flex items-center gap-1">
        {label}
        {tooltip && (
          <span className="group relative inline-flex items-center">
            <span className="flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-400 text-[9px] font-bold text-gray-400 cursor-help hover:border-gray-600 hover:text-gray-600 leading-none">
              ?
            </span>
            <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 rounded-md bg-gray-800 px-2.5 py-2 text-[11px] normal-case font-normal text-white shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed">
              {tooltip}
            </span>
          </span>
        )}
      </p>
      <p className={`text-2xl font-bold ${colorClass ?? "text-gray-900"}`}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

/* ── custom tooltip for 96-block chart ──────────────────────────────── */
function BlockTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-gray-900 border border-gray-700 rounded p-2 text-xs space-y-0.5">
      <p className="text-gray-300 font-medium">{blockToTime(d.block)}</p>
      <p className="text-blue-400">Predicted ₹{d.predicted?.toFixed(3)}</p>
      <p className="text-emerald-400">Actual ₹{d.actual?.toFixed(3)}</p>
      <p className={d.error_pct > 5 ? "text-red-400" : "text-gray-400"}>
        Error {d.error_pct?.toFixed(2)}%
      </p>
    </div>
  );
}

/* ── main page ───────────────────────────────────────────────────────── */
export default function BacktestPage() {
  const [segment, setSegment] = useState("DAM");
  const [startDate, setStartDate] = useState(getPastDate(17));
  const [endDate, setEndDate] = useState(getPastDate(3));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [error, setError] = useState<string>("");

  const handleRun = async () => {
    setLoading(true);
    setError("");
    setResult(null);
    setSelectedDate("");
    try {
      const data = await evaluateForecast(startDate, endDate, segment);
      setResult(data);
      if (data.daily?.length) setSelectedDate(data.daily[0].date);
    } catch (e: any) {
      setError(
        e.response?.data?.detail ||
          "Evaluation failed. Check that a model is trained and actuals exist for the date range.",
      );
    } finally {
      setLoading(false);
    }
  };

  const selectedDay: DayResult | undefined = result?.daily?.find(
    (d: DayResult) => d.date === selectedDate,
  );

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Backtest</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          Run the trained model over historical dates and measure prediction
          accuracy against real actuals — no data leakage.
        </p>
      </div>

      {/* Controls */}
      <div className="card p-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider">
            Segment
          </span>
          <select
            id="bt-segment"
            name="bt-segment"
            className="input-field text-xs"
            value={segment}
            onChange={(e) => setSegment(e.target.value)}
          >
            {SEGMENTS.map((s) => (
              <option id={s} key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider">
            Start Date
          </span>
          <input
            id="bt-start-date"
            name="bt-start-date"
            type="date"
            className="input-field text-xs h-8"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider">
            End Date
          </span>
          <input
            id="bt-end-date"
            name="bt-end-date"
            type="date"
            className="input-field text-xs h-8"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </label>

        <button
          className="btn-primary h-8 px-5 text-xs"
          onClick={handleRun}
          disabled={loading}
        >
          {loading ? "Running…" : "Run Backtest"}
        </button>

        {result && !loading && (
          <span className="text-[11px] text-gray-500 self-end mb-1.5">
            {result.days_evaluated} day{result.days_evaluated !== 1 ? "s" : ""}{" "}
            evaluated
          </span>
        )}
      </div>

      {error && (
        <div className="card p-4 border border-red-700 text-red-400 text-sm">
          {error}
        </div>
      )}

      {result &&
        (() => {
          const trainDays = result.daily.filter(
            (d: DayResult) => d.data_split === "train",
          ).length;
          const testDays = result.daily.filter(
            (d: DayResult) => d.data_split === "test",
          ).length;
          const unseenDays = result.daily.filter(
            (d: DayResult) => d.data_split === "unseen",
          ).length;
          const allTrain = trainDays > 0 && testDays === 0 && unseenDays === 0;
          const hasUnseen = unseenDays > 0;
          return (
            <div
              className={`card px-4 py-2.5 flex items-center gap-4 flex-wrap border ${
                allTrain ? "border-amber-400 bg-amber-50" : "border-gray-200"
              }`}
            >
              <p
                className={`text-xs font-medium ${allTrain ? "text-amber-700" : "text-gray-600"}`}
              >
                {allTrain
                  ? "⚠ All evaluated dates were in the training set — this measures memorisation, not generalisation."
                  : hasUnseen
                    ? "✓ Evaluation includes truly unseen dates — results reflect real out-of-sample accuracy."
                    : "Evaluation dates are from the held-out test split."}
              </p>
              <div className="flex items-center gap-3 ml-auto text-[11px] font-mono">
                {trainDays > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-amber-400 inline-block" />{" "}
                    {trainDays}d train
                  </span>
                )}
                {testDays > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-blue-500 inline-block" />{" "}
                    {testDays}d held-out test
                  </span>
                )}
                {unseenDays > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-green-500 inline-block" />{" "}
                    {unseenDays}d unseen
                  </span>
                )}
              </div>
            </div>
          );
        })()}

      {result && (
        <>
          {/* Aggregate KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              label="Overall MAPE"
              value={`${result.aggregate.mape}%`}
              sub={gradeLabel(result.aggregate.mape)}
              colorClass={gradeColor(result.aggregate.mape)}
              tooltip={getMapeTooltip(result.aggregate.mape)}
            />
            <KpiCard
              label="MAE (₹/kWh)"
              value={`₹${result.aggregate.mae}`}
              sub="Mean absolute error"
              tooltip={getMaeTooltip(result.aggregate.mae)}
            />
            <KpiCard
              label="RMSE (₹/kWh)"
              value={`₹${result.aggregate.rmse}`}
              sub="Root mean sq error"
              tooltip={getRmseTooltip(result.aggregate.rmse)}
            />
            <KpiCard
              label="R²"
              value={result.aggregate.r2.toFixed(4)}
              sub="Variance explained"
              colorClass={
                result.aggregate.r2 >= 0.98
                  ? "text-green-600"
                  : result.aggregate.r2 >= 0.95
                    ? "text-blue-700"
                    : "text-amber-600"
              }
              tooltip={getR2Tooltip(result.aggregate.r2)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="card p-4">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">
                Best Day
              </p>
              <p className="text-lg font-bold text-green-400">
                {result.best_day.date}
              </p>
              <p className="text-xs text-gray-400">
                MAPE {result.best_day.mape}%
              </p>
            </div>
            <div className="card p-4">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">
                Worst Day
              </p>
              <p className="text-lg font-bold text-red-400">
                {result.worst_day.date}
              </p>
              <p className="text-xs text-gray-400">
                MAPE {result.worst_day.mape}%
              </p>
            </div>
          </div>

          {/* Daily MAPE bar chart */}
          <div className="card p-4">
            <h2 className="text-sm font-semibold mb-3">Daily MAPE (%)</h2>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={result.daily}
                margin={{ top: 4, right: 8, left: -10, bottom: 0 }}
                onClick={(e) => {
                  if (e?.activePayload?.[0]?.payload?.date) {
                    setSelectedDate(e.activePayload[0].payload.date);
                  }
                }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3a" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  tickFormatter={(v) => v.slice(5)}
                />
                <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} unit="%" />
                <Tooltip
                  contentStyle={{
                    background: "#1a1a2e",
                    border: "1px solid #374151",
                    borderRadius: 6,
                    fontSize: 11,
                  }}
                  formatter={(v: number) => [`${v.toFixed(2)}%`, "MAPE"]}
                  labelFormatter={(l) => `Date: ${l}`}
                />
                <ReferenceLine
                  y={result.aggregate.mape}
                  stroke="#6366f1"
                  strokeDasharray="4 4"
                  label={{ value: "avg", fill: "#6366f1", fontSize: 10 }}
                />
                <Bar
                  dataKey="mape"
                  radius={[3, 3, 0, 0]}
                  fill="#3b82f6"
                  cursor="pointer"
                  label={false}
                  isAnimationActive={false}
                  shape={(props: any) => {
                    const { x, y, width, height, date } = props;
                    const split = result.daily.find(
                      (d: DayResult) => d.date === date,
                    )?.data_split;
                    const fill =
                      split === "train"
                        ? "#f59e0b"
                        : split === "unseen"
                          ? "#10b981"
                          : "#3b82f6";
                    return (
                      <rect
                        x={x}
                        y={y}
                        width={width}
                        height={height}
                        fill={fill}
                        rx={3}
                        ry={3}
                      />
                    );
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
            <p className="text-[10px] text-gray-500 mt-2">
              Click a bar to drill into that day&apos;s block-level predictions
              below.
            </p>
          </div>

          {/* Daily avg predicted vs actual line */}
          <div className="card p-4">
            <h2 className="text-sm font-semibold mb-3">
              Daily Average Price — Predicted vs Actual
            </h2>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart
                data={result.daily}
                margin={{ top: 4, right: 8, left: -10, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3a" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  tickFormatter={(v) => v.slice(5)}
                />
                <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} unit=" ₹" />
                <Tooltip
                  contentStyle={{
                    background: "#1a1a2e",
                    border: "1px solid #374151",
                    borderRadius: 6,
                    fontSize: 11,
                  }}
                  formatter={(v: number, name: string) => [
                    `₹${v.toFixed(3)}`,
                    name,
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="avg_predicted"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                  name="Predicted"
                />
                <Line
                  type="monotone"
                  dataKey="avg_actual"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                  name="Actual"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Block-level drill-down */}
          <div className="card p-4">
            <div className="mb-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  Block-Level Detail —{" "}
                  <span
                    className={
                      selectedDay
                        ? gradeColor(selectedDay.mape)
                        : "text-gray-400"
                    }
                  >
                    {selectedDate || "select a day above"}
                  </span>
                </h2>
                <select
                  id="bt-selected-date"
                  name="bt-selected-date"
                  className="input-field text-xs flex-shrink-0 ml-4"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                >
                  {result.daily.map((d: DayResult) => (
                    <option key={d.date} value={d.date}>
                      {d.date} — {d.mape}%
                    </option>
                  ))}
                </select>
              </div>
              {selectedDay && (
                <p className="text-gray-400 font-normal text-xs mt-0.5">
                  MAPE {selectedDay.mape}% · MAE ₹{selectedDay.mae} · avg
                  predicted ₹{selectedDay.avg_predicted} vs actual ₹
                  {selectedDay.avg_actual}
                </p>
              )}
            </div>

            {selectedDay ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart
                  data={selectedDay.blocks}
                  margin={{ top: 4, right: 8, left: -10, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis
                    dataKey="block"
                    tick={{ fontSize: 10, fill: "#6b7280" }}
                    tickFormatter={(b) => blockToTime(b)}
                    interval={7}
                  />
                  <YAxis tick={{ fontSize: 10, fill: "#6b7280" }} unit=" ₹" />
                  <Tooltip content={<BlockTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    type="monotone"
                    dataKey="predicted"
                    stroke="#2563eb"
                    strokeWidth={1.5}
                    dot={false}
                    name="Predicted"
                  />
                  <Line
                    type="monotone"
                    dataKey="actual"
                    stroke="#059669"
                    strokeWidth={1.5}
                    dot={false}
                    name="Actual"
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-gray-500 text-sm py-8 text-center">
                Select a day to view block-level predictions.
              </p>
            )}
          </div>

          {/* DSM Risk Analysis */}
          {(() => {
            const DSM_BAND = 10; // % — CERC 2024 ±10% deviation band
            const DSM_SEVERE = 20; // % — severe breach threshold
            const allBlocks = result.daily.flatMap((d: DayResult) => d.blocks);
            const total = allBlocks.length;
            const safe = allBlocks.filter(
              (b: any) => b.error_pct < DSM_BAND,
            ).length;
            const atRisk = allBlocks.filter(
              (b: any) => b.error_pct >= DSM_BAND && b.error_pct < DSM_SEVERE,
            ).length;
            const severe = allBlocks.filter(
              (b: any) => b.error_pct >= DSM_SEVERE,
            ).length;
            const violating = allBlocks.filter(
              (b: any) => b.error_pct >= DSM_BAND,
            );
            const avgBreachSeverity =
              violating.length > 0
                ? violating.reduce((s: number, b: any) => s + b.error_pct, 0) /
                  violating.length
                : 0;

            const dailyDsm = result.daily.map((d: DayResult) => ({
              date: d.date.slice(5),
              safe: d.blocks.filter((b) => b.error_pct < DSM_BAND).length,
              at_risk: d.blocks.filter(
                (b) => b.error_pct >= DSM_BAND && b.error_pct < DSM_SEVERE,
              ).length,
              severe: d.blocks.filter((b) => b.error_pct >= DSM_SEVERE).length,
            }));

            const safePct = ((safe / total) * 100).toFixed(1);
            const atRiskPct = ((atRisk / total) * 100).toFixed(1);
            const severePct = ((severe / total) * 100).toFixed(1);

            return (
              <div className="card p-4 space-y-4">
                <div>
                  <h2 className="text-sm font-semibold">DSM Risk Analysis</h2>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Simulates CERC 2024 DSM exposure: blocks where predicted
                    price deviates &gt;10% from actual represent bids that would
                    breach the deviation band, triggering penalty settlement.
                  </p>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="rounded-lg border border-gray-200 p-3">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                      Total Blocks
                    </p>
                    <p className="text-xl font-bold text-gray-900">{total}</p>
                    <p className="text-[10px] text-gray-400">
                      {result.days_evaluated} days × 96 blocks
                    </p>
                  </div>
                  <div className="rounded-lg border border-green-200 bg-green-50 p-3">
                    <p className="text-[10px] text-green-700 uppercase tracking-wider">
                      Within DSM Band
                    </p>
                    <p className="text-xl font-bold text-green-700">
                      {safePct}%
                    </p>
                    <p className="text-[10px] text-green-600">
                      {safe} blocks &lt;10% error
                    </p>
                  </div>
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <p className="text-[10px] text-amber-700 uppercase tracking-wider">
                      At Risk (10–20%)
                    </p>
                    <p className="text-xl font-bold text-amber-700">
                      {atRiskPct}%
                    </p>
                    <p className="text-[10px] text-amber-600">
                      {atRisk} blocks in DSM zone
                    </p>
                  </div>
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                    <p className="text-[10px] text-red-700 uppercase tracking-wider">
                      Severe (&gt;20%)
                    </p>
                    <p className="text-xl font-bold text-red-700">
                      {severePct}%
                    </p>
                    <p className="text-[10px] text-red-600">
                      {severe} blocks, avg +{avgBreachSeverity.toFixed(1)}%
                    </p>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-medium text-gray-600 mb-2">
                    Daily DSM Exposure — Block Count by Severity
                  </p>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart
                      data={dailyDsm}
                      margin={{ top: 4, right: 8, left: -10, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: "#6b7280" }}
                      />
                      <YAxis tick={{ fontSize: 10, fill: "#6b7280" }} />
                      <Tooltip
                        contentStyle={{
                          background: "#fff",
                          border: "1px solid #e5e7eb",
                          borderRadius: 6,
                          fontSize: 11,
                        }}
                        formatter={(v: number, name: string) => [
                          `${v} blocks`,
                          name,
                        ]}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar
                        dataKey="safe"
                        stackId="a"
                        fill="#059669"
                        name="Within Band"
                      />
                      <Bar
                        dataKey="at_risk"
                        stackId="a"
                        fill="#d97706"
                        name="At Risk (10–20%)"
                      />
                      <Bar
                        dataKey="severe"
                        stackId="a"
                        fill="#dc2626"
                        name="Severe (>20%)"
                        radius={[3, 3, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                  <p className="text-[10px] text-gray-400 mt-1">
                    Green = safe bids · Amber = DSM penalty zone · Red = high
                    penalty risk. CERC 2024: deviation band ±10%, penalty rate
                    1.5×.
                  </p>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
