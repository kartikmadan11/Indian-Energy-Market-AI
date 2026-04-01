"""
Price Forecasting Engine using HistGradientBoostingRegressor.
Produces block-level predictions for 96 blocks with confidence intervals.
Supports parameterised training with hyperparameter tuning.
"""

import pickle
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.model_selection import (
    train_test_split,
    RandomizedSearchCV,
    GridSearchCV,
    TimeSeriesSplit,
)
from sklearn.metrics import mean_absolute_percentage_error, mean_squared_error, r2_score
from scipy.stats import uniform, randint

from backend.common.config import NUM_BLOCKS, DATA_DIR

MODEL_DIR = DATA_DIR / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)


def _serialise(v):
    """Make numpy/other types JSON-friendly."""
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    if isinstance(v, np.ndarray):
        return v.tolist()
    return v


# Base feature names (always present)
BASE_FEATURE_NAMES = [
    "hour",
    "block_in_hour",
    "day_of_week",
    "month",
    "is_weekend",
    "demand_mw",
    "supply_mw",
    "renewable_gen_mw",
    "temperature",
    "lag_price_1d",
    "lag_price_7d",
    "rolling_avg_7d",
    "rolling_std_7d",
    "block_sin",
    "block_cos",
]

# Default tuning search space
DEFAULT_PARAM_GRID = {
    "max_iter": [200, 300, 500, 800, 1200],
    "max_depth": [4, 6, 8, 10, 12, None],
    "learning_rate": [0.01, 0.03, 0.05, 0.08, 0.1, 0.15],
    "min_samples_leaf": [5, 10, 20, 30, 50],
    "l2_regularization": [0.0, 0.01, 0.1, 1.0],
    "max_bins": [128, 200, 255],
}


class PriceForecastModel:
    def __init__(self, segment: str = "DAM"):
        self.segment = segment
        self.model = None
        self.feature_importances = None
        self.feature_names: list[str] = []
        self.model_path = MODEL_DIR / f"forecast_{segment.lower()}.pkl"

    def _build_features(
        self,
        df: pd.DataFrame,
        extra_lags: Optional[list] = None,
        rolling_windows: Optional[list] = None,
        include_demand_supply_ratio: bool = True,
        include_price_momentum: bool = True,
        include_ema: bool = True,
        ema_span: int = 7,
    ) -> tuple[pd.DataFrame, list[str]]:
        """Engineer features from raw price history. Returns (df, feature_names)."""
        df = df.sort_values(["date", "block"]).copy()
        df["datetime"] = pd.to_datetime(df["date"])
        df["hour"] = (df["block"] - 1) // 4
        df["block_in_hour"] = (df["block"] - 1) % 4
        df["day_of_week"] = df["datetime"].dt.dayofweek
        df["month"] = df["datetime"].dt.month
        df["is_weekend"] = (df["day_of_week"] >= 5).astype(int)

        # Cyclic encoding of block position
        df["block_sin"] = np.sin(2 * np.pi * df["block"] / NUM_BLOCKS)
        df["block_cos"] = np.cos(2 * np.pi * df["block"] / NUM_BLOCKS)

        # Standard lag features
        df["lag_price_1d"] = df.groupby("block")["mcp"].shift(1)
        df["lag_price_7d"] = df.groupby("block")["mcp"].shift(7)

        feature_names = list(BASE_FEATURE_NAMES)
        drop_subset = ["lag_price_1d"]

        # Extra lag features
        if extra_lags:
            for lag in extra_lags:
                col = f"lag_price_{lag}d"
                df[col] = df.groupby("block")["mcp"].shift(lag)
                feature_names.append(col)
                drop_subset.append(col)

        # Rolling statistics for each window
        if rolling_windows is None:
            rolling_windows = [7]
        for w in rolling_windows:
            avg_col = f"rolling_avg_{w}d"
            std_col = f"rolling_std_{w}d"
            df[avg_col] = df.groupby("block")["mcp"].transform(
                lambda x: x.rolling(w, min_periods=1).mean()
            )
            df[std_col] = df.groupby("block")["mcp"].transform(
                lambda x: x.rolling(w, min_periods=1).std().fillna(0)
            )
            # Only add if not already in base features
            if avg_col not in feature_names:
                feature_names.append(avg_col)
            if std_col not in feature_names:
                feature_names.append(std_col)

        # Rolling median
        for w in rolling_windows:
            med_col = f"rolling_median_{w}d"
            df[med_col] = df.groupby("block")["mcp"].transform(
                lambda x: x.rolling(w, min_periods=1).median()
            )
            feature_names.append(med_col)

        # Demand/supply ratio
        if include_demand_supply_ratio:
            df["demand_supply_ratio"] = df["demand_mw"] / df["supply_mw"].clip(lower=1)
            feature_names.append("demand_supply_ratio")

        # Price momentum (rate of change)
        if include_price_momentum:
            df["price_momentum"] = (
                df.groupby("block")["mcp"].pct_change(periods=1).fillna(0)
            )
            feature_names.append("price_momentum")

        # Exponential moving average
        if include_ema:
            df["ema_price"] = df.groupby("block")["mcp"].transform(
                lambda x: x.ewm(span=ema_span, min_periods=1).mean()
            )
            feature_names.append("ema_price")

        # Fill missing numeric columns
        for col in ["demand_mw", "supply_mw", "renewable_gen_mw", "temperature"]:
            if col not in df.columns:
                df[col] = 0.0
            df[col] = df[col].fillna(
                df[col].median() if df[col].median() == df[col].median() else 0
            )

        df = df.dropna(subset=drop_subset)
        return df, feature_names

    def train(
        self,
        df: pd.DataFrame,
        test_size: float = 0.2,
        shuffle: bool = False,
        hyperparams: Optional[dict] = None,
        tuning: Optional[dict] = None,
        feature_cfg: Optional[dict] = None,
    ):
        """
        Train on historical price data.

        Parameters
        ----------
        hyperparams : dict  – Passed directly to HistGradientBoostingRegressor
        tuning      : dict  – If provided, runs CV search. Keys: method, n_iter, cv_folds, scoring, param_grid
        feature_cfg : dict  – Passed to _build_features (extra_lags, rolling_windows, …)
        """
        df = df[df["segment"] == self.segment].copy()
        if len(df) < NUM_BLOCKS * 10:
            raise ValueError(f"Need at least 10 days of data, got {len(df)} rows")

        feat_kwargs = feature_cfg or {}
        df, feature_names = self._build_features(df, **feat_kwargs)
        self.feature_names = feature_names

        X = df[feature_names].values
        y = df["mcp"].values

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, shuffle=shuffle
        )

        best_params = None

        if tuning:
            # ── Hyperparameter search ───────────────────────────────
            param_grid = tuning.get("param_grid") or DEFAULT_PARAM_GRID
            method = tuning.get("method", "random")
            cv_folds = tuning.get("cv_folds", 5)
            scoring = tuning.get("scoring", "neg_mean_absolute_percentage_error")
            n_iter = tuning.get("n_iter", 30)

            base_estimator = HistGradientBoostingRegressor(random_state=42)

            # Use TimeSeriesSplit if not shuffled to respect temporal order
            cv = TimeSeriesSplit(n_splits=cv_folds) if not shuffle else cv_folds

            if method == "grid":
                searcher = GridSearchCV(
                    base_estimator,
                    param_grid,
                    cv=cv,
                    scoring=scoring,
                    n_jobs=-1,
                    verbose=0,
                )
            else:
                searcher = RandomizedSearchCV(
                    base_estimator,
                    param_grid,
                    n_iter=n_iter,
                    cv=cv,
                    scoring=scoring,
                    n_jobs=-1,
                    random_state=42,
                    verbose=0,
                )

            searcher.fit(X_train, y_train)
            self.model = searcher.best_estimator_
            best_params = searcher.best_params_
            cv_results_summary = {
                "best_score": round(float(searcher.best_score_), 4),
                "candidates_evaluated": len(searcher.cv_results_["mean_test_score"]),
            }
        else:
            # ── Direct training with explicit hyperparams ───────────
            params = {
                "max_iter": 300,
                "max_depth": 8,
                "learning_rate": 0.05,
                "min_samples_leaf": 10,
                "random_state": 42,
            }
            if hyperparams:
                # Override defaults with provided values
                params.update({k: v for k, v in hyperparams.items() if v is not None})
                params.setdefault("random_state", 42)

            self.model = HistGradientBoostingRegressor(**params)
            self.model.fit(X_train, y_train)
            cv_results_summary = None

        # ── Permutation importance on test set ──────────────────────
        perm_result = permutation_importance(
            self.model, X_test, y_test, n_repeats=5, random_state=42
        )
        self.feature_importances = perm_result.importances_mean
        self.feature_importances = self.feature_importances / max(
            self.feature_importances.sum(), 1e-10
        )

        # ── Save model + metadata ───────────────────────────────────
        with open(self.model_path, "wb") as f:
            pickle.dump(
                {
                    "model": self.model,
                    "importances": self.feature_importances,
                    "feature_names": self.feature_names,
                },
                f,
            )

        # ── Evaluate ────────────────────────────────────────────────
        preds = self.model.predict(X_test)
        mape = mean_absolute_percentage_error(y_test, preds) * 100
        rmse = float(np.sqrt(mean_squared_error(y_test, preds)))
        r2 = float(r2_score(y_test, preds))
        mae = float(np.mean(np.abs(y_test - preds)))

        # sMAPE – symmetric, robust to near-zero actual values
        smape = float(
            np.mean(
                2 * np.abs(y_test - preds) / (np.abs(y_test) + np.abs(preds) + 1e-10)
            )
            * 100
        )

        # Filtered MAPE – exclude rows with actual < 1.0 (near-zero noise)
        mask = np.abs(y_test) >= 1.0
        filtered_mape = (
            float(mean_absolute_percentage_error(y_test[mask], preds[mask]) * 100)
            if mask.sum() > 0
            else mape
        )

        # Per-block MAPE (using the test portion of the data)
        test_df = df.iloc[-len(X_test) :].copy()
        test_df["pred"] = preds
        block_mape = (
            test_df.groupby("block")
            .apply(
                lambda g: np.mean(
                    2
                    * np.abs(g["mcp"] - g["pred"])
                    / (np.abs(g["mcp"]) + np.abs(g["pred"]) + 1e-10)
                )
                * 100
            )
            .to_dict()
        )

        # Top features
        top_idx = np.argsort(self.feature_importances)[-10:][::-1]
        top_features = [
            {
                "feature": feature_names[i],
                "importance": round(float(self.feature_importances[i]), 4),
            }
            for i in top_idx
        ]

        result = {
            "mape": round(mape, 2),
            "smape": round(smape, 2),
            "filtered_mape": round(filtered_mape, 2),
            "rmse": round(rmse, 2),
            "mae": round(mae, 2),
            "r2": round(r2, 4),
            "train_size": len(X_train),
            "test_size": len(X_test),
            "n_features": len(feature_names),
            "feature_names": feature_names,
            "top_features": top_features,
            "block_mape_worst_5": dict(
                sorted(block_mape.items(), key=lambda x: x[1], reverse=True)[:5]
            ),
        }
        if best_params:
            result["best_params"] = {k: _serialise(v) for k, v in best_params.items()}
        if cv_results_summary:
            result["cv_results"] = cv_results_summary
        return result

    def load(self):
        """Load a trained model from disk."""
        if self.model_path.exists():
            with open(self.model_path, "rb") as f:
                data = pickle.load(f)
            if isinstance(data, dict):
                self.model = data["model"]
                self.feature_importances = data["importances"]
                self.feature_names = data.get("feature_names", list(BASE_FEATURE_NAMES))
            else:
                self.model = data
                self.feature_importances = np.ones(len(BASE_FEATURE_NAMES)) / len(
                    BASE_FEATURE_NAMES
                )
                self.feature_names = list(BASE_FEATURE_NAMES)
            return True
        return False

    def predict(self, target_date: str, history_df: pd.DataFrame) -> list[dict]:
        """
        Generate price predictions for all 96 blocks on target_date.
        Returns list of dicts with prediction, confidence interval, and feature importances.
        """
        if self.model is None:
            if not self.load():
                raise RuntimeError("No trained model found. Train first.")

        feature_names = self.feature_names or list(BASE_FEATURE_NAMES)

        # Build features for the target date using recent history
        target_dt = pd.Timestamp(target_date)
        blocks = []

        # We need lag features, so get recent history
        recent = history_df[history_df["segment"] == self.segment].copy()
        # Detect which extra features we need from the stored feature_names
        extra_lags = []
        rolling_windows = []
        include_dsr = "demand_supply_ratio" in feature_names
        include_momentum = "price_momentum" in feature_names
        include_ema = "ema_price" in feature_names

        for fn in feature_names:
            if fn.startswith("lag_price_") and fn not in (
                "lag_price_1d",
                "lag_price_7d",
            ):
                lag_d = int(fn.replace("lag_price_", "").replace("d", ""))
                extra_lags.append(lag_d)
            if fn.startswith("rolling_avg_"):
                w = int(fn.replace("rolling_avg_", "").replace("d", ""))
                if w not in rolling_windows:
                    rolling_windows.append(w)

        recent, _ = self._build_features(
            recent,
            extra_lags=extra_lags or None,
            rolling_windows=rolling_windows or [7],
            include_demand_supply_ratio=include_dsr,
            include_price_momentum=include_momentum,
            include_ema=include_ema,
        )

        # Get the most recent day's data as baseline for lag values
        last_day = recent.groupby("block").last().reset_index()

        for block_num in range(1, NUM_BLOCKS + 1):
            row = last_day[last_day["block"] == block_num]

            hour = (block_num - 1) // 4
            block_in_hour = (block_num - 1) % 4
            day_of_week = target_dt.dayofweek
            month = target_dt.month
            is_weekend = int(day_of_week >= 5)
            block_sin = np.sin(2 * np.pi * block_num / NUM_BLOCKS)
            block_cos = np.cos(2 * np.pi * block_num / NUM_BLOCKS)

            lag_1d = float(row["mcp"].values[0]) if len(row) > 0 else 4.0
            lag_7d = (
                float(row["lag_price_7d"].values[0])
                if len(row) > 0 and not pd.isna(row["lag_price_7d"].values[0])
                else lag_1d
            )
            rolling_avg = (
                float(row["rolling_avg_7d"].values[0]) if len(row) > 0 else lag_1d
            )
            rolling_std = (
                float(row["rolling_std_7d"].values[0]) if len(row) > 0 else 0.5
            )

            demand = float(row["demand_mw"].values[0]) if len(row) > 0 else 45000
            supply = float(row["supply_mw"].values[0]) if len(row) > 0 else 44000
            renewable = (
                float(row["renewable_gen_mw"].values[0]) if len(row) > 0 else 5000
            )
            temp = float(row["temperature"].values[0]) if len(row) > 0 else 30.0

            # Build feature vector dynamically based on stored feature_names
            feat_values = {}
            feat_values["hour"] = hour
            feat_values["block_in_hour"] = block_in_hour
            feat_values["day_of_week"] = day_of_week
            feat_values["month"] = month
            feat_values["is_weekend"] = is_weekend
            feat_values["demand_mw"] = demand
            feat_values["supply_mw"] = supply
            feat_values["renewable_gen_mw"] = renewable
            feat_values["temperature"] = temp
            feat_values["lag_price_1d"] = lag_1d
            feat_values["lag_price_7d"] = lag_7d
            feat_values["rolling_avg_7d"] = rolling_avg
            feat_values["rolling_std_7d"] = rolling_std
            feat_values["block_sin"] = block_sin
            feat_values["block_cos"] = block_cos

            # Populate dynamic features from the last_day row
            for fn in feature_names:
                if fn not in feat_values:
                    if len(row) > 0 and fn in row.columns:
                        val = row[fn].values[0]
                        feat_values[fn] = float(val) if not pd.isna(val) else 0.0
                    else:
                        feat_values[fn] = 0.0

            features = np.array([[feat_values[fn] for fn in feature_names]])

            pred = float(self.model.predict(features)[0])
            pred = max(pred, 0.01)  # price can't be negative

            # Confidence interval from rolling std + model uncertainty
            uncertainty = max(rolling_std * 0.5, pred * 0.08)
            conf_low = max(pred - 1.96 * uncertainty, 0.01)
            conf_high = pred + 1.96 * uncertainty

            # Feature importances (from permutation importance computed during training)
            importances = (
                self.feature_importances
                if self.feature_importances is not None
                else np.ones(len(feature_names)) / len(feature_names)
            )
            top_idx = np.argsort(importances)[-5:][::-1]
            top_features = [
                {
                    "feature": feature_names[i],
                    "importance": round(float(importances[i]), 4),
                }
                for i in top_idx
                if i < len(feature_names)
            ]

            blocks.append(
                {
                    "block": block_num,
                    "predicted_price": round(pred, 4),
                    "confidence_low": round(conf_low, 4),
                    "confidence_high": round(conf_high, 4),
                    "volatility": round(uncertainty, 4),
                    "top_features": top_features,
                }
            )

        return blocks
