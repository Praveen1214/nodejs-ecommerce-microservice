import csv
import os
import time
from datetime import datetime

import requests

API_URL = "http://localhost:8000/sliding-window/features"
OUTPUT_CSV = "dataset.csv"
POLL_INTERVAL_SECONDS = 2

FIELDNAMES = [
    "timestamp",
    "service",
    "rps_mean",
    "rps_std",
    "unique_source_count",
    "ratio_4xx",
    "ratio_5xx",
    "latency_mean",
    "latency_std",
    "inter_arrival_variance",
    "label",
]

def ensure_csv_exists():
    if not os.path.exists(OUTPUT_CSV):
        with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
            writer.writeheader()

def fetch_features():
    response = requests.get(API_URL, timeout=30)
    response.raise_for_status()
    return response.json()

def append_rows(features):
    timestamp = datetime.utcnow().isoformat()
    with open(OUTPUT_CSV, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)

        for item in features:
            row = {
                "timestamp": timestamp,
                "service": item["service"],
                "rps_mean": item["rps_mean"],
                "rps_std": item["rps_std"],
                "unique_source_count": item["unique_source_count"],
                "ratio_4xx": item["ratio_4xx"],
                "ratio_5xx": item["ratio_5xx"],
                "latency_mean": item["latency_mean_ms"],
                "latency_std": item["latency_std_ms"],
                "inter_arrival_variance": item["inter_arrival_variance"],
                "label": 0,
            }
            writer.writerow(row)

def main():
    ensure_csv_exists()
    print("Starting dataset collection... Press Ctrl+C to stop.")

    while True:
        try:
            payload = fetch_features()
            features = payload.get("features", [])
            append_rows(features)
            print(f"{datetime.utcnow().isoformat()} - Saved {len(features)} rows")
        except Exception as e:
            print(f"Error: {e}")

        time.sleep(POLL_INTERVAL_SECONDS)

if __name__ == "__main__":
    main()