"use client";

import { useState } from "react";
import {
  becknSearch,
  becknSelect,
  becknInit,
  becknConfirm,
  becknListOrders,
  type BecknSearchResponse,
  type BecknOrder,
} from "@/lib/api";
import { formatINR, getTomorrowDate, SEGMENTS } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = "search" | "select" | "init" | "confirm" | "done";

interface SelectedProvider {
  exchange_id: string;
  exchange_name: string;
  transaction_id: string;
  avg_price: number;
  total_volume_mw: number;
  total_value_inr: number;
  items: any[];
  block_start: number;
  block_end: number;
}

// ── Exchange meta ─────────────────────────────────────────────────────────────

const EXCHANGE_COLORS: Record<string, string> = {
  IEX: "#006DAE",
  PXIL: "#7C3AED",
  HPX: "#D97706",
};

const EXCHANGE_BADGE: Record<string, string> = {
  IEX: "bg-[#EEF5FB] text-[#006DAE] border border-[#C7D9EC]",
  PXIL: "bg-purple-50 text-purple-700 border border-purple-200",
  HPX: "bg-amber-50 text-amber-700 border border-amber-200",
};

// ── Step indicator ────────────────────────────────────────────────────────────

const STEPS = [
  { key: "search", label: "1. Discover" },
  { key: "select", label: "2. Select" },
  { key: "init", label: "3. Review" },
  { key: "confirm", label: "4. Confirm" },
];

function StepBar({ current }: { current: Step }) {
  const idx = STEPS.findIndex((s) => s.key === current);
  return (
    <div className="flex items-center gap-0 mb-6">
      {STEPS.map((s, i) => (
        <div key={s.key} className="flex items-center">
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              i <= idx
                ? "bg-[var(--brand-blue)] text-white"
                : "bg-gray-100 text-gray-400"
            }`}
          >
            {s.label}
          </div>
          {i < STEPS.length - 1 && (
            <div
              className={`w-8 h-px mx-1 ${
                i < idx ? "bg-[var(--brand-blue)]" : "bg-gray-200"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BecknPage() {
  // Search params
  const [segment, setSegment] = useState("DAM");
  const [targetDate, setTargetDate] = useState(getTomorrowDate());
  const [blockStart, setBlockStart] = useState(1);
  const [blockEnd, setBlockEnd] = useState(96);
  const [demandMw, setDemandMw] = useState(500);

  // Flow state
  const [step, setStep] = useState<Step>("search");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Results
  const [searchResult, setSearchResult] = useState<BecknSearchResponse | null>(null);
  const [selected, setSelected] = useState<SelectedProvider | null>(null);
  const [initResult, setInitResult] = useState<any>(null);
  const [confirmResult, setConfirmResult] = useState<any>(null);

  // Orders panel
  const [orders, setOrders] = useState<BecknOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleSearch() {
    setLoading(true);
    setError(null);
    setSearchResult(null);
    setSelected(null);
    setInitResult(null);
    setConfirmResult(null);
    try {
      const result = await becknSearch(segment, targetDate, blockStart, blockEnd, demandMw);
      setSearchResult(result);
      setStep("select");
    } catch (e: any) {
      setError(e?.response?.data?.detail || e.message || "Search failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSelect(provider: BecknSearchResponse["providers"][0]) {
    setLoading(true);
    setError(null);
    try {
      await becknSelect(
        searchResult!.transaction_id,
        provider.exchange_id,
        segment,
        targetDate,
        blockStart,
        blockEnd,
        demandMw,
      );
      setSelected({
        exchange_id: provider.exchange_id,
        exchange_name: provider.exchange_name,
        transaction_id: searchResult!.transaction_id,
        avg_price: provider.avg_price,
        total_volume_mw: provider.total_volume_mw,
        total_value_inr: provider.total_value_inr,
        items: provider.items,
        block_start: provider.block_start,
        block_end: provider.block_end,
      });
      setStep("init");
    } catch (e: any) {
      setError(e?.response?.data?.detail || e.message || "Select failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleInit() {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const result = await becknInit(
        selected.transaction_id,
        selected.exchange_id,
        segment,
        targetDate,
        selected.block_start,
        selected.block_end,
        demandMw,
      );
      setInitResult(result);
      setStep("confirm");
    } catch (e: any) {
      setError(e?.response?.data?.detail || e.message || "Init failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm() {
    if (!initResult) return;
    setLoading(true);
    setError(null);
    try {
      const result = await becknConfirm(
        initResult.order_id,
        initResult.transaction_id,
      );
      setConfirmResult(result);
      setStep("done");
    } catch (e: any) {
      setError(e?.response?.data?.detail || e.message || "Confirm failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadOrders() {
    setOrdersLoading(true);
    try {
      const result = await becknListOrders();
      setOrders(result.orders);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e.message || "Failed to load orders");
    } finally {
      setOrdersLoading(false);
    }
  }

  function handleReset() {
    setStep("search");
    setSearchResult(null);
    setSelected(null);
    setInitResult(null);
    setConfirmResult(null);
    setError(null);
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 border border-purple-200">
            Beckn Protocol
          </span>
          <span className="text-xs text-gray-400">UEI Energy Domain · BAP Implementation</span>
        </div>
        <h1 className="text-xl font-bold text-gray-900">Multi-Exchange Market Discovery</h1>
        <p className="text-sm text-gray-500 mt-1">
          Discover, compare, and place bids across IEX, PXIL, and HPX using the Beckn open protocol.
        </p>
      </div>

      {/* Step bar */}
      <StepBar current={step === "done" ? "confirm" : step} />

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── Step 1: Search ─────────────────────────────────────── */}
      {(step === "search" || step === "select") && (
        <div className="card mb-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            {step === "search" ? "Search Parameters" : "Search Parameters (modify to re-search)"}
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {/* Segment */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Segment</label>
              <select
                className="select-field w-full text-sm"
                value={segment}
                onChange={(e) => setSegment(e.target.value)}
              >
                {SEGMENTS.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>

            {/* Date */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Date</label>
              <input
                type="date"
                className="input-field w-full text-sm"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
              />
            </div>

            {/* Block range */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Block Start</label>
              <input
                type="number"
                className="input-field w-full text-sm"
                min={1}
                max={96}
                value={blockStart}
                onChange={(e) => setBlockStart(Number(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Block End</label>
              <input
                type="number"
                className="input-field w-full text-sm"
                min={1}
                max={96}
                value={blockEnd}
                onChange={(e) => setBlockEnd(Number(e.target.value))}
              />
            </div>

            {/* Demand */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Demand (MW)</label>
              <input
                type="number"
                className="input-field w-full text-sm"
                min={1}
                value={demandMw}
                onChange={(e) => setDemandMw(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              onClick={handleSearch}
              disabled={loading}
              className="btn-primary text-sm"
            >
              {loading && step === "search" ? "Searching..." : "Search All Exchanges"}
            </button>
            {step === "select" && (
              <button onClick={handleReset} className="btn-secondary text-sm">
                Reset
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Step 2: Select exchange ───────────────────────────── */}
      {step === "select" && searchResult && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">
            Exchange Catalog — {searchResult.providers.length} providers responded
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {searchResult.providers.map((p) => {
              const color = EXCHANGE_COLORS[p.exchange_id] ?? "#666";
              const isCheapest =
                p.avg_price ===
                Math.min(...searchResult.providers.map((x) => x.avg_price));
              return (
                <div
                  key={p.exchange_id}
                  className={`card cursor-pointer border-2 transition-all hover:shadow-md ${
                    isCheapest ? "border-[var(--brand-teal)]" : "border-[var(--border)]"
                  }`}
                  onClick={() => !loading && handleSelect(p)}
                >
                  {isCheapest && (
                    <div className="text-[10px] font-bold text-[var(--brand-teal)] mb-1 uppercase tracking-wide">
                      Best Price
                    </div>
                  )}
                  <div className="flex items-center gap-2 mb-3">
                    <div
                      className="w-2 h-8 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <div>
                      <div
                        className={`text-xs font-bold rounded px-1.5 py-0.5 inline-block ${EXCHANGE_BADGE[p.exchange_id]}`}
                      >
                        {p.exchange_id}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5 leading-tight">
                        {p.exchange_name}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Avg Price</span>
                      <span className="font-semibold" style={{ color }}>
                        ₹{p.avg_price.toFixed(4)}/kWh
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Total Volume</span>
                      <span className="font-medium">{p.total_volume_mw.toFixed(0)} MW</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Total Value</span>
                      <span className="font-medium">{formatINR(p.total_value_inr)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Blocks</span>
                      <span className="font-medium">
                        {p.block_start}–{p.block_end} ({p.items.length})
                      </span>
                    </div>
                  </div>

                  <button
                    disabled={loading}
                    className="mt-3 w-full py-1.5 text-xs font-semibold rounded-lg transition-colors"
                    style={{
                      backgroundColor: color + "15",
                      color,
                      border: `1px solid ${color}40`,
                    }}
                  >
                    {loading ? "Selecting..." : `Select ${p.exchange_id}`}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Step 3: Init / Review ────────────────────────────── */}
      {(step === "init" || step === "confirm" || step === "done") && selected && (
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-700">
              Order Review — {selected.exchange_id}
            </h2>
            {step === "init" && (
              <button
                onClick={() => setStep("select")}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                ← Change exchange
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500">Exchange</div>
              <div
                className={`mt-1 text-xs font-bold rounded px-1.5 py-0.5 inline-block ${EXCHANGE_BADGE[selected.exchange_id]}`}
              >
                {selected.exchange_id}
              </div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500">Avg Price</div>
              <div className="text-sm font-bold text-gray-900 mt-0.5">
                ₹{selected.avg_price.toFixed(4)}/kWh
              </div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500">Total Volume</div>
              <div className="text-sm font-bold text-gray-900 mt-0.5">
                {selected.total_volume_mw.toFixed(0)} MW
              </div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500">Total Value</div>
              <div className="text-sm font-bold text-gray-900 mt-0.5">
                {formatINR(selected.total_value_inr)}
              </div>
            </div>
          </div>

          {/* Fulfillment details (shown after init) */}
          {initResult?.fulfillment && (
            <div className="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
              <div className="text-xs font-semibold text-blue-700 mb-2">
                Fulfillment Details
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                {Object.entries(initResult.fulfillment).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-gray-500 capitalize">
                      {k.replace(/_/g, " ")}:{" "}
                    </span>
                    <span className="text-gray-800 font-medium">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Block price table (first 16 blocks) */}
          <div className="overflow-hidden rounded-lg border border-[var(--border)]">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Block</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Time</th>
                  <th className="text-right px-3 py-2 font-semibold text-gray-600">Price (₹/kWh)</th>
                  <th className="text-right px-3 py-2 font-semibold text-gray-600">Volume (MW)</th>
                  <th className="text-right px-3 py-2 font-semibold text-gray-600">CI Low</th>
                  <th className="text-right px-3 py-2 font-semibold text-gray-600">CI High</th>
                </tr>
              </thead>
              <tbody>
                {selected.items.slice(0, 16).map((item: any, i: number) => (
                  <tr key={item.block} className={i % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
                    <td className="px-3 py-1.5 font-medium text-gray-800">{item.block}</td>
                    <td className="px-3 py-1.5 text-gray-500">{item.time}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-900">
                      {item.price_inr_kwh.toFixed(4)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-700">{item.volume_mw}</td>
                    <td className="px-3 py-1.5 text-right text-gray-400">
                      {item.confidence_low.toFixed(4)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-400">
                      {item.confidence_high.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {selected.items.length > 16 && (
              <div className="text-center py-2 text-xs text-gray-400 bg-gray-50 border-t border-[var(--border)]">
                + {selected.items.length - 16} more blocks
              </div>
            )}
          </div>

          {step === "init" && (
            <div className="mt-4">
              <button
                onClick={handleInit}
                disabled={loading}
                className="btn-primary text-sm"
              >
                {loading ? "Initialising..." : "Initialise Order (Draft)"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Step 4: Confirm ──────────────────────────────────── */}
      {step === "confirm" && initResult && (
        <div className="card mb-6 border-[var(--brand-blue)] border-2">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">
            Ready to Confirm
          </h2>
          <div className="flex items-center gap-4 mb-4">
            <div>
              <div className="text-xs text-gray-500">Order ID</div>
              <div className="font-mono font-bold text-gray-900">{initResult.order_id}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Status</div>
              <div className="text-xs font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                DRAFT
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Total Value</div>
              <div className="text-sm font-bold">{formatINR(initResult.total_value_inr)}</div>
            </div>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            Confirming this order will submit your bid to{" "}
            <strong>{selected?.exchange_id}</strong> for{" "}
            <strong>{segment}</strong> on <strong>{targetDate}</strong>.
            This action is irreversible.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="btn-teal text-sm"
            >
              {loading ? "Confirming..." : "Confirm Order"}
            </button>
            <button onClick={handleReset} className="btn-secondary text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Done ────────────────────────────────────────────── */}
      {step === "done" && confirmResult && (
        <div className="card mb-6 border-[var(--brand-teal)] border-2">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-full bg-[var(--brand-teal)] flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-bold text-gray-900">Order Confirmed</div>
              <div className="text-xs text-gray-500">Beckn on_confirm received</div>
            </div>
          </div>
          <p className="text-sm text-gray-700 mb-3">{confirmResult.message}</p>
          <div className="flex items-center gap-3 text-xs">
            <span className="font-mono bg-gray-100 px-2 py-0.5 rounded text-gray-700">
              {confirmResult.order_id}
            </span>
            <span className="text-xs font-semibold text-[var(--brand-teal)] bg-teal-50 px-2 py-0.5 rounded-full border border-teal-200">
              CONFIRMED
            </span>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={handleReset} className="btn-primary text-sm">
              New Discovery
            </button>
            <button
              onClick={handleLoadOrders}
              className="btn-secondary text-sm"
            >
              View All Orders
            </button>
          </div>
        </div>
      )}

      {/* ── Orders panel ─────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-700">Beckn Orders</h2>
          <button
            onClick={handleLoadOrders}
            disabled={ordersLoading}
            className="btn-secondary text-xs py-1 px-2"
          >
            {ordersLoading ? "Loading..." : "Refresh"}
          </button>
        </div>

        {orders.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-6">
            No orders yet. Complete the flow above to create an order.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[var(--border)]">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Order ID</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Exchange</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Segment</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Date</th>
                  <th className="text-right px-3 py-2 font-semibold text-gray-600">Avg ₹/kWh</th>
                  <th className="text-right px-3 py-2 font-semibold text-gray-600">Value</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-600">Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o, i) => (
                  <tr key={o.order_id} className={i % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
                    <td className="px-3 py-2 font-mono text-gray-700">{o.order_id}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs font-bold rounded px-1.5 py-0.5 ${EXCHANGE_BADGE[o.exchange_id] ?? ""}`}>
                        {o.exchange_id}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-700">{o.segment}</td>
                    <td className="px-3 py-2 text-gray-600">{o.target_date}</td>
                    <td className="px-3 py-2 text-right font-mono">₹{o.avg_price.toFixed(4)}</td>
                    <td className="px-3 py-2 text-right">{formatINR(o.total_value_inr)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`text-xs font-semibold rounded-full px-2 py-0.5 ${
                          o.status === "confirmed"
                            ? "bg-teal-50 text-teal-700 border border-teal-200"
                            : "bg-amber-50 text-amber-700 border border-amber-200"
                        }`}
                      >
                        {o.status.toUpperCase()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Beckn protocol info footer */}
      <div className="mt-6 p-4 bg-gray-50 rounded-lg border border-[var(--border)] text-xs text-gray-500">
        <div className="font-semibold text-gray-700 mb-1">About this integration</div>
        <p>
          This page implements the <strong>BAP (Beckn Application Platform)</strong> side of the{" "}
          <strong>Unified Energy Interface (UEI)</strong> protocol. The platform broadcasts a{" "}
          <code className="font-mono bg-gray-100 px-1 rounded">search</code> intent to all three
          mock BPPs (IEX, PXIL, HPX), collects catalogs, and guides the user through{" "}
          <code className="font-mono bg-gray-100 px-1 rounded">select → init → confirm</code>.
          Exchange prices are derived from our ML forecast model with deterministic per-exchange offsets.
        </p>
      </div>
    </div>
  );
}
