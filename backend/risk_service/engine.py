"""
Risk calculation engine: VaR, DSM penalty estimation, threshold alerts.
"""
from __future__ import annotations

import numpy as np
from common.config import (
    DSM_DEVIATION_BAND,
    DSM_PENALTY_RATE,
    DSM_PRICE_CEILING,
    DEFAULT_VAR_THRESHOLD,
    BLOCK_DURATION_MIN,
)


def calculate_var(
    bid_prices: list[float],
    bid_volumes: list[float],
    predicted_prices: list[float],
    confidence_level: float = 0.95,
) -> float:
    """
    Calculate Value-at-Risk at the given confidence level.
    VaR = potential loss if prices move against the bid.
    Uses parametric VaR based on price forecast uncertainty.
    """
    if not bid_prices or not predicted_prices:
        return 0.0

    prices = np.array(bid_prices)
    volumes = np.array(bid_volumes)
    forecasts = np.array(predicted_prices)

    # Price difference risk per block
    price_diff = prices - forecasts
    # Exposure = volume * price_diff * duration_hours
    duration_hours = BLOCK_DURATION_MIN / 60.0
    exposure_per_block = (
        volumes * np.abs(price_diff) * duration_hours * 1000
    )  # INR (approx kWh->MWh)

    # Portfolio standard deviation
    portfolio_std = (
        np.std(exposure_per_block)
        if len(exposure_per_block) > 1
        else np.mean(exposure_per_block) * 0.2
    )

    # Z-score for confidence level
    from scipy.stats import norm

    z = norm.ppf(confidence_level)

    var = z * portfolio_std * np.sqrt(len(exposure_per_block))
    return round(float(var), 2)


def estimate_dsm_penalty(
    bid_volumes: list[float],
    actual_demand: list[float],
    prices: list[float],
) -> dict:
    """
    Estimate DSM penalties based on deviation between bid and actual demand.
    Returns expected and worst-case penalty amounts.
    """
    if not bid_volumes or not actual_demand:
        return {"expected": 0.0, "worst_case": 0.0}

    vols = np.array(bid_volumes)
    demands = np.array(actual_demand)
    price_arr = np.array(prices)

    # Deviation as percentage
    deviations = np.abs(vols - demands) / np.clip(demands, 0.1, None)

    # Blocks exceeding the permissible band
    penalized_mask = deviations > DSM_DEVIATION_BAND
    excess_deviation = np.clip(deviations - DSM_DEVIATION_BAND, 0, None)

    # Penalty = excess_volume * price * penalty_rate per block
    duration_hours = BLOCK_DURATION_MIN / 60.0
    excess_volume_mwh = np.abs(vols - demands) * penalized_mask * duration_hours
    penalties = excess_volume_mwh * price_arr * DSM_PENALTY_RATE * 1000  # INR

    expected_penalty = float(np.sum(penalties))

    # Worst case: stress scenario — assume 30% deviation on all blocks at forecasted price.
    # Only the excess beyond the permissible band (DSM_DEVIATION_BAND) is penalised.
    stress_deviation = 0.30
    excess_frac = max(0.0, stress_deviation - DSM_DEVIATION_BAND)  # = 0.20
    stress_excess_mwh = vols * excess_frac * duration_hours
    stress_prices = np.minimum(price_arr, DSM_PRICE_CEILING)
    worst_case = float(
        np.sum(stress_excess_mwh * stress_prices * DSM_PENALTY_RATE * 1000)
    )

    return {
        "expected": round(expected_penalty, 2),
        "worst_case": round(worst_case, 2),
        "penalized_blocks": int(penalized_mask.sum()),
    }


def assess_risk(
    bid_prices: list[float],
    bid_volumes: list[float],
    predicted_prices: list[float],
    confidence_low: list[float] | None = None,
    confidence_high: list[float] | None = None,
    var_threshold: float = DEFAULT_VAR_THRESHOLD,
) -> dict:
    """Full risk assessment for a set of bids."""
    var_95 = calculate_var(bid_prices, bid_volumes, predicted_prices)

    # Estimate demand uncertainty from forecast confidence intervals.
    # CI half-width as a fraction of predicted price is used as a proxy
    # for volume uncertainty (wider CI → less certain → larger demand swing).
    if confidence_low and confidence_high and predicted_prices:
        ci_widths = [
            (h - l) / max(p, 0.01)
            for l, h, p in zip(confidence_low, confidence_high, predicted_prices)
        ]
        avg_uncertainty = float(np.mean(ci_widths)) / 2.0  # half-width fraction
        demand_uncertainty = max(0.02, min(avg_uncertainty, 0.25))  # clamp 2%–25%
    else:
        demand_uncertainty = 0.08  # fallback: 8% if no CI data

    # Simulate expected demand using CI-derived uncertainty (deterministic, no random seed)
    simulated_demand = [v * (1.0 + demand_uncertainty) for v in bid_volumes]
    penalty_info = estimate_dsm_penalty(bid_volumes, simulated_demand, predicted_prices)

    total_exposure = var_95 + penalty_info["expected"]

    alert_triggered = total_exposure > var_threshold
    alert_details = None
    if alert_triggered:
        alert_details = {
            "threshold": var_threshold,
            "total_exposure": total_exposure,
            "message": f"Total exposure INR {total_exposure:,.0f} exceeds threshold INR {var_threshold:,.0f}",
            "breakdown": {
                "var_95": var_95,
                "expected_penalty": penalty_info["expected"],
            },
        }

    return {
        "var_95": var_95,
        "expected_dsm_penalty": penalty_info["expected"],
        "worst_case_penalty": penalty_info["worst_case"],
        "total_exposure": round(total_exposure, 2),
        "alert_triggered": alert_triggered,
        "alert_details": alert_details,
    }
