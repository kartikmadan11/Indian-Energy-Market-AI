"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { getLatestForecast, getHistory, getHealth } from "@/lib/api";
import { blockToTime } from "@/lib/utils";

const SEGMENTS = ["DAM", "RTM", "TAM"] as const;
type Segment = (typeof SEGMENTS)[number];

const SEGMENT_META: Record<Segment, { label: string; color: string; predColor: string; desc: string }> = {
  DAM: { label: "Day-Ahead Market",  color: "#006DAE", predColor: "#00B398", desc: "Gate closure D-1 · 96 blocks" },
  RTM: { label: "Real-Time Market",  color: "#F59E0B", predColor: "#EF4444", desc: "Gate closure 55 min · 96 blocks" },
  TAM: { label: "Term-Ahead Market", color: "#8B5CF6", predColor: "#EC4899", desc: "Intraday · Weekly · Monthly" },
};

interface ChartPoint {
  key: string;
  label: string;
  actual?: number;
  predicted?: number;
  ci_high?: number;
}

interface SegmentState {
  points: ChartPoint[];
  avgActual: number;
  avgPred: number | null;
  hasPred: boolean;
  loaded: boolean;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs shadow-md">
      <p className="text-gray-500 mb-1 font-medium">{label}</p>
      {payload.map((p: any) => (
        <p key={p.name} style={{ color: p.color }} className="font-semibold">
          {p.name}: ₹{Number(p.value ?? 0).toFixed(3)}/kWh
        </p>
      ))}
    </div>
  );
};

export default function Home() {
  const [data, setData] = useState<Record<Segment, SegmentState>>({
    DAM: { points: [], avgActual: 0, avgPred: null, hasPred: false, loaded: false },
    RTM: { points: [], avgActual: 0, avgPred: null, hasPred: false, loaded: false },
    TAM: { points: [], avgActual: 0, avgPred: null, hasPred: false, loaded: false },
  });
  const [health, setHealth] = useState<any>(null);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => {});

    SEGMENTS.forEach(async (seg) => {
      try {
        const [histRaw, forecastRaw] = await Promise.allSettled([
          getHistory(seg, 7),
          getLatestForecast(seg),
        ]);

        const histRows = histRaw.status === "fulfilled" ? histRaw.value : [];
        const forecastBlocks =
          forecastRaw.status === "fulfilled" && forecastRaw.value?.blocks?.length
            ? forecastRaw.value.blocks
            : null;

        const dateMap = new Map<string, Map<number, number>>();
        for (const row of histRows) {
          if (!dateMap.has(row.date)) dateMap.set(row.date, new Map());
          dateMap.get(row.date)!.set(row.block, row.mcp);
        }
        const sortedDates = [...dateMap.keys()].sort();

        const points: ChartPoint[] = [];
        for (const date of sortedDates) {
          const blockMap = dateMap.get(date)!;
          for (let b = 1; b <= 96; b++) {
            const mcp = blockMap.get(b);
            if (mcp !== undefined) {
              points.push({
                key: `${date}|${b}`,
                label: `${date.slice(5)} ${blockToTime(b)}`,
                actual: mcp,
              });
            }
          }
        }

        if (forecastBlocks) {
          for (const fb of forecastBlocks) {
            points.push({
              key: `pred|${fb.block}`,
              label: `pred ${blockToTime(fb.block)}`,
              predicted: fb.predicted_price,
              ci_high: fb.confidence_high,
            });
          }
        }

        const actualVals = points.flatMap((p) => (p.actual !== undefined ? [p.actual] : []));
        const predVals = points.flatMap((p) => (p.predicted !== undefined ? [p.predicted] : []));

        setData((prev) => ({
          ...prev,
          [seg]: {
            points,
            avgActual: actualVals.length ? actualVals.reduce((s, v) => s + v, 0) / actualVals.length : 0,
            avgPred: predVals.length ? predVals.reduce((s, v) => s + v, 0) / predVals.length : null,
            hasPred: predVals.length > 0,
            loaded: true,
          },
        }));
      } catch {
        setData((prev) => ({ ...prev, [seg]: { ...prev[seg], loaded: true } }));
      }
    });
  }, []);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Page title */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Market Overview</h1>
          <p className="text-gray-500 text-xs mt-0.5">
            Historical MCP data with AI price predictions
          </p>
        </div>
        <div className="flex items-center gap-2">
          {health && (
            <span className="text-[10px] text-teal-700 bg-teal-50 border border-teal-200 px-2 py-1 rounded-full">
              DB · {health.db_status || "ok"}
            </span>
          )}
          <span className="text-[10px] text-gray-500 bg-gray-100 border border-gray-200 px-2 py-1 rounded-full">
            {new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
          </span>
        </div>
      </div>

      {/* One chart per segment */}
      {SEGMENTS.map((seg) => {
        const meta = SEGMENT_META[seg];
        const state = data[seg];

        return (
          <div key={seg} className="card">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold" style={{ color: meta.color }}>{seg}</span>
                <span className="text-xs text-gray-600 font-medium">{meta.label}</span>
                <span className="text-[10px] text-gray-400">{meta.desc}</span>
              </div>
              <div className="flex items-center gap-4">
                {state.avgActual > 0 && (
                  <div className="text-right">
                    <div className="text-[10px] text-gray-400 uppercase tracking-wider">7-day avg</div>
                    <div className="text-sm font-bold" style={{ color: meta.color }}>
                      ₹{state.avgActual.toFixed(3)}
                    </div>
                  </div>
                )}
                {state.avgPred !== null && (
                  <div className="text-right">
                    <div className="text-[10px] text-gray-400 uppercase tracking-wider">forecast avg</div>
                    <div className="text-sm font-bold" style={{ color: meta.predColor }}>
                      ₹{state.avgPred.toFixed(3)}
                    </div>
                  </div>
                )}
                {!state.loaded && (
                  <span className="text-[10px] text-gray-400">Loading…</span>
                )}
              </div>
            </div>

            {state.loaded && state.points.length > 0 ? (
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={state.points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id={`histGrad-${seg}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={meta.color} stopOpacity={0.15} />
                        <stop offset="95%" stopColor={meta.color} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id={`ciGrad-${seg}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={meta.predColor} stopOpacity={0.12} />
                        <stop offset="95%" stopColor={meta.predColor} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis
                      dataKey="label"
                      fontSize={8}
                      stroke="#D1D5DB"
                      tick={{ fill: "#9CA3AF" }}
                      interval={Math.floor(state.points.length / 8)}
                      tickLine={false}
                    />
                    <YAxis
                      fontSize={9}
                      stroke="#D1D5DB"
                      tick={{ fill: "#9CA3AF" }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `₹${v}`}
                      width={42}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend
                      iconType="circle"
                      iconSize={6}
                      wrapperStyle={{ fontSize: "10px", paddingTop: "4px" }}
                    />
                    {state.hasPred && (
                      <Area
                        type="monotone"
                        dataKey="ci_high"
                        stroke="none"
                        fill={`url(#ciGrad-${seg})`}
                        name="CI Band"
                        legendType="none"
                        connectNulls
                        dot={false}
                      />
                    )}
                    <Area
                      type="monotone"
                      dataKey="actual"
                      name="Historical MCP"
                      stroke={meta.color}
                      strokeWidth={1.5}
                      fill={`url(#histGrad-${seg})`}
                      dot={false}
                      connectNulls={false}
                      activeDot={{ r: 3, fill: meta.color }}
                    />
                    {state.hasPred && (
                      <Line
                        type="monotone"
                        dataKey="predicted"
                        name="AI Forecast"
                        stroke={meta.predColor}
                        strokeWidth={2}
                        dot={false}
                        strokeDasharray="5 3"
                        connectNulls
                        activeDot={{ r: 4, fill: meta.predColor }}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : state.loaded ? (
              <div className="h-52 flex flex-col items-center justify-center gap-2 text-center bg-gray-50 rounded-lg border border-dashed border-gray-200">
                <p className="text-gray-400 text-xs">No data available for {seg}</p>
                <p className="text-gray-400 text-[10px]">
                  Scrape data first, then{" "}
                  <Link href="/forecast" className="text-[#006DAE] underline">
                    run a forecast
                  </Link>{" "}
                  to see predictions
                </p>
              </div>
            ) : (
              <div className="h-52 bg-gray-50 animate-pulse rounded-lg" />
            )}
          </div>
        );
      })}
    </div>
  );
}
