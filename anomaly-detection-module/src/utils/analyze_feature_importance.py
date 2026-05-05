"""
Feature Importance Analysis for All Dataset Versions
Analyzes which features contribute most to model predictions
"""

import pandas as pd
import numpy as np
import joblib
from sklearn.inspection import permutation_importance
from sklearn.ensemble import IsolationForest
import warnings
warnings.filterwarnings('ignore')

def print_header(title):
    """Print formatted header"""
    print("\n" + "=" * 80)
    print(title)
    print("=" * 80)

def analyze_v1_features():
    """Analyze V1 (CSIC 2010) feature importance"""
    print_header("V1 - CSIC 2010 Feature Importance Analysis")

    # Load data
    print("\nLoading V1 data...")
    train_features = pd.read_csv("../../datasets/csic-2010/train_features.csv")
    test_features = pd.read_csv("../../datasets/csic-2010/test_features.csv")
    test_labels = pd.read_csv("../../datasets/csic-2010/test_labels.csv")

    feature_names = train_features.columns.tolist()
    print(f"Features: {len(feature_names)}")

    # Load trained model and scaler
    print("Loading Isolation Forest model...")
    model = joblib.load("../../results/models/v1/isolation_forest_model.pkl")
    scaler = joblib.load("../../results/models/v1/isolation_forest_scaler.pkl")

    # Scale test data
    X_test = scaler.transform(test_features)
    y_test = test_labels.iloc[:, 0].map({'Normal': 1, 'Anomalous': -1})

    # Method 1: Correlation Analysis
    print("\n[Method 1] Correlation with Anomaly Labels")
    correlations = []
    for i, feature in enumerate(feature_names):
        corr = abs(np.corrcoef(test_features[feature], y_test)[0, 1])
        correlations.append((feature, corr))

    correlations.sort(key=lambda x: x[1], reverse=True)
    print("\nTop 5 Features by Correlation:")
    for i, (feature, corr) in enumerate(correlations[:5], 1):
        print(f"  {i}. {feature:30s} - Correlation: {corr:.4f}")

    # Method 2: Permutation Importance
    print("\n[Method 2] Permutation Importance (this may take a minute...)")
    perm_importance = permutation_importance(
        model, X_test, y_test,
        n_repeats=10,
        random_state=42,
        n_jobs=-1
    )

    perm_results = []
    for i, feature in enumerate(feature_names):
        perm_results.append((feature, perm_importance.importances_mean[i]))

    perm_results.sort(key=lambda x: x[1], reverse=True)
    print("\nTop 5 Features by Permutation Importance:")
    for i, (feature, importance) in enumerate(perm_results[:5], 1):
        print(f"  {i}. {feature:30s} - Importance: {importance:.4f}")

    # Method 3: Variance Analysis
    print("\n[Method 3] Feature Variance (Information Content)")
    variances = []
    for feature in feature_names:
        var = test_features[feature].var()
        variances.append((feature, var))

    variances.sort(key=lambda x: x[1], reverse=True)
    print("\nTop 5 Features by Variance:")
    for i, (feature, var) in enumerate(variances[:5], 1):
        print(f"  {i}. {feature:30s} - Variance: {var:.4f}")

    return {
        'correlation': correlations,
        'permutation': perm_results,
        'variance': variances
    }

def analyze_v2_features():
    """Analyze V2 (CIC-IDS2018) feature importance"""
    print_header("V2 - CIC-IDS2018 Feature Importance Analysis")

    # Load data (sample for faster processing)
    print("\nLoading V2 data (sampling 50k for analysis)...")
    test_features = pd.read_csv(
        "../../datasets/cic-ids2018/processed/features/test_features.csv",
        nrows=50000
    )
    test_labels = pd.read_csv(
        "../../datasets/cic-ids2018/processed/features/test_labels.csv",
        nrows=50000
    )

    feature_names = test_features.columns.tolist()
    print(f"Features: {len(feature_names)}")

    # Load trained model and scaler
    print("Loading Isolation Forest model...")
    model = joblib.load("../../results/models/v2/isolation_forest_model.pkl")
    scaler = joblib.load("../../results/models/v2/isolation_forest_scaler.pkl")

    # Scale test data
    X_test = scaler.transform(test_features)
    y_test = test_labels.iloc[:, 0].map({'Benign': 1, 'Attack': -1})

    # Method 1: Correlation Analysis
    print("\n[Method 1] Correlation with Attack Labels")
    correlations = []
    for i, feature in enumerate(feature_names):
        # Handle NaN values
        valid_mask = ~(test_features[feature].isna() | y_test.isna())
        if valid_mask.sum() > 100:  # Need enough valid samples
            corr = abs(np.corrcoef(test_features[feature][valid_mask], y_test[valid_mask])[0, 1])
            correlations.append((feature, corr))
        else:
            correlations.append((feature, 0.0))

    correlations.sort(key=lambda x: x[1], reverse=True)
    print("\nTop 10 Features by Correlation:")
    for i, (feature, corr) in enumerate(correlations[:10], 1):
        print(f"  {i:2d}. {feature:30s} - Correlation: {corr:.4f}")

    # Method 2: Permutation Importance (on subset for speed)
    print("\n[Method 2] Permutation Importance (on 10k sample...)")
    sample_size = min(10000, len(X_test))
    sample_idx = np.random.choice(len(X_test), sample_size, replace=False)

    perm_importance = permutation_importance(
        model, X_test[sample_idx], y_test.iloc[sample_idx],
        n_repeats=5,
        random_state=42,
        n_jobs=-1
    )

    perm_results = []
    for i, feature in enumerate(feature_names):
        perm_results.append((feature, perm_importance.importances_mean[i]))

    perm_results.sort(key=lambda x: x[1], reverse=True)
    print("\nTop 10 Features by Permutation Importance:")
    for i, (feature, importance) in enumerate(perm_results[:10], 1):
        print(f"  {i:2d}. {feature:30s} - Importance: {importance:.4f}")

    # Method 3: Variance Analysis
    print("\n[Method 3] Feature Variance (Information Content)")
    variances = []
    for feature in feature_names:
        var = test_features[feature].var()
        variances.append((feature, var))

    variances.sort(key=lambda x: x[1], reverse=True)
    print("\nTop 10 Features by Variance:")
    for i, (feature, var) in enumerate(variances[:10], 1):
        print(f"  {i:2d}. {feature:30s} - Variance: {var:.2e}")

    return {
        'correlation': correlations,
        'permutation': perm_results,
        'variance': variances
    }

def analyze_v3_features():
    """Analyze V3 (BCCC-cPacket Cloud DDoS 2024) feature importance"""
    print_header("V3 - BCCC-cPacket Cloud DDoS 2024 Feature Importance Analysis")

    # Load data
    print("\nLoading V3 data...")
    df = pd.read_parquet("../../datasets/BCCC-cPacket-Cloud-DDoS-2024/bccc-cpacket-cloud-ddos-2024-merged.parquet")

    # Prepare features
    label_col = 'label'
    features = df.drop(columns=[label_col])

    # Remove non-numeric columns
    non_numeric_cols = features.select_dtypes(include=['object']).columns.tolist()
    if non_numeric_cols:
        features = features.drop(columns=non_numeric_cols)

    feature_names = features.columns.tolist()
    print(f"Features: {len(feature_names)}")

    # Sample for faster processing
    print("Sampling 50k records for analysis...")
    sample_df = df.sample(n=min(50000, len(df)), random_state=42)
    sample_features = sample_df.drop(columns=[label_col])
    sample_features = sample_features.drop(columns=non_numeric_cols)
    sample_labels = sample_df[label_col].map({'Benign': 1, 'Attack': -1, 'Suspicious': -1})

    # Load trained model and scaler
    print("Loading Isolation Forest model...")
    model = joblib.load("../../results/models/v3/isolation_forest_model.pkl")
    scaler = joblib.load("../../results/models/v3/isolation_forest_scaler.pkl")

    # Scale test data
    X_test = scaler.transform(sample_features)
    y_test = sample_labels

    # Method 1: Correlation Analysis
    print("\n[Method 1] Correlation with Attack Labels")
    correlations = []
    for i, feature in enumerate(feature_names):
        # Handle NaN and inf values
        valid_mask = ~(sample_features[feature].isna() |
                      np.isinf(sample_features[feature]) |
                      y_test.isna())
        if valid_mask.sum() > 100:
            corr = abs(np.corrcoef(sample_features[feature][valid_mask], y_test[valid_mask])[0, 1])
            correlations.append((feature, corr))
        else:
            correlations.append((feature, 0.0))

    correlations.sort(key=lambda x: x[1], reverse=True)
    print("\nTop 15 Features by Correlation:")
    for i, (feature, corr) in enumerate(correlations[:15], 1):
        print(f"  {i:2d}. {feature:45s} - Correlation: {corr:.4f}")

    # Method 2: Permutation Importance (on subset)
    print("\n[Method 2] Permutation Importance (on 5k sample...)")
    sample_size = min(5000, len(X_test))
    sample_idx = np.random.choice(len(X_test), sample_size, replace=False)

    perm_importance = permutation_importance(
        model, X_test[sample_idx], y_test.iloc[sample_idx],
        n_repeats=3,
        random_state=42,
        n_jobs=-1
    )

    perm_results = []
    for i, feature in enumerate(feature_names):
        perm_results.append((feature, perm_importance.importances_mean[i]))

    perm_results.sort(key=lambda x: x[1], reverse=True)
    print("\nTop 15 Features by Permutation Importance:")
    for i, (feature, importance) in enumerate(perm_results[:15], 1):
        print(f"  {i:2d}. {feature:45s} - Importance: {importance:.4f}")

    # Method 3: Variance Analysis
    print("\n[Method 3] Feature Variance (Information Content)")
    variances = []
    for feature in feature_names:
        var = sample_features[feature].var()
        variances.append((feature, var))

    variances.sort(key=lambda x: x[1], reverse=True)
    print("\nTop 15 Features by Variance:")
    for i, (feature, var) in enumerate(variances[:15], 1):
        print(f"  {i:2d}. {feature:45s} - Variance: {var:.2e}")

    return {
        'correlation': correlations,
        'permutation': perm_results,
        'variance': variances
    }

def main():
    print("=" * 80)
    print("FEATURE IMPORTANCE ANALYSIS")
    print("Analyzing feature contributions across all dataset versions")
    print("=" * 80)

    # Analyze V1
    try:
        v1_results = analyze_v1_features()
    except Exception as e:
        print(f"\nError analyzing V1: {e}")
        v1_results = None

    # Analyze V2
    try:
        v2_results = analyze_v2_features()
    except Exception as e:
        print(f"\nError analyzing V2: {e}")
        v2_results = None

    # Analyze V3
    try:
        v3_results = analyze_v3_features()
    except Exception as e:
        print(f"\nError analyzing V3: {e}")
        v3_results = None

    print_header("ANALYSIS COMPLETE")
    print("\nKey Insights:")
    print("- V1 focuses on URL characteristics and HTTP headers")
    print("- V2 emphasizes flow timing and packet statistics")
    print("- V3 uses comprehensive bidirectional flow features")
    print("\nSee detailed results above for each version.")

if __name__ == "__main__":
    main()
