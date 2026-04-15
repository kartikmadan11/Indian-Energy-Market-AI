"use client";

import { useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { postMarketAnalysis, getAuditLog } from "@/lib/api";
import { SEGMENTS, formatINR, blockToTime, getTomorrowDate } from "@/lib/utils";

export default function AnalysisPage() {
  const [segment, setSegment] = useState("DAM");
  const [targetDate, setTargetDate] = useState(getTomorrowDate());
  const [dateRange, setDateRange] = useState(7);
  const [result, setResult] = useState<any>(null);
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const handleAnalyze = async () => {
    setLoading(true);
    try {
      // Audit log limit scales with lookback window: ~3 sessions/day × dateRange days
      const auditLimit = Math.min(dateRange * 3, 100);
      const [analysis, logs] = await Promise.all([
        postMarketAnalysis(targetDate, segment),
        getAuditLog(undefined, auditLimit),
      ]);
      setResult(analysis);
      setAuditLog(logs);
    } catch (e: any) {
      alert(e.response?.data?.detail || "Analysis failed — ensure actual price data exists for this date");
    }
    setLoading(false);
  };

  const getGrade = (mape: number) => {
    if (mape < 5) return { label: "Excellent", color: "text-green-400" };
    if (mape < 8) return { label: "Good", color: "text-blue-400" };
    if (mape < 12) return { label: "Fair", color: "text-amber-400" };
    return { label: "Needs Improvement", color: "text-red-400" };
  };

  // Derive chart-friendly arrays from result.blocks (backend field)
  const dailyComparison = result?.blocks?.map((b: any) => ({
    block: b.block,
    predicted: b.predicted_price,
    actual: b.actual_price,
  })) ?? [];

  const errorDistribution = result?.blocks?.map((b: any) => ({
    block: b.block,
    error_pct: b.error_pct,
  })) ?? [];

  // Generate recommendations client-side from actual metrics
  const recommendations: string[] = [];
  if (result) {
    const mape: number = result.mape ?? 0;
    const hitRate: number = result.bid_hit_rate ?? 0;
    const basketChange: number = result.basket_rate_change_pct ?? 0;
    const penalty: number = result.total_dsm_penalty ?? 0;

    if (mape > 10)
      recommendations.push(
        `Forecast MAPE is ${mape.toFixed(1)}% — retrain the model with more recent data or tighter hyperparameters.`
      );
    else if (mape > 5)
      recommendations.push(
        `Forecast MAPE of ${mape.toFixed(1)}% is acceptable. Consider adding weather features for further improvement.`
      );

    if (hitRate < 50)
      recommendations.push(
        `Bid hit rate is only ${hitRate.toFixed(0)}% — bids may be too conservative. Try the Aggressive strategy for volatile blocks.`
      );
    else if (hitRate > 90)
      recommendations.push(
        `Hit rate is ${hitRate.toFixed(0)}% — consider tightening bid prices slightly to improve basket rate.`
      );

    if (basketChange < -2)
      recommendations.push(
        `Basket rate improved by ${Math.abs(basketChange).toFixed(1)}% vs baseline — LP optimizer is adding value.`
      );
    else if (basketChange > 2)
      recommendations.push(
        `Basket rate is ${basketChange.toFixed(1)}% above baseline — review strategy; Conservative or Balanced may reduce over-payment.`
      );

    if (penalty > 50000)
      recommendations.push(
        `DSM penalties of ${formatINR(penalty)} are high — increase DSM Compliance Pressure (λ₁) in the optimizer.`
      );
    else if (penalty === 0 && result.blocks?.some((b: any) => b.bid_volume))
      recommendations.push("No DSM penalties incurred — constraint enforcement is working correctly.");

    if (recommendations.length === 0)
      recommendations.push("Performance looks good. Continue monitoring with the next trading session.");
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Post-Market Analysis</h1>
        <p className="text-gray-400 text-sm">
          Feedback loop: compare predictions vs actuals, track bid quality, and
          identify improvement areas
        </p>
      </div>

      {/* Controls */}
      <div className="card mb-6">
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Target Date</label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="input-field"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Segment</label>
            <select
              value={segment}
              onChange={(e) => setSegment(e.target.value)}
              className="select-field"
            >
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Lookback Period
            </label>
            <div className="flex rounded-lg overflow-hidden border border-gray-600">
              {[7, 14, 30].map((d) => (
                <button
                  key={d}
                  onClick={() => setDateRange(d)}
                  className={`px-4 py-2 text-sm transition-colors ${
                    dateRange === d
                      ? "bg-blue-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={handleAnalyze}
            disabled={loading}
            className="btn-primary"
          >
            {loading ? "Analyzing..." : "Run Analysis"}
          </button>
        </div>
      </div>

      {result && (
        <>
          {/* KPI Summary Cards */}
          <div className="grid grid-cols-5 gap-4 mb-6">
            <div className="card text-center">
              <div className="text-xs text-gray-400 mb-1">Forecast MAPE</div>
              <div className={`text-2xl font-bold ${getGrade(result.mape).color}`}>
                {(result.mape ?? 0).toFixed(1)}%
              </div>
              <div className={`text-xs ${getGrade(result.mape).color}`}>
                {getGrade(result.mape).label}
              </div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-gray-400 mb-1">Bid Hit Rate</div>
              <div className="text-2xl font-bold text-blue-400">
                {(result.bid_hit_rate ?? 0).toFixed(0)}%
              </div>
              <div className="text-xs text-gray-500">Bids cleared in market</div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-gray-400 mb-1">Basket Rate vs Baseline</div>
              <div
                className={`text-2xl font-bold ${
                  (result.basket_rate_change_pct ?? 0) <= 0
                    ? "text-green-400"
                    : "text-red-400"
                }`}
              >
                {(result.basket_rate_change_pct ?? 0) > 0 ? "+" : ""}
                {(result.basket_rate_change_pct ?? 0).toFixed(1)}%
              </div>
              <div className="text-xs text-gray-500">vs weighted average</div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-gray-400 mb-1">Total DSM Penalties</div>
              <div className="text-2xl font-bold text-amber-400">
                {formatINR(result.total_dsm_penalty ?? 0)}
              </div>
              <div className="text-xs text-gray-500">
                {result.segment} · {result.target_date}
              </div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-gray-400 mb-1">Recommendations</div>
              <div className="text-2xl font-bold text-purple-400">
                {recommendations.length}
              </div>
              <div className="text-xs text-gray-500">Action items</div>
            </div>
          </div>

          {/* Predicted vs Actual Chart */}
          <div className="card mb-6">
            <h2 className="text-sm font-semibold mb-4 text-gray-700">
              Predicted vs Actual Prices — {result.segment} · {result.target_date}
            </h2>
            {dailyComparison.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={dailyComparison}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="block"
                    stroke="#94a3b8"
                    fontSize={10}
                    tickFormatter={(b) => blockToTime(b)}
                    interval={7}
                  />
                  <YAxis
                    stroke="#94a3b8"
                    fontSize={11}
                    tickFormatter={(v) => `₹${v.toFixed(1)}`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#ffffff",
                      border: "1px solid #e2e8f0",
                      borderRadius: "8px",
                      fontSize: "12px",
                      color: "#1e293b",
                      boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                    }}
                    formatter={(val: number) => `₹${val.toFixed(3)}/kWh`}
                    labelFormatter={(b) => `Block ${b} (${blockToTime(Number(b))})`}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="predicted"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    dot={false}
                    name="Predicted"
                  />
                  <Line
                    type="monotone"
                    dataKey="actual"
                    stroke="#22c55e"
                    strokeWidth={2}
                    dot={false}
                    name="Actual"
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[300px] flex items-center justify-center text-gray-500 text-sm">
                No block data — ensure a forecast exists for this date
              </div>
            )}
          </div>

          {/* Error distribution */}
          {errorDistribution.length > 0 && (
            <div className="card mb-6">
            <h2 className="text-sm font-semibold mb-4 text-gray-700">
                Forecast Error Distribution by Block
              </h2>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={errorDistribution}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="block"
                    stroke="#94a3b8"
                    fontSize={10}
                    tickFormatter={(b) => blockToTime(b)}
                    interval={7}
                  />
                  <YAxis
                    stroke="#94a3b8"
                    fontSize={11}
                    tickFormatter={(v) => `${v.toFixed(0)}%`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#ffffff",
                      border: "1px solid #e2e8f0",
                      borderRadius: "8px",
                      fontSize: "12px",
                      color: "#1e293b",
                      boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                    }}
                    formatter={(v: number) => `${v.toFixed(2)}%`}
                    labelFormatter={(b) => `Block ${b}`}
                  />
                  <Bar dataKey="error_pct" radius={[2, 2, 0, 0]}>
                    {errorDistribution.map((entry: any, i: number) => (
                      <Cell
                        key={i}
                        fill={entry.error_pct > 10 ? "#ef4444" : "#3b82f6"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Recommendations */}
          {recommendations.length > 0 && (
            <div className="card mb-6">
              <h2 className="text-sm font-semibold mb-4 text-gray-700">
                AI Recommendations
              </h2>
              <div className="space-y-3">
                {recommendations.map((rec: string, i: number) => {
                  const isWarn = /retrain|low bid|above baseline|high.*penalt/i.test(rec);
                  const isGood = /improved|correct|adding value|no dsm/i.test(rec);
                  const colors = isWarn
                    ? "bg-amber-50 border border-amber-200 text-amber-900"
                    : isGood
                      ? "bg-green-50 border border-green-200 text-green-900"
                      : "bg-blue-50 border border-blue-200 text-blue-900";
                  const numColor = isWarn ? "text-amber-600" : isGood ? "text-green-600" : "text-blue-600";
                  return (
                  <div
                    key={i}
                    className={`flex items-start gap-3 p-3 rounded-lg ${colors}`}
                  >
                    <span className={`font-mono text-sm mt-0.5 font-bold ${numColor}`}>
                      {i + 1}.
                    </span>
                    <p className="text-sm">{rec}</p>
                  </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* Audit log */}
      <div className="card">
        <h2 className="text-sm font-semibold mb-4 text-gray-300">
          Recent Audit Trail
        </h2>
        {auditLog.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-700 text-gray-400">
                  <th className="text-left py-2 pr-3">Timestamp</th>
                  <th className="text-left py-2 pr-3">Action</th>
                  <th className="text-left py-2 pr-3">User</th>
                  <th className="text-left py-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {auditLog.map((log, i) => (
                  <tr key={i} className="border-b border-gray-800">
                    <td className="py-2 pr-3 text-gray-500 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          log.action === "bid_submit"
                            ? "bg-green-900/30 text-green-400"
                            : log.action === "risk_assess"
                              ? "bg-amber-900/30 text-amber-400"
                              : "bg-blue-900/30 text-blue-400"
                        }`}
                      >
                        {log.action}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-gray-400">{log.user || log.user_id || "—"}</td>
                    <td className="py-2 text-gray-500 truncate max-w-[300px]">
                      {JSON.stringify(log.details)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-500 text-sm">
            {result
              ? "No audit entries found"
              : "Run analysis to load recent audit trail"}
          </p>
        )}
      </div>
    </div>
  );
}

