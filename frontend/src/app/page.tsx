"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { getLatestForecast, getHealth } from "@/lib/api";
import { blockToTime } from "@/lib/utils";

const SEGMENTS = ["DAM", "RTM", "TAM"] as const;
type Segment = (typeof SEGMENTS)[number];

const SEGMENT_META: Record<Segment, { label: string; color: string; fill: string; desc: string }> = {
  DAM: { label: "Day-Ahead Market",   color: "#006DAE", fill: "#006DAE22", desc: "Gate closure D-1 · 96 blocks" },
  RTM: { label: "Real-Time Market",   color: "#00B398", fill: "#00B39822", desc: "Gate closure 55 min · 96 blocks" },
  TAM: { label: "Term-Ahead Market",  color: "#f59e0b", fill: "#f59e0b22", desc: "Intraday · Weekly · Monthly" },
};

const WORKFLOW = [
  { num: 1, title: "Price Forecast",   href: "/forecast",  color: "#006DAE", desc: "AI 96-block MCP predictions with 95% CI bands" },
  { num: 2, title: "Bid Workspace",    href: "/bids",      color: "#00B398", desc: "LP-optimised volume allocation with DSM awareness" },
  { num: 3, title: "Risk Assessment",  href: "/risk",      color: "#f59e0b", desc: "VaR@95%, DSM penalty estimation, threshold alerts" },
  { num: 4, title: "Post-Market",      href: "/analysis",  color: "#8b5cf6", desc: "Predicted vs actual, basket rate, strategy comparison" },
];

interface BlockData { block: number; predicted_price: number; confidence_low: number; confidence_high: number }
interface SegmentState { blocks: BlockData[]; avg: number; peak: number; min: number; loaded: boolean }

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#0C1A2E] border border-[#1A3558] rounded px-3 py-2 text-xs shadow-lg">
      <p className="text-gray-400 mb-1">{blockToTime(Number(label))}</p>
      <p className="text-white font-semibold">₹{Number(payload[0]?.value ?? 0).toFixed(3)}/kWh</p>
    </div>
  );
};

export default function Home() {
  const [forecasts, setForecasts] = useState<Record<Segment, SegmentState>>({
    DAM: { blocks: [], avg: 0, peak: 0, min: 0, loaded: false },
    RTM: { blocks: [], avg: 0, peak: 0, min: 0, loaded: false },
    TAM: { blocks: [], avg: 0, peak: 0, min: 0, loaded: false },
  });
  const [health, setHealth] = useState<any>(null);

  useEffect(() => {
    // Fetch health once
    getHealth().then(setHealth).catch(() => {});

    // Fetch latest forecast for each segment independently
    SEGMENTS.forEach((seg) => {
      getLatestForecast(seg)
        .then((data) => {
          if (!data?.blocks?.length) return;
          const blocks: BlockData[] = data.blocks;
          const prices = blocks.map((b) => b.predicted_price);
          setForecasts((prev) => ({
            ...prev,
            [seg]: {
              blocks,
              avg: prices.reduce((s, v) => s + v, 0) / prices.length,
              peak: Math.max(...prices),
              min: Math.min(...prices),
              loaded: true,
            },
          }));
        })
        .catch(() => {});
    });
  }, []);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Page title */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Market Overview</h1>
          <p className="text-gray-500 text-xs mt-0.5">
            AI-powered decision intelligence for Indian electricity markets
          </p>
        </div>
        <div className="flex items-center gap-2">
          {health && (
            <span className="text-[10px] text-[#00B398] bg-[#00B398]/10 border border-[#00B398]/20 px-2 py-1 rounded-full">
              DB · {health.db_status || "ok"}
            </span>
          )}
          <span className="text-[10px] text-gray-500 bg-[#132040] border border-[#1A3558] px-2 py-1 rounded-full">
            {new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
          </span>
        </div>
      </div>

      {/* Segment price sparkline cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {SEGMENTS.map((seg) => {
          const meta = SEGMENT_META[seg];
          const state = forecasts[seg];
          const chartData = state.blocks.map((b) => ({
            block: b.block,
            price: b.predicted_price,
            low: b.confidence_low,
            high: b.confidence_high,
          }));

          return (
            <div key={seg} className="card flex flex-col gap-3">
              {/* Header row */}
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className="text-base font-bold"
                      style={{ color: meta.color }}
                    >
                      {seg}
                    </span>
                    <span
                      className="text-[9px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wider"
                      style={{ color: meta.color, background: meta.fill, border: `1px solid ${meta.color}33` }}
                    >
                      {meta.label}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-500 mt-0.5">{meta.desc}</p>
                </div>
                {state.loaded && (
                  <div className="text-right">
                    <div className="text-lg font-bold text-white">
                      ₹{state.avg.toFixed(3)}
                    </div>
                    <div className="text-[10px] text-gray-500">avg/kWh</div>
                  </div>
                )}
              </div>

              {/* Sparkline chart */}
              {state.loaded ? (
                <>
                  <div className="h-24">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartData} margin={{ top: 2, right: 2, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id={`grad-${seg}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor={meta.color} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={meta.color} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="block" hide />
                        <YAxis domain={["auto", "auto"]} hide />
                        <Tooltip content={<CustomTooltip />} />
                        <ReferenceLine
                          y={state.avg}
                          stroke={meta.color}
                          strokeDasharray="3 3"
                          strokeOpacity={0.4}
                        />
                        <Area
                          type="monotone"
                          dataKey="price"
                          stroke={meta.color}
                          strokeWidth={1.5}
                          fill={`url(#grad-${seg})`}
                          dot={false}
                          activeDot={{ r: 3, fill: meta.color }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  {/* Stats row */}
                  <div className="grid grid-cols-3 gap-2 pt-1 border-t border-[var(--border)]">
                    <div className="text-center">
                      <div className="text-[10px] text-gray-500">Peak</div>
                      <div className="text-xs font-semibold text-red-400">₹{state.peak.toFixed(2)}</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-gray-500">Average</div>
                      <div className="text-xs font-semibold" style={{ color: meta.color }}>₹{state.avg.toFixed(2)}</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-gray-500">Trough</div>
                      <div className="text-xs font-semibold text-[#00B398]">₹{state.min.toFixed(2)}</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="h-24 flex flex-col items-center justify-center gap-2">
                  <div className="w-full h-12 bg-[#132040] rounded animate-pulse" />
                  <p className="text-[10px] text-gray-600">
                    No forecast cached — run from{" "}
                    <Link href="/forecast" className="underline text-gray-500 hover:text-gray-300">
                      Price Forecast
                    </Link>
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Workflow steps */}
      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
          Trading Workflow
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {WORKFLOW.map((step) => (
            <Link key={step.href} href={step.href}>
              <div className="card-hover cursor-pointer group">
                <div className="flex items-center gap-2 mb-2">
                  <div
                    className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold text-white shrink-0"
                    style={{ background: step.color }}
                  >
                    {step.num}
                  </div>
                  <span
                    className="text-sm font-semibold group-hover:underline"
                    style={{ color: step.color }}
                  >
                    {step.title}
                  </span>
                </div>
                <p className="text-[11px] text-gray-500 leading-relaxed">{step.desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Market segments info */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">
            Exchange Info · IEX
          </h2>
          <span className="text-[10px] text-gray-600">CERC 2024 DSM · ±10% band · 1.5× penalty</span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {SEGMENTS.map((seg) => (
            <div
              key={seg}
              className="rounded-lg p-3 text-center"
              style={{ background: SEGMENT_META[seg].fill, border: `1px solid ${SEGMENT_META[seg].color}33` }}
            >
              <div className="text-lg font-bold" style={{ color: SEGMENT_META[seg].color }}>
                {seg}
              </div>
              <div className="text-xs text-gray-300 mt-0.5">{SEGMENT_META[seg].label}</div>
              <div className="text-[10px] text-gray-500 mt-1">{SEGMENT_META[seg].desc}</div>
              {forecasts[seg].loaded && (
                <div className="mt-2 text-[10px] text-gray-400">
                  <span style={{ color: SEGMENT_META[seg].color }}>
                    ₹{forecasts[seg].avg.toFixed(3)}
                  </span>{" "}
                  avg forecast
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
