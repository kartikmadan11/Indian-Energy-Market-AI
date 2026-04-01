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
  Area,
  AreaChart,
  Legend,
} from "recharts";
import { predictPrices, trainModel, getLatestForecast, exportForecastCsv } from "@/lib/api";
import { blockToTime, SEGMENTS, getTomorrowDate } from "@/lib/utils";

interface ForecastBlock {
  block: number;
  predicted_price: number;
  confidence_low: number;
  confidence_high: number;
  volatility: number;
  top_features: { feature: string; importance: number }[];
}

export default function ForecastPage() {
  const [segment, setSegment] = useState("DAM");
  const [targetDate, setTargetDate] = useState(getTomorrowDate());
  const [blocks, setBlocks] = useState<ForecastBlock[]>([]);
  const [loading, setLoading] = useState(false);
  const [training, setTraining] = useState(false);
  const [trainResult, setTrainResult] = useState<any>(null);
  const [selectedBlock, setSelectedBlock] = useState<ForecastBlock | null>(
    null,
  );
  const [isStale, setIsStale] = useState(false);
  const [dataTimestamp, setDataTimestamp] = useState<string>("");
  const [offlineError, setOfflineError] = useState<string>("");

  const handlePredict = async () => {
    setLoading(true);
    setIsStale(false);
    setOfflineError("");
    try {
      const data = await predictPrices(targetDate, segment);
      setBlocks(data.blocks);
      setSelectedBlock(data.blocks[0]);
      setDataTimestamp(new Date().toLocaleTimeString());
    } catch (e: any) {
      // Graceful degradation: try cached forecast
      try {
        const cached = await getLatestForecast(segment);
        setBlocks(cached.blocks);
        setSelectedBlock(cached.blocks[0]);
        setIsStale(true);
        setDataTimestamp(new Date().toLocaleTimeString());
        setOfflineError(
          e.response?.data?.detail ||
            "Live forecast unavailable — showing last cached prediction."
        );
      } catch {
        setOfflineError(
          "Data feed offline. No cached forecasts available. Please check backend connectivity."
        );
      }
    }
    setLoading(false);
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

  const handleTrain = async () => {
    setTraining(true);
    try {
      const result = await trainModel(segment);
      setTrainResult(result);
    } catch (e: any) {
      alert(e.response?.data?.detail || "Training failed");
    }
    setTraining(false);
  };

  const chartData = blocks.map((b) => ({
    block: b.block,
    time: blockToTime(b.block),
    price: b.predicted_price,
    low: b.confidence_low,
    high: b.confidence_high,
    range: [b.confidence_low, b.confidence_high],
  }));

  const peakBlock = blocks.length
    ? blocks.reduce((a, b) => (a.predicted_price > b.predicted_price ? a : b))
    : null;
  const minBlock = blocks.length
    ? blocks.reduce((a, b) => (a.predicted_price < b.predicted_price ? a : b))
    : null;
  const avgPrice = blocks.length
    ? blocks.reduce((s, b) => s + b.predicted_price, 0) / blocks.length
    : 0;

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Price Forecast</h1>
          <p className="text-gray-400 text-sm">
            96-block price predictions with confidence intervals
          </p>
        </div>
        <button
          onClick={handleTrain}
          disabled={training}
          className="btn-secondary text-sm"
        >
          {training ? "Training..." : `Train ${segment} Model`}
        </button>
      </div>

      {trainResult && (
        <div className="card mb-4 bg-green-900/20 border-green-600/30">
          <p className="text-green-400 text-sm">
            Model trained — MAPE: {trainResult.metrics.mape}% | Train:{" "}
            {trainResult.metrics.train_size.toLocaleString()} | Test:{" "}
            {trainResult.metrics.test_size.toLocaleString()}
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="card mb-6">
        <div className="flex items-end gap-4">
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
          <button
            onClick={handlePredict}
            disabled={loading}
            className="btn-primary"
          >
            {loading ? "Forecasting..." : "Generate Forecast"}
          </button>
          {blocks.length > 0 && (
            <button onClick={handleExportCsv} className="btn-secondary text-sm">
              Download CSV
            </button>
          )}
        </div>
      </div>

      {/* Offline / stale data banner */}
      {offlineError && (
        <div
          className={`card mb-4 ${isStale ? "bg-yellow-900/20 border-yellow-600/30" : "bg-red-900/20 border-red-600/30"}`}
        >
          <div className="flex items-center gap-3">
            <span className="text-xl">{isStale ? "⚠️" : "🔴"}</span>
            <div className="flex-1">
              <h3
                className={`font-semibold text-sm ${isStale ? "text-yellow-400" : "text-red-400"}`}
              >
                {isStale ? "Data Feed Offline — Showing Cached Data" : "Data Feed Offline"}
              </h3>
              <p className="text-xs text-gray-400">{offlineError}</p>
            </div>
            {isStale && (
              <span className="text-xs text-gray-500">
                Retrieved at {dataTimestamp}
              </span>
            )}
            {blocks.length > 0 && (
              <button
                onClick={handleExportCsv}
                className="btn-secondary text-xs px-3 py-1"
              >
                Export CSV for Manual Upload
              </button>
            )}
          </div>
        </div>
      )}

      {blocks.length > 0 && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="card text-center">
              <div className="text-xs text-gray-400">Average Price</div>
              <div className="text-2xl font-bold text-blue-400">
                ₹{avgPrice.toFixed(2)}
              </div>
              <div className="text-xs text-gray-500">INR/kWh</div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-gray-400">Peak Price</div>
              <div className="text-2xl font-bold text-red-400">
                ₹{peakBlock?.predicted_price.toFixed(2)}
              </div>
              <div className="text-xs text-gray-500">
                Block {peakBlock?.block} ({blockToTime(peakBlock?.block || 1)})
              </div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-gray-400">Lowest Price</div>
              <div className="text-2xl font-bold text-green-400">
                ₹{minBlock?.predicted_price.toFixed(2)}
              </div>
              <div className="text-xs text-gray-500">
                Block {minBlock?.block} ({blockToTime(minBlock?.block || 1)})
              </div>
            </div>
            <div className="card text-center">
              <div className="text-xs text-gray-400">Avg Volatility</div>
              <div className="text-2xl font-bold text-amber-400">
                ₹
                {(
                  blocks.reduce((s, b) => s + b.volatility, 0) / blocks.length
                ).toFixed(2)}
              </div>
              <div className="text-xs text-gray-500">INR/kWh</div>
            </div>
          </div>

          {/* Main chart */}
          <div className="card mb-6">
            <h2 className="text-sm font-semibold mb-4 text-gray-300">
              Price Forecast — {segment} — {targetDate}
            </h2>
            <ResponsiveContainer width="100%" height={350}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="confGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3d" />
                <XAxis
                  dataKey="time"
                  stroke="#6b7280"
                  fontSize={10}
                  interval={7}
                />
                <YAxis stroke="#6b7280" fontSize={11} />
                <Tooltip
                  contentStyle={{
                    background: "#1a2332",
                    border: "1px solid #1e2d3d",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(val: number) => `₹${val.toFixed(2)}`}
                />
                <Legend />
                <Area
                  type="monotone"
                  dataKey="high"
                  stroke="transparent"
                  fill="url(#confGrad)"
                  name="Confidence High"
                />
                <Area
                  type="monotone"
                  dataKey="low"
                  stroke="transparent"
                  fill="#0a0f1a"
                  name="Confidence Low"
                />
                <Line
                  type="monotone"
                  dataKey="price"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                  name="Predicted Price"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Feature importance for selected block */}
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 card">
              <h2 className="text-sm font-semibold mb-3 text-gray-300">
                Block Details (click to select)
              </h2>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="text-gray-400 sticky top-0 bg-[#1a2332]">
                    <tr>
                      <th className="text-left py-1 px-2">Block</th>
                      <th className="text-left py-1 px-2">Time</th>
                      <th className="text-right py-1 px-2">Price</th>
                      <th className="text-right py-1 px-2">Low</th>
                      <th className="text-right py-1 px-2">High</th>
                      <th className="text-right py-1 px-2">Volatility</th>
                    </tr>
                  </thead>
                  <tbody>
                    {blocks.map((b) => (
                      <tr
                        key={b.block}
                        className={`cursor-pointer transition-colors ${
                          selectedBlock?.block === b.block
                            ? "bg-blue-900/30"
                            : "hover:bg-gray-800/50"
                        }`}
                        onClick={() => setSelectedBlock(b)}
                      >
                        <td className="py-1 px-2">{b.block}</td>
                        <td className="py-1 px-2 text-gray-400">
                          {blockToTime(b.block)}
                        </td>
                        <td className="py-1 px-2 text-right font-medium">
                          ₹{b.predicted_price.toFixed(2)}
                        </td>
                        <td className="py-1 px-2 text-right text-gray-400">
                          ₹{b.confidence_low.toFixed(2)}
                        </td>
                        <td className="py-1 px-2 text-right text-gray-400">
                          ₹{b.confidence_high.toFixed(2)}
                        </td>
                        <td className="py-1 px-2 text-right text-amber-400">
                          {b.volatility.toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <h2 className="text-sm font-semibold mb-3 text-gray-300">
                Top Features — Block {selectedBlock?.block}
              </h2>
              {selectedBlock?.top_features.map((f, i) => (
                <div key={f.feature} className="mb-3">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-300">{f.feature}</span>
                    <span className="text-blue-400">
                      {(f.importance * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="w-full bg-gray-700 rounded-full h-2">
                    <div
                      className="bg-blue-500 h-2 rounded-full"
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
  );
}
