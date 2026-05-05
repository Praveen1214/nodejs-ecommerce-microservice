"""
V4 Scenario Generator
Generates synthetic attack traffic data based on scenario profiles.
Mirrors the GasGuard simulator pattern: pick a scenario, get realistic samples.

Usage:
    python generator.py                          # generate all scenarios, 200 samples each
    python generator.py --scenario ddos          # single scenario
    python generator.py --scenario ddos --n 500  # custom sample count
    python generator.py --list                   # list available scenarios
"""

import os
import sys
import argparse
import numpy as np
import pandas as pd
from datetime import datetime, timedelta

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, "../.."))
sys.path.insert(0, BASE_DIR)

from scenarios import SCENARIOS, FEATURE_ORDER, SERVICES, get_scenario_names

OUTPUT_DIR = os.path.join(PROJECT_ROOT, "datasets/generated")
os.makedirs(OUTPUT_DIR, exist_ok=True)


def generate_scenario(scenario_name: str, n_samples: int = 200, seed: int = 42) -> pd.DataFrame:
    """
    Generate n_samples rows of synthetic traffic for a given attack scenario.
    Samples are spread across all 5 services.
    """
    rng = np.random.default_rng(seed)
    scenario = SCENARIOS[scenario_name]
    feature_ranges = scenario["features"]
    label = scenario["label"]

    samples_per_service = n_samples // len(SERVICES)
    rows = []
    base_time = datetime(2026, 3, 9, 0, 0, 0)

    for svc_idx, service in enumerate(SERVICES):
        for i in range(samples_per_service):
            row = {
                "timestamp": (base_time + timedelta(seconds=i * 30)).isoformat(),
                "service": service,
                "scenario": scenario_name,
                "label": label,
            }
            for feat in FEATURE_ORDER:
                lo, hi = feature_ranges[feat]
                # Add a small amount of Gaussian noise for realism
                val = rng.uniform(lo, hi)
                row[feat] = round(float(val), 6)
            rows.append(row)

    df = pd.DataFrame(rows)
    # Reorder columns
    cols = ["timestamp", "service", "scenario"] + FEATURE_ORDER + ["label"]
    return df[cols]


def generate_benign(n_samples: int = 200, seed: int = 99) -> pd.DataFrame:
    """
    Re-sample benign data from the original dataset.csv for use in evaluation.
    """
    dataset_path = os.path.join(PROJECT_ROOT, "datasets/dataset.csv")
    df = pd.read_csv(dataset_path)
    benign = df[df["label"] == 0].copy()

    rng = np.random.default_rng(seed)
    idx = rng.choice(len(benign), size=min(n_samples, len(benign)), replace=False)
    sampled = benign.iloc[idx].reset_index(drop=True)

    sampled["scenario"] = "benign"
    cols = ["timestamp", "service", "scenario"] + FEATURE_ORDER + ["label"]
    # Some columns might not exist in original; fill missing
    for c in cols:
        if c not in sampled.columns:
            sampled[c] = None
    return sampled[cols]


def generate_all(n_per_scenario: int = 200, seed: int = 42) -> pd.DataFrame:
    """
    Generate samples for all attack scenarios combined.
    """
    frames = []
    for name in get_scenario_names():
        df = generate_scenario(name, n_samples=n_per_scenario, seed=seed)
        frames.append(df)
        print(f"  [{name}] generated {len(df)} samples")
    return pd.concat(frames, ignore_index=True)


def main():
    parser = argparse.ArgumentParser(description="V4 Attack Scenario Generator")
    parser.add_argument("--scenario", type=str, default=None,
                        help="Scenario name (ddos, brute_force, slow_loris, http_flood). Default: all")
    parser.add_argument("--n", type=int, default=200,
                        help="Number of samples per scenario (default: 200)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--list", action="store_true", help="List available scenarios and exit")
    parser.add_argument("--output", type=str, default=None, help="Output CSV path")
    args = parser.parse_args()

    if args.list:
        print("\nAvailable attack scenarios:")
        for name, info in SCENARIOS.items():
            print(f"  {name:15s} — {info['description']}")
        return

    print("=" * 60)
    print("V4 Scenario Generator")
    print("=" * 60)

    if args.scenario:
        if args.scenario not in SCENARIOS:
            print(f"ERROR: Unknown scenario '{args.scenario}'")
            print(f"Available: {get_scenario_names()}")
            sys.exit(1)
        print(f"Generating scenario: {args.scenario} ({args.n} samples)")
        df = generate_scenario(args.scenario, n_samples=args.n, seed=args.seed)
    else:
        print(f"Generating all scenarios ({args.n} samples each)...")
        df = generate_all(n_per_scenario=args.n, seed=args.seed)

    # Save
    if args.output:
        out_path = args.output
    else:
        scenario_tag = args.scenario or "all"
        out_path = os.path.join(OUTPUT_DIR, f"attack_{scenario_tag}.csv")

    df.to_csv(out_path, index=False)
    print(f"\nSaved {len(df)} samples → {out_path}")
    print(f"Label distribution: {df['label'].value_counts().to_dict()}")
    if "scenario" in df.columns:
        print(f"Scenario breakdown:\n{df['scenario'].value_counts().to_string()}")


if __name__ == "__main__":
    main()
