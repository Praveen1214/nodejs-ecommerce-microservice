"""
V4 Data Processing - Kubernetes HTTP/Service Metrics Dataset
Loads dataset.csv (benign only), normalizes features, saves scaler.
"""

import os
import pickle
import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, "../../../"))
DATASET_PATH = os.path.join(PROJECT_ROOT, "datasets/dataset.csv")
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "results/models/v4")
os.makedirs(OUTPUT_DIR, exist_ok=True)

FEATURES = [
    "rps_mean",
    "rps_std",
    "unique_source_count",
    "ratio_4xx",
    "ratio_5xx",
    "latency_mean",
    "latency_std",
    "inter_arrival_variance",
]

def load_and_prepare():
    print("=" * 60)
    print("V4 Data Preparation - HTTP/Service Metrics")
    print("=" * 60)

    df = pd.read_csv(DATASET_PATH)
    print(f"Loaded: {len(df)} rows, {len(df.columns)} columns")
    print(f"Label distribution: {df['label'].value_counts().to_dict()}")
    print(f"Services: {df['service'].unique().tolist()}")

    # Extract numeric features (benign only - label == 0)
    benign = df[df["label"] == 0][FEATURES].copy()
    print(f"\nBenign samples: {len(benign)}")

    # Handle any NaNs
    benign = benign.fillna(0)

    X = benign.values
    print(f"Feature matrix shape: {X.shape}")

    # Fit scaler
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    # Save scaler
    scaler_path = os.path.join(OUTPUT_DIR, "scaler.pkl")
    with open(scaler_path, "wb") as f:
        pickle.dump(scaler, f)
    print(f"\nScaler saved: {scaler_path}")

    # Print feature stats
    print("\n=== Feature Statistics (Benign) ===")
    stats = benign.describe()
    print(stats.to_string())

    # Save processed data for reference
    benign.to_csv(os.path.join(OUTPUT_DIR, "benign_features.csv"), index=False)
    print(f"\nBenign features saved: {OUTPUT_DIR}/benign_features.csv")

    return X_scaled, scaler, benign

if __name__ == "__main__":
    X_scaled, scaler, benign = load_and_prepare()
    print("\nData preparation complete.")
    print(f"  Samples : {X_scaled.shape[0]}")
    print(f"  Features: {X_scaled.shape[1]}")
