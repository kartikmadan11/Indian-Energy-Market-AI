"""
DSM Policy Engine — policy-as-code for CERC DSM regulations.

Policies are stored as YAML files under backend/data/policies/.
The active policy is tracked via active_policy.txt in the same directory.
Switching policies requires no code change — it's purely a data operation.

Usage:
    from common.dsm_policy import get_active_policy, list_policies

    policy = get_active_policy()
    print(policy.deviation_band)   # e.g. 0.07 under CERC 2024 draft
"""

from __future__ import annotations

import logging
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Directory containing all policy YAML files and the active-policy pointer.
POLICIES_DIR = Path(__file__).resolve().parent.parent / "data" / "policies"
_ACTIVE_POLICY_FILE = POLICIES_DIR / "active_policy.txt"


class DSMPolicy(BaseModel):
    """Declarative model of a CERC DSM regulation version."""

    regulation_id: str
    name: str
    description: str = ""
    effective_date: str = ""
    status: str = "active"

    # Price limits (INR/kWh)
    price_floor: float = Field(ge=0.0)
    price_ceiling: float = Field(gt=0.0)

    # Deviation band (fraction, e.g. 0.10 = 10%)
    deviation_band: float = Field(gt=0.0, lt=1.0)

    # Penalty structure
    penalty_rate: float = Field(gt=0.0)
    severe_deviation_threshold: float = Field(gt=0.0, lt=1.0)
    severe_penalty_multiplier: float = Field(ge=1.0)

    # Market minimums
    technical_minimum_mw: float = Field(gt=0.0)

    def penalty_cost(
        self,
        volume_mw: float,
        scheduled_mw: float,
        price: float,
        duration_hours: float,
    ) -> float:
        """
        Compute the DSM penalty cost (INR) for a single block.

        Uses tiered structure:
          - Deviation within band      → 0 penalty
          - Deviation beyond band      → penalty_rate × excess_mw × price × hours × 1000
          - Deviation beyond severe    → additional severe_penalty_multiplier × same formula
        """
        if scheduled_mw <= 0:
            return 0.0

        deviation_fraction = abs(volume_mw - scheduled_mw) / scheduled_mw
        excess_fraction = max(0.0, deviation_fraction - self.deviation_band)
        severe_fraction = max(
            0.0, deviation_fraction - self.severe_deviation_threshold
        )

        base_penalty = (
            excess_fraction
            * scheduled_mw
            * price
            * self.penalty_rate
            * duration_hours
            * 1000
        )
        severe_surcharge = (
            severe_fraction
            * scheduled_mw
            * price
            * self.penalty_rate
            * (self.severe_penalty_multiplier - 1.0)
            * duration_hours
            * 1000
        )
        return round(base_penalty + severe_surcharge, 2)


def load_policy(regulation_id: str) -> DSMPolicy:
    """Load and validate a policy by its regulation_id."""
    path = POLICIES_DIR / f"{regulation_id}.yaml"
    if not path.exists():
        raise FileNotFoundError(
            f"Policy file not found: {path}. "
            f"Available: {[p.stem for p in POLICIES_DIR.glob('*.yaml')]}"
        )
    raw = yaml.safe_load(path.read_text())
    return DSMPolicy(**raw)


def list_policies() -> list[DSMPolicy]:
    """Return all available policies, sorted by effective_date descending."""
    policies = []
    for yaml_path in sorted(POLICIES_DIR.glob("*.yaml")):
        try:
            raw = yaml.safe_load(yaml_path.read_text())
            policies.append(DSMPolicy(**raw))
        except Exception as exc:
            logger.warning("Skipping malformed policy file %s: %s", yaml_path.name, exc)
    return sorted(policies, key=lambda p: p.effective_date, reverse=True)


def get_active_policy() -> DSMPolicy:
    """
    Return the currently active DSM policy.

    Reads the regulation_id from active_policy.txt; falls back to cerc_dsm_2019
    if the file is missing or corrupted.
    """
    try:
        regulation_id = _ACTIVE_POLICY_FILE.read_text().strip()
        return load_policy(regulation_id)
    except Exception as exc:
        logger.warning(
            "Could not read active policy (%s); falling back to cerc_dsm_2019", exc
        )
        return load_policy("cerc_dsm_2019")


def set_active_policy(regulation_id: str) -> DSMPolicy:
    """
    Persists a new active policy and returns it.

    Validates the policy exists before writing, so the pointer is never
    left pointing at a non-existent file.
    """
    policy = load_policy(regulation_id)  # raises if not found
    _ACTIVE_POLICY_FILE.write_text(regulation_id)
    logger.info("Active DSM policy switched to: %s", regulation_id)
    return policy


def update_policy(regulation_id: str, updates: dict) -> DSMPolicy:
    """
    Persist edits to an existing policy YAML and return the updated policy.

    Only the fields present in *updates* are changed; all other fields are
    preserved.  The regulation_id itself may not be changed via this function
    (it is the file identifier).

    Raises FileNotFoundError if the policy does not exist.
    Raises ValueError for invalid field values (validated via DSMPolicy).
    """
    path = POLICIES_DIR / f"{regulation_id}.yaml"
    if not path.exists():
        raise FileNotFoundError(f"Policy '{regulation_id}' not found.")

    existing = yaml.safe_load(path.read_text())

    # Apply updates — reject attempts to change the primary key
    updates.pop("regulation_id", None)
    existing.update(updates)

    # Validate the merged result before writing
    merged = DSMPolicy(**existing)

    path.write_text(yaml.dump(existing, default_flow_style=False, allow_unicode=True))
    logger.info("Policy '%s' updated: %s", regulation_id, list(updates.keys()))
    return merged
