"use client";

import { useState, useEffect, useRef } from "react";
import { recommendBids, submitBids, validateBids, assessRisk } from "@/lib/api";
import { blockToTime, SEGMENTS, STRATEGIES, getTomorrowDate, formatINR } from "@/lib/utils";

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

export default function BidsPage() {
  const [segment, setSegment] = useState("DAM");
  const [strategy, setStrategy] = useState("balanced");
  const [targetDate, setTargetDate] = useState(getTomorrowDate());
  const [demandMw, setDemandMw] = useState(500);
  const [bids, setBids] = useState<BidRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<any>(null);
  const [validationResult, setValidationResult] = useState<any>(null);
  const [editingBlock, setEditingBlock] = useState<number | null>(null);
  const [liveRisk, setLiveRisk] = useState<any>(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskTimestamp, setRiskTimestamp] = useState<string>("");
  const riskDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-assess risk when bids change (debounced 600ms)
  useEffect(() => {
    if (bids.length === 0) {
      setLiveRisk(null);
      return;
    }
    if (riskDebounceRef.current) clearTimeout(riskDebounceRef.current);
    riskDebounceRef.current = setTimeout(async () => {
      setRiskLoading(true);
      try {
        const result = await assessRisk(
          `live-${Date.now()}`,
          segment,
          bids.map((b) => ({
            block: b.block,
            segment: b.segment,
            price: b.price,
            volume_mw: b.volume_mw,
          }))
        );
        setLiveRisk(result);
        setRiskTimestamp(new Date().toLocaleTimeString());
      } catch {
        // Silently ignore — risk panel just won't update
      }
      setRiskLoading(false);
    }, 600);
    return () => {
      if (riskDebounceRef.current) clearTimeout(riskDebounceRef.current);
    };
  }, [bids, segment]);

  const handleRecommend = async () => {
    setLoading(true);
    setSubmitResult(null);
    setValidationResult(null);
    try {
      const recs = await recommendBids(targetDate, strategy, segment, demandMw);
      setBids(
        recs.map((r: any) => ({
          ...r,
          is_overridden: false,
          override_reason: "",
        }))
      );
    } catch (e: any) {
      alert(
        e.response?.data?.detail ||
          "Failed to generate recommendations. Run forecast first."
      );
    }
    setLoading(false);
  };

  const handleCellEdit = (
    block: number,
    field: "price" | "volume_mw",
    value: string
  ) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    setBids((prev) =>
      prev.map((b) =>
        b.block === block
          ? { ...b, [field]: num, is_overridden: true }
          : b
      )
    );
  };

  const handleOverrideReason = (block: number, reason: string) => {
    setBids((prev) =>
      prev.map((b) =>
        b.block === block ? { ...b, override_reason: reason } : b
      )
    );
    setEditingBlock(null);
  };

  const handleValidate = async () => {
    try {
      const result = await validateBids(
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
        }))
      );
      setValidationResult(result);
    } catch (e: any) {
      alert("Validation failed");
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const result = await submitBids(
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
        }))
      );
      setSubmitResult(result);
    } catch (e: any) {
      alert(e.response?.data?.detail || "Submission failed");
    }
    setSubmitting(false);
  };

  const totalVolume = bids.reduce((s, b) => s + b.volume_mw, 0);
  const avgPrice = bids.length
    ? bids.reduce((s, b) => s + b.price, 0) / bids.length
    : 0;
  const overrideCount = bids.filter((b) => b.is_overridden).length;
  const violationCount = bids.reduce(
    (s, b) => s + (b.constraint_violations?.length || 0),
    0
  );

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Bid Workspace</h1>
        <p className="text-gray-400 text-sm">
          AI-recommended bids with manual override and constraint enforcement
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
                  className={`px-4 py-2 text-sm capitalize transition-colors ${
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
          <button
            onClick={handleRecommend}
            disabled={loading}
            className="btn-primary"
          >
            {loading ? "Loading..." : "Get AI Recommendations"}
          </button>
        </div>
      </div>

      {submitResult && (
        <div
          className={`card mb-4 ${
            submitResult.status === "submitted"
              ? "bg-green-900/20 border-green-600/30"
              : "bg-yellow-900/20 border-yellow-600/30"
          }`}
        >
          <p
            className={
              submitResult.status === "submitted"
                ? "text-green-400"
                : "text-yellow-400"
            }
          >
            Bids {submitResult.status} — Session: {submitResult.session_id} |{" "}
            {submitResult.bid_count} bids | {submitResult.violations?.length || 0}{" "}
            violations
          </p>
        </div>
      )}

      {validationResult && (
        <div
          className={`card mb-4 ${
            validationResult.valid
              ? "bg-green-900/20 border-green-600/30"
              : "bg-red-900/20 border-red-600/30"
          }`}
        >
          <p
            className={
              validationResult.valid ? "text-green-400" : "text-red-400"
            }
          >
            {validationResult.valid
              ? "All bids pass constraint validation"
              : `${validationResult.violation_count} constraint violation(s) found`}
          </p>
        </div>
      )}

      {bids.length > 0 && (
        <>
          {/* Summary bar */}
          <div className="grid grid-cols-4 gap-4 mb-4">
            <div className="card text-center py-3">
              <div className="text-xs text-gray-400">Total Volume</div>
              <div className="text-xl font-bold">{totalVolume.toFixed(1)} MW</div>
            </div>
            <div className="card text-center py-3">
              <div className="text-xs text-gray-400">Avg Bid Price</div>
              <div className="text-xl font-bold text-blue-400">
                ₹{avgPrice.toFixed(2)}
              </div>
            </div>
            <div className="card text-center py-3">
              <div className="text-xs text-gray-400">Overrides</div>
              <div className="text-xl font-bold text-amber-400">
                {overrideCount}
              </div>
            </div>
            <div className="card text-center py-3">
              <div className="text-xs text-gray-400">Violations</div>
              <div
                className={`text-xl font-bold ${violationCount > 0 ? "text-red-400" : "text-green-400"}`}
              >
                {violationCount}
              </div>
            </div>
          </div>

          {/* Bid table */}
          <div className="card mb-4">
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-sm font-semibold text-gray-300">
                Bid Table — {segment} — {strategy}
              </h2>
              <div className="flex gap-2">
                <button onClick={handleValidate} className="btn-secondary text-sm">
                  Validate
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="btn-primary text-sm"
                >
                  {submitting ? "Submitting..." : "Submit Bids"}
                </button>
              </div>
            </div>

            <div className="max-h-[500px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-gray-400 sticky top-0 bg-[#1a2332] z-10">
                  <tr>
                    <th className="text-left py-2 px-2">Block</th>
                    <th className="text-left py-2 px-2">Time</th>
                    <th className="text-right py-2 px-2">Price (₹/kWh)</th>
                    <th className="text-right py-2 px-2">Volume (MW)</th>
                    <th className="text-center py-2 px-2">Status</th>
                    <th className="text-left py-2 px-2">Override Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {bids.map((b) => {
                    const hasViolation =
                      b.constraint_violations &&
                      b.constraint_violations.length > 0;
                    return (
                      <tr
                        key={b.block}
                        className={`border-t border-gray-800 ${
                          hasViolation ? "bg-red-900/10" : ""
                        }`}
                      >
                        <td className="py-1.5 px-2 font-medium">{b.block}</td>
                        <td className="py-1.5 px-2 text-gray-400">
                          {blockToTime(b.block)}
                        </td>
                        <td className="py-1.5 px-2 text-right">
                          <input
                            type="number"
                            step="0.01"
                            value={b.price}
                            onChange={(e) =>
                              handleCellEdit(b.block, "price", e.target.value)
                            }
                            className={`w-20 bg-transparent border-b text-right focus:outline-none focus:border-blue-400 ${
                              hasViolation
                                ? "border-red-500 text-red-300"
                                : b.is_overridden
                                  ? "border-amber-500 text-amber-300"
                                  : "border-gray-700 text-white"
                            }`}
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
                                e.target.value
                              )
                            }
                            className={`w-20 bg-transparent border-b text-right focus:outline-none focus:border-blue-400 ${
                              b.is_overridden
                                ? "border-amber-500 text-amber-300"
                                : "border-gray-700 text-white"
                            }`}
                          />
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          {hasViolation ? (
                            <span
                              className="badge-violation cursor-help"
                              title={b.constraint_violations
                                .map((v: any) => v.message)
                                .join("; ")}
                            >
                              ⚠ Violation
                            </span>
                          ) : b.is_overridden ? (
                            <span className="badge-warning">Edited</span>
                          ) : (
                            <span className="badge-ok">AI</span>
                          )}
                        </td>
                        <td className="py-1.5 px-2">
                          {b.is_overridden && (
                            <>
                              {editingBlock === b.block ? (
                                <select
                                  className="select-field text-xs py-1"
                                  value={b.override_reason}
                                  onChange={(e) =>
                                    handleOverrideReason(
                                      b.block,
                                      e.target.value
                                    )
                                  }
                                  autoFocus
                                  onBlur={() => setEditingBlock(null)}
                                >
                                  <option value="">Select reason...</option>
                                  {OVERRIDE_REASONS.map((r) => (
                                    <option key={r} value={r}>
                                      {r}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <button
                                  onClick={() => setEditingBlock(b.block)}
                                  className="text-xs text-amber-400 hover:underline"
                                >
                                  {b.override_reason || "Add reason..."}
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
        </>
      )}

      {/* Live Risk Panel — auto-updates on bid changes */}
      {liveRisk && (
        <div className="mt-6">
          {liveRisk.alert_triggered && (
            <div className="card mb-4 bg-red-900/30 border-red-600 animate-pulse">
              <div className="flex items-center gap-3">
                <span className="text-2xl">🚨</span>
                <div>
                  <h3 className="text-red-400 font-bold">RISK ALERT</h3>
                  <p className="text-red-300 text-sm">
                    {liveRisk.alert_details?.message}
                  </p>
                </div>
              </div>
            </div>
          )}
          <div className="card">
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-sm font-semibold text-gray-300">
                Live Risk Assessment
              </h2>
              <span className="text-xs text-gray-500">
                {riskLoading ? "Recalculating..." : `Updated ${riskTimestamp}`}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div className="text-center">
                <div className="text-xs text-gray-400">VaR (95%)</div>
                <div className="text-lg font-bold text-blue-400">
                  {formatINR(liveRisk.var_95)}
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-400">DSM Penalty</div>
                <div className="text-lg font-bold text-amber-400">
                  {formatINR(liveRisk.expected_dsm_penalty)}
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-400">Worst Case</div>
                <div className="text-lg font-bold text-red-400">
                  {formatINR(liveRisk.worst_case_penalty)}
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-400">Total Exposure</div>
                <div
                  className={`text-lg font-bold ${liveRisk.alert_triggered ? "text-red-400" : "text-green-400"}`}
                >
                  {formatINR(liveRisk.total_exposure)}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
