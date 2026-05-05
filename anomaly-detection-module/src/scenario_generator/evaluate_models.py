"""
V4 Model Evaluation
Runs all trained v4 models against benign data + generated attack scenarios.
Outputs accuracy, precision, recall, F1, FPR per model per scenario.

Usage:
    python evaluate_models.py                         # evaluate all scenarios
    python evaluate_models.py --scenario ddos         # single scenario
    python evaluate_models.py --n 200                 # samples per scenario
"""

import os
import sys
import pickle
import argparse
import time
import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score,
    f1_score, confusion_matrix,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, "../.."))
sys.path.insert(0, BASE_DIR)

from scenarios import FEATURE_ORDER, get_scenario_names
from generator import generate_scenario, generate_benign

MODEL_DIR = os.path.join(PROJECT_ROOT, "results/models/v4")
RESULTS_DIR = os.path.join(PROJECT_ROOT, "results/v4")
os.makedirs(RESULTS_DIR, exist_ok=True)

os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"


# ── Model loaders ────────────────────────────────────────────────────────────

def load_isolation_forest():
    with open(os.path.join(MODEL_DIR, "isolation_forest_model.pkl"), "rb") as f:
        model = pickle.load(f)
    with open(os.path.join(MODEL_DIR, "isolation_forest_scaler.pkl"), "rb") as f:
        scaler = pickle.load(f)
    def predict(X):
        X_s = scaler.transform(X)
        # IF: 1=normal, -1=anomaly → remap to 0/1
        raw = model.predict(X_s)
        return (raw == -1).astype(int)
    return "Isolation Forest", predict


def load_gmm():
    with open(os.path.join(MODEL_DIR, "gmm_model.pkl"), "rb") as f:
        model = pickle.load(f)
    with open(os.path.join(MODEL_DIR, "gmm_scaler.pkl"), "rb") as f:
        scaler = pickle.load(f)
    with open(os.path.join(MODEL_DIR, "gmm_threshold.pkl"), "rb") as f:
        threshold = pickle.load(f)
    def predict(X):
        X_s = scaler.transform(X)
        log_probs = model.score_samples(X_s)
        return (log_probs < threshold).astype(int)
    return "GMM", predict


def load_knn():
    with open(os.path.join(MODEL_DIR, "knn_model.pkl"), "rb") as f:
        model = pickle.load(f)
    with open(os.path.join(MODEL_DIR, "knn_scaler.pkl"), "rb") as f:
        scaler = pickle.load(f)
    def predict(X):
        X_s = scaler.transform(X)
        raw = model.predict(X_s)
        return (raw == -1).astype(int)
    return "KNN (LOF)", predict


def load_one_class_svm():
    with open(os.path.join(MODEL_DIR, "one_class_svm_model.pkl"), "rb") as f:
        model = pickle.load(f)
    with open(os.path.join(MODEL_DIR, "one_class_svm_scaler.pkl"), "rb") as f:
        scaler = pickle.load(f)
    def predict(X):
        X_s = scaler.transform(X)
        raw = model.predict(X_s)
        return (raw == -1).astype(int)
    return "One-Class SVM", predict


def load_autoencoder():
    import tensorflow as tf
    model_path = os.path.join(MODEL_DIR, "autoencoder_model.keras")
    if not os.path.exists(model_path):
        model_path = os.path.join(MODEL_DIR, "autoencoder_model.h5")
    model = tf.keras.models.load_model(model_path, compile=False)
    with open(os.path.join(MODEL_DIR, "autoencoder_scaler.pkl"), "rb") as f:
        scaler = pickle.load(f)
    with open(os.path.join(MODEL_DIR, "autoencoder_threshold.pkl"), "rb") as f:
        threshold = pickle.load(f)
    def predict(X):
        X_s = scaler.transform(X)
        X_rec = model.predict(X_s, verbose=0)
        errors = np.mean(np.power(X_s - X_rec, 2), axis=1)
        return (errors > threshold).astype(int)
    return "Autoencoder", predict


def load_all_models():
    loaders = [
        load_isolation_forest,
        load_gmm,
        load_knn,
        load_one_class_svm,
        load_autoencoder,
    ]
    models = []
    for loader in loaders:
        try:
            name, predict_fn = loader()
            models.append((name, predict_fn))
            print(f"  ✓ Loaded: {name}")
        except FileNotFoundError as e:
            print(f"  ✗ Skipped (not trained yet): {e.filename}")
    return models


# ── Evaluation ───────────────────────────────────────────────────────────────

def evaluate_on_scenario(model_name, predict_fn, X_benign, X_attack, scenario_name):
    X = np.vstack([X_benign, X_attack])
    y_true = np.array([0] * len(X_benign) + [1] * len(X_attack))

    start = time.time()
    y_pred = predict_fn(X)
    elapsed = time.time() - start

    acc  = accuracy_score(y_true, y_pred)
    prec = precision_score(y_true, y_pred, zero_division=0)
    rec  = recall_score(y_true, y_pred, zero_division=0)
    f1   = f1_score(y_true, y_pred, zero_division=0)

    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    fpr = fp / (fp + tn) if (fp + tn) > 0 else 0.0
    throughput = len(X) / elapsed if elapsed > 0 else 0

    return {
        "model":        model_name,
        "scenario":     scenario_name,
        "accuracy":     round(acc,  4),
        "precision":    round(prec, 4),
        "recall":       round(rec,  4),
        "f1_score":     round(f1,   4),
        "fpr":          round(fpr,  4),
        "tp": int(tp), "fp": int(fp),
        "tn": int(tn), "fn": int(fn),
        "n_benign":     len(X_benign),
        "n_attack":     len(X_attack),
        "pred_time_s":  round(elapsed, 3),
        "throughput":   round(throughput, 1),
    }


def print_results_table(df_results):
    print("\n" + "=" * 90)
    print(f"{'Model':<20} {'Scenario':<15} {'Acc':>7} {'Prec':>7} {'Rec':>7} {'F1':>7} {'FPR':>7}")
    print("-" * 90)
    for _, row in df_results.iterrows():
        print(
            f"{row['model']:<20} {row['scenario']:<15} "
            f"{row['accuracy']:>7.1%} {row['precision']:>7.1%} "
            f"{row['recall']:>7.1%} {row['f1_score']:>7.4f} {row['fpr']:>7.1%}"
        )
    print("=" * 90)


def main():
    parser = argparse.ArgumentParser(description="V4 Model Evaluation")
    parser.add_argument("--scenario", type=str, default=None,
                        help="Single scenario to evaluate (default: all)")
    parser.add_argument("--n", type=int, default=200,
                        help="Attack samples per scenario (default: 200)")
    parser.add_argument("--n_benign", type=int, default=None,
                        help="Benign samples (default: same as --n)")
    args = parser.parse_args()

    n_attack = args.n
    n_benign = args.n_benign or n_attack

    print("=" * 60)
    print("V4 Model Evaluation")
    print("=" * 60)

    # Load models
    print("\nLoading models...")
    models = load_all_models()
    if not models:
        print("No models found. Run training scripts first.")
        sys.exit(1)

    # Scenarios to evaluate
    scenarios_to_run = [args.scenario] if args.scenario else get_scenario_names()

    # Generate benign test samples
    print(f"\nGenerating {n_benign} benign test samples...")
    df_benign = generate_benign(n_samples=n_benign, seed=99)
    X_benign = df_benign[FEATURE_ORDER].fillna(0).values

    all_results = []

    for scenario_name in scenarios_to_run:
        print(f"\n--- Scenario: {scenario_name.upper()} ---")
        df_attack = generate_scenario(scenario_name, n_samples=n_attack, seed=42)
        X_attack = df_attack[FEATURE_ORDER].values

        for model_name, predict_fn in models:
            result = evaluate_on_scenario(
                model_name, predict_fn, X_benign, X_attack, scenario_name
            )
            all_results.append(result)
            print(
                f"  {model_name:<20} acc={result['accuracy']:.1%}  "
                f"prec={result['precision']:.1%}  rec={result['recall']:.1%}  "
                f"f1={result['f1_score']:.4f}  fpr={result['fpr']:.1%}"
            )

    df_results = pd.DataFrame(all_results)

    # Print summary table
    print_results_table(df_results)

    # Save detailed results
    results_path = os.path.join(RESULTS_DIR, "v4_evaluation_results.csv")
    df_results.to_csv(results_path, index=False)
    print(f"\nDetailed results saved: {results_path}")

    # Save per-scenario summaries
    for scenario_name in scenarios_to_run:
        sub = df_results[df_results["scenario"] == scenario_name]
        path = os.path.join(RESULTS_DIR, f"v4_{scenario_name}_results.csv")
        sub.to_csv(path, index=False)

    # Print best model per scenario
    print("\n=== Best Model Per Scenario (by F1) ===")
    for scenario_name in scenarios_to_run:
        sub = df_results[df_results["scenario"] == scenario_name]
        best = sub.loc[sub["f1_score"].idxmax()]
        print(f"  {scenario_name:<15}: {best['model']:<20} (F1={best['f1_score']:.4f}, Acc={best['accuracy']:.1%})")

    # Overall best model (avg F1 across all scenarios)
    print("\n=== Overall Best Model (avg F1 across all scenarios) ===")
    avg_f1 = df_results.groupby("model")["f1_score"].mean().sort_values(ascending=False)
    for model, score in avg_f1.items():
        print(f"  {model:<20}: avg F1 = {score:.4f}")

    print(f"\nEvaluation complete.")

if __name__ == "__main__":
    main()
