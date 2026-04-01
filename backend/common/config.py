import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "platform.db"
DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH}"

# DSM Regulation Constants (CERC Draft 2024)
DSM_PRICE_FLOOR = 0.0  # INR/kWh
DSM_PRICE_CEILING = 12.0  # INR/kWh
DSM_DEVIATION_BAND = 0.10  # 10% permissible deviation
DSM_PENALTY_RATE = 1.5  # penalty multiplier beyond band

# Market segments
SEGMENTS = ["DAM", "RTM", "TAM"]

# 96 time blocks (15-min each, 00:00–23:45)
NUM_BLOCKS = 96
BLOCK_DURATION_MIN = 15

# Strategy multipliers (affect bid aggressiveness)
STRATEGY_PROFILES = {
    "conservative": {"price_offset": -0.8, "volume_scale": 0.85, "risk_tolerance": 0.3},
    "balanced": {"price_offset": 0.0, "volume_scale": 1.00, "risk_tolerance": 0.6},
    "aggressive": {"price_offset": 0.6, "volume_scale": 1.15, "risk_tolerance": 0.9},
}

# Risk thresholds
DEFAULT_VAR_THRESHOLD = 500000  # INR 5 lakhs
