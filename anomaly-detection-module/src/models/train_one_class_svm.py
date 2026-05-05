"""
V4 - One-Class SVM (Anomaly Detection)
Trained ONLY on benign HTTP/service metrics from dataset.csv
"""

import os
import sys
import pickle
import time
import numpy as np
import pandas as pd
from sklearn.svm import OneClassSVM
from sklearn.preprocessing import StandardScaler

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, "../../../"))
sys.path.insert(0, PROJECT_ROOT)

DATASET_PATH = os.path.join(PROJECT_ROOT, "datasets/dataset.csv")
MODEL_DIR = os.path.join(PROJECT_ROOT, "results/models/v4")
METRICS_DIR = os.path.join(PROJECT_ROOT, "results/v4")
os.makedirs(MODEL_DIR, exist_ok=True)
os.makedirs(METRICS_DIR, exist_ok=True)

FEATURES = [
    "rps_mean", "rps_std", "unique_source_count",
    "ratio_4xx", "ratio_5xx",
    "latency_mean", "latency_std", "inter_arrival_variance",
]

def main():
    print("=" * 60)
    print("V4 - One-Class SVM Training")
    print("=" * 60)

    # Load benign data
    df = pd.read_csv(DATASET_PATH)
    benign = df[df["label"] == 0][FEATURES].fillna(0)
    X_train = benign.values
    print(f"Training samples (benign only): {len(X_train)}")

    # Scale
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X_train)

    # Train
    print("\nTraining One-Class SVM...")
    start = time.time()
    model = OneClassSVM(
        kernel="rbf",
        nu=0.05,
        gamma="scale",
    )
    model.fit(X_scaled)
    train_time = time.time() - start
    print(f"Training time: {train_time:.2f}s")

    # Save
    model_path = os.path.join(MODEL_DIR, "one_class_svm_model.pkl")
    scaler_path = os.path.join(MODEL_DIR, "one_class_svm_scaler.pkl")
    with open(model_path, "wb") as f:
        pickle.dump(model, f)
    with open(scaler_path, "wb") as f:
        pickle.dump(scaler, f)

    print(f"\nModel saved : {model_path}")
    print(f"Scaler saved: {scaler_path}")

    # Sanity check
    preds = model.predict(X_scaled)
    normal_count = (preds == 1).sum()
    anomaly_count = (preds == -1).sum()
    print(f"\nSanity check on training data:")
    print(f"  Predicted normal   : {normal_count} ({normal_count/len(preds)*100:.1f}%)")
    print(f"  Predicted anomalous: {anomaly_count} ({anomaly_count/len(preds)*100:.1f}%)")

    # Save metadata
    meta = pd.DataFrame([{
        "model": "one_class_svm",
        "train_samples": len(X_train),
        "features": len(FEATURES),
        "kernel": "rbf",
        "nu": 0.05,
        "gamma": "scale",
        "training_time_s": round(train_time, 2),
    }])
    meta.to_csv(os.path.join(METRICS_DIR, "one_class_svm_train_meta.csv"), index=False)
    print(f"\nMetadata saved: {METRICS_DIR}/one_class_svm_train_meta.csv")
    print("\nOne-Class SVM training complete.")

if __name__ == "__main__":
    main()
