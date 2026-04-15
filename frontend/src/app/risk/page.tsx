"use client";

import { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { assessRisk, recommendBids } from "@/lib/api";
import { SEGMENTS, STRATEGIES, getTomorrowDate, formatINR } from "@/lib/utils";

export default function RiskPage() {
  const [segment, setSegment] = useState("DAM");
  const [strategy, setStrategy] = useState("balanced");
  const [targetDate, setTargetDate] = useState(getTomorrowDate());
  const [demandMw, setDemandMw] = useState(500);
  const [risk, setRisk] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [threshold, setThreshold] = useState(500000);

  const handleAssess = async () => {
    setLoading(true);
    try {
      // First get recommendations, then assess risk
      const recs = await recommendBids(targetDate, strategy, segment, demandMw);
      const bids = recs.map((r: any) => ({
        block: r.block,
        segment: r.segment,
        price: r.price,
        volume_mw: r.volume_mw,
      }));
      const result = await assessRisk(`risk-${Date.now()}`, segment, bids, threshold);
      setRisk(result);
    } catch (e: any) {
      alert(
        e.response?.data?.detail || "Risk assessment failed. Run forecast first."
      );
    }
    setLoading(false);
  };

  const riskMetrics = risk
    ? [
        { name: "VaR (95%)", value: risk.var_95, color: "#3b82f6" },
        {
          name: "Expected DSM Penalty",
          value: risk.expected_dsm_penalty,
          color: "#f59e0b",
        },
        {
          name: "Worst-Case Penalty",
          value: risk.worst_case_penalty,
          color: "#ef4444",
        },
        {
          name: "Total Exposure",
          value: risk.total_exposure,
          color: risk.alert_triggered ? "#ef4444" : "#22c55e",
        },
      ]
    : [];

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Risk Assessment Panel</h1>
        <p className="text-gray-400 text-sm">
          Value-at-Risk, DSM penalty estimates, and real-time threshold alerts
        </p>
      </div>

      {/* Controls */}
      <div className="card mb-6">
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Target Date
            </label>
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
              Strategy
            </label>
            <div className="flex rounded-lg overflow-hidden border border-gray-600">
              {STRATEGIES.map((s) => (
                <button
                  key={s}
                  onClick={() => setStrategy(s)}
                  className={`px-3 py-2 text-sm capitalize transition-colors ${
                    strategy === s
                      ? s === "conservative"
                        ? "bg-green-600 text-white"
                        : s === "balanced"
                          ? "bg-blue-600 text-white"
                          : "bg-red-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Demand (MW)
            </label>
            <input
              type="number"
              value={demandMw}
              onChange={(e) => setDemandMw(Number(e.target.value))}
              className="input-field w-28"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Alert Threshold (₹)
            </label>
            <input
              type="number"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="input-field w-32"
            />
          </div>
          <button
            onClick={handleAssess}
            disabled={loading}
            className="btn-primary"
          >
            {loading ? "Assessing..." : "Assess Risk"}
          </button>
        </div>
      </div>

      {/* Alert banner */}
      {risk?.alert_triggered && (
        <div className="card mb-6 bg-red-900/30 border-red-600 animate-pulse">
          <div className="flex items-center gap-3">
            <span className="text-3xl">🚨</span>
            <div>
              <h3 className="text-red-400 font-bold text-lg">
                RISK ALERT TRIGGERED
              </h3>
              <p className="text-red-300 text-sm">
                {risk.alert_details?.message}
              </p>
            </div>
          </div>
        </div>
      )}

      {risk && (
        <>
          {/* Metric cards */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="card text-center">
              <div className="text-xs text-gray-400 mb-1">VaR (95%)</div>
              <div className="text-2xl font-bold text-blue-400">
                {formatINR(risk.var_95)}
              </div>
              <div className="text-xs text-gray-500">
                Potential loss at 95% confidence
              </div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-gray-400 mb-1">
                Expected DSM Penalty
              </div>
              <div className="text-2xl font-bold text-amber-400">
                {formatINR(risk.expected_dsm_penalty)}
              </div>
              <div className="text-xs text-gray-500">Based on deviation model</div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-gray-400 mb-1">
                Worst-Case Penalty
              </div>
              <div className="text-2xl font-bold text-red-400">
                {formatINR(risk.worst_case_penalty)}
              </div>
              <div className="text-xs text-gray-500">
                Max deviation scenario
              </div>
            </div>
            <div
              className={`card text-center ${
                risk.alert_triggered
                  ? "border-red-500 bg-red-900/10"
                  : "border-green-500/30"
              }`}
            >
              <div className="text-xs text-gray-400 mb-1">Total Exposure</div>
              <div
                className={`text-2xl font-bold ${
                  risk.alert_triggered ? "text-red-400" : "text-green-400"
                }`}
              >
                {formatINR(risk.total_exposure)}
              </div>
              <div className="text-xs text-gray-500">
                Threshold: {formatINR(threshold)}
              </div>
            </div>
          </div>

          {/* Risk chart */}
          <div className="card mb-6">
            <h2 className="text-sm font-semibold mb-4 text-gray-300">
              Risk Breakdown
            </h2>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={riskMetrics} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3d" />
                <XAxis
                  type="number"
                  stroke="#6b7280"
                  fontSize={11}
                  tickFormatter={(v) => formatINR(v)}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  stroke="#6b7280"
                  fontSize={11}
                  width={150}
                />
                <Tooltip
                  contentStyle={{
                    background: "#1a2332",
                    border: "1px solid #1e2d3d",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(val: number) => formatINR(val)}
                />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {riskMetrics.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Threshold gauge */}
          <div className="card">
            <h2 className="text-sm font-semibold mb-3 text-gray-300">
              Exposure vs Threshold
            </h2>
            <div className="relative h-8 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  risk.alert_triggered
                    ? "bg-gradient-to-r from-red-600 to-red-400"
                    : "bg-gradient-to-r from-green-600 to-green-400"
                }`}
                style={{
                  width: `${Math.min((risk.total_exposure / threshold) * 100, 100)}%`,
                }}
              />
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-white/60"
                style={{ left: "100%" }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-400 mt-2">
              <span>₹0</span>
              <span>
                {formatINR(risk.total_exposure)} /{" "}
                {formatINR(threshold)} (
                {((risk.total_exposure / threshold) * 100).toFixed(0)}%)
              </span>
              <span>{formatINR(threshold)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
