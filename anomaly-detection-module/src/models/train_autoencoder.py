"""
V4 - Autoencoder (Anomaly Detection)
Trained ONLY on benign HTTP/service metrics from dataset.csv
Architecture: 8 → 6 → 4 → 6 → 8
"""

import os
import sys
import pickle
import time
import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler

os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"
import tensorflow as tf
from tensorflow import keras
from tensorflow.keras import layers

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, "../../"))
sys.path.insert(0, PROJECT_ROOT)

DATASET_PATH = os.path.join(PROJECT_ROOT, "data/raw/dataset.csv")
MODEL_DIR = os.path.join(PROJECT_ROOT, "results/models/v4")
METRICS_DIR = os.path.join(PROJECT_ROOT, "results/v4")
os.makedirs(MODEL_DIR, exist_ok=True)
os.makedirs(METRICS_DIR, exist_ok=True)

FEATURES = [
    "rps_mean", "rps_std", "unique_source_count",
    "ratio_4xx", "ratio_5xx",
    "latency_mean", "latency_std", "inter_arrival_variance",
]

N_FEATURES = len(FEATURES)

def build_autoencoder(n_features):
    inputs = keras.Input(shape=(n_features,))
    # Encoder
    x = layers.Dense(6, activation="relu")(inputs)
    encoded = layers.Dense(4, activation="relu")(x)
    # Decoder
    x = layers.Dense(6, activation="relu")(encoded)
    decoded = layers.Dense(n_features, activation="linear")(x)

    model = keras.Model(inputs, decoded, name="autoencoder")
    model.compile(optimizer="adam", loss="mse")
    return model

def main():
    print("=" * 60)
    print("V4 - Autoencoder Training")
    print("=" * 60)

    # Load benign data
    df = pd.read_csv(DATASET_PATH)
    benign = df[df["label"] == 0][FEATURES].fillna(0)
    X_train = benign.values
    print(f"Training samples (benign only): {len(X_train)}")

    # Scale
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X_train)

    # Build model
    autoencoder = build_autoencoder(N_FEATURES)
    autoencoder.summary()

    # Train
    print("\nTraining Autoencoder...")
    start = time.time()
    history = autoencoder.fit(
        X_scaled, X_scaled,
        epochs=100,
        batch_size=32,
        validation_split=0.1,
        callbacks=[
            keras.callbacks.EarlyStopping(
                monitor="val_loss",
                patience=10,
                restore_best_weights=True,
            )
        ],
        verbose=1,
    )
    train_time = time.time() - start
    epochs_run = len(history.history["loss"])
    print(f"\nTraining time: {train_time:.2f}s ({epochs_run} epochs)")

    # Set anomaly threshold (95th percentile of reconstruction error on benign)
    X_reconstructed = autoencoder.predict(X_scaled, verbose=0)
    reconstruction_errors = np.mean(np.power(X_scaled - X_reconstructed, 2), axis=1)
    threshold = np.percentile(reconstruction_errors, 95)
    print(f"Anomaly threshold (95th pct): {threshold:.6f}")

    # Save
    model_path = os.path.join(MODEL_DIR, "autoencoder_model.h5")
    scaler_path = os.path.join(MODEL_DIR, "autoencoder_scaler.pkl")
    threshold_path = os.path.join(MODEL_DIR, "autoencoder_threshold.pkl")

    autoencoder.save(model_path.replace(".keras", ".h5"))
    with open(scaler_path, "wb") as f:
        pickle.dump(scaler, f)
    with open(threshold_path, "wb") as f:
        pickle.dump(threshold, f)

    print(f"\nModel saved    : {model_path}")
    print(f"Scaler saved   : {scaler_path}")
    print(f"Threshold saved: {threshold_path}")

    # Sanity check
    preds = (reconstruction_errors > threshold).astype(int)
    anomaly_count = preds.sum()
    print(f"\nSanity check on training data:")
    print(f"  Predicted normal   : {len(preds)-anomaly_count} ({(len(preds)-anomaly_count)/len(preds)*100:.1f}%)")
    print(f"  Predicted anomalous: {anomaly_count} ({anomaly_count/len(preds)*100:.1f}%)")

    # Save metadata
    meta = pd.DataFrame([{
        "model": "autoencoder",
        "train_samples": len(X_train),
        "features": N_FEATURES,
        "architecture": f"{N_FEATURES}-6-4-6-{N_FEATURES}",
        "epochs_run": epochs_run,
        "threshold": round(float(threshold), 6),
        "training_time_s": round(train_time, 2),
    }])
    meta.to_csv(os.path.join(METRICS_DIR, "autoencoder_train_meta.csv"), index=False)
    print(f"\nMetadata saved: {METRICS_DIR}/autoencoder_train_meta.csv")
    print("\nAutoencoder training complete.")

if __name__ == "__main__":
    main()
