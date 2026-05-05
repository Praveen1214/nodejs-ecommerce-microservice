"""
Attack Scenario Definitions for V4 Evaluation
Each scenario defines realistic feature ranges that deviate from benign traffic.

Benign baseline (from dataset.csv):
  rps_mean          : 0 – 34.6  (mean=1.9, p95=12)
  rps_std           : 0 – 16.3  (mean=0.45)
  unique_source_count: 0 – 1    (always ≤ 1 in benign!)
  ratio_4xx         : 0         (always 0 in benign!)
  ratio_5xx         : 0         (always 0 in benign!)
  latency_mean      : 0 – 641   (mean=3.7, p95=4.1)
  latency_std       : 0 – 297   (mean=1.5)
  inter_arrival_variance: 0 – 88 (mean=0.52)
"""

import numpy as np

SERVICES = ["auth", "order", "product"]

# Each scenario: dict of feature -> (low, high) uniform range
# label=1 for all attack scenarios
SCENARIOS = {
    "ddos": {
        "description": "Distributed Denial of Service — massive traffic from many sources",
        "label": 1,
        "features": {
            "rps_mean":               (80.0,  300.0),
            "rps_std":                (20.0,   80.0),
            "unique_source_count":   (100,    1000),
            "ratio_4xx":              (0.01,   0.08),
            "ratio_5xx":              (0.05,   0.25),
            "latency_mean":           (50.0,  250.0),
            "latency_std":            (30.0,  100.0),
            "inter_arrival_variance": (1.0,    10.0),
        },
    },
    "brute_force": {
        "description": "Brute Force — concentrated auth attempts, high 4xx rate",
        "label": 1,
        "features": {
            "rps_mean":               (5.0,   25.0),
            "rps_std":                (1.0,    6.0),
            "unique_source_count":   (1,        5),
            "ratio_4xx":              (0.60,   0.95),
            "ratio_5xx":              (0.0,    0.05),
            "latency_mean":           (1.0,    8.0),
            "latency_std":            (0.5,    3.0),
            "inter_arrival_variance": (0.001,  0.05),
        },
    },
    "slow_loris": {
        "description": "Slow Loris — low rate, very high latency, server exhaustion",
        "label": 1,
        "features": {
            "rps_mean":               (0.05,   1.5),
            "rps_std":                (0.01,   0.5),
            "unique_source_count":   (1,       15),
            "ratio_4xx":              (0.0,    0.05),
            "ratio_5xx":              (0.15,   0.50),
            "latency_mean":           (200.0, 700.0),
            "latency_std":            (80.0,  300.0),
            "inter_arrival_variance": (15.0,   90.0),
        },
    },
    "http_flood": {
        "description": "HTTP Flood — high uniform request rate from moderate sources",
        "label": 1,
        "features": {
            "rps_mean":               (50.0,  150.0),
            "rps_std":                (5.0,   20.0),
            "unique_source_count":   (10,      80),
            "ratio_4xx":              (0.02,   0.10),
            "ratio_5xx":              (0.03,   0.15),
            "latency_mean":           (30.0,  120.0),
            "latency_std":            (15.0,   60.0),
            "inter_arrival_variance": (0.2,    3.0),
        },
    },
}

FEATURE_ORDER = [
    "rps_mean",
    "rps_std",
    "unique_source_count",
    "ratio_4xx",
    "ratio_5xx",
    "latency_mean",
    "latency_std",
    "inter_arrival_variance",
]

def get_scenario_names():
    return list(SCENARIOS.keys())

def get_scenario(name):
    if name not in SCENARIOS:
        raise ValueError(f"Unknown scenario '{name}'. Choose from: {list(SCENARIOS.keys())}")
    return SCENARIOS[name]
