"""
LP Solver configuration — internal tuning parameters not derived from CERC regulations.

These values are NOT part of any CERC notification and must not appear in the
regulatory YAML policy files.  They control the objective function weighting of
the PuLP bid optimiser.

  lambda1_base  — base weight for the DSM penalty cost term in the LP objective.
                  Scaled by (1 − risk_tolerance) at solve time.
                  Higher = optimiser avoids deviation more aggressively.

  lambda2_base  — base weight for the forecast uncertainty (CI width) term.
                  Scaled by (1 − risk_tolerance) at solve time.
                  Higher = optimiser prefers blocks with narrower confidence intervals.
"""

# Default base weights used by the LP optimiser.
# These can be overridden via environment variables in production deployments.

LAMBDA1_BASE: float = 2.0   # DSM penalty weight
LAMBDA2_BASE: float = 1.5   # forecast uncertainty weight
