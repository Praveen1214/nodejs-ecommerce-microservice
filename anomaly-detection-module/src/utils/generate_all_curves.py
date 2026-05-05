"""
Generate ROC/PR Curves for All Models
Runs all models and saves curve data for dashboard visualization
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pandas as pd
import numpy as np
import joblib
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score
from tensorflow import keras
from results_saver import ResultsSaver
import warnings
warnings.filterwarnings('ignore')

def print_header(title):
    print("\n" + "=" * 70)
    print(title)
    print("=" * 70)

def generate_v1_curves():
    """Generate curves for V1 models (CSIC 2010)"""
    print_header("GENERATING V1 (CSIC 2010) CURVES")

    # Load test data
    test_features = pd.read_csv("../../datasets/csic-2010/test_features.csv")
    test_labels = pd.read_csv("../../datasets/csic-2010/test_labels.csv")
    y_test_binary = test_labels.iloc[:, 0].map({'Normal': 1, 'Anomalous': -1})

    models_config = [
        {
            'name': 'isolation_forest',
            'model_path': '../../results/models/isolation_forest_model.pkl',
            'scaler_path': '../../results/models/scaler.pkl',
            'has_scores': True
        },
        {
            'name': 'knn',
            'model_path': '../../results/models/knn_model.pkl',
            'scaler_path': '../../results/models/knn_scaler.pkl',
            'has_scores': True
        },
        {
            'name': 'one_class_svm',
            'model_path': '../../results/models/one_class_svm_model.pkl',
            'scaler_path': '../../results/models/svm_scaler.pkl',
            'has_scores': True
        },
        {
            'name': 'gmm',
            'model_path': '../../results/models/gmm_model.pkl',
            'scaler_path': '../../results/models/gmm_scaler.pkl',
            'threshold_path': '../../results/models/gmm_threshold.pkl',
            'has_scores': True
        },
        {
            'name': 'autoencoder',
            'model_path': '../../results/models/autoencoder_model.h5',
            'scaler_path': '../../results/models/autoencoder_scaler.pkl',
            'threshold_path': '../../results/models/autoencoder_threshold.pkl',
            'is_autoencoder': True,
            'has_scores': True
        }
    ]

    for model_config in models_config:
        try:
            print(f"\n Processing {model_config['name']}...")

            # Load model and scaler
            if model_config.get('is_autoencoder'):
                model = keras.models.load_model(model_config['model_path'])
            else:
                model = joblib.load(model_config['model_path'])

            scaler = joblib.load(model_config['scaler_path'])
            X_test = scaler.transform(test_features)

            # Get predictions and scores
            if model_config.get('is_autoencoder'):
                # Autoencoder: use reconstruction error as score
                threshold = joblib.load(model_config['threshold_path'])
                reconstructions = model.predict(X_test, verbose=0)
                mse = np.mean(np.square(X_test - reconstructions), axis=1)
                y_scores = -mse  # Negative MSE: higher = more normal
                y_pred = np.where(mse > threshold, -1, 1)

            elif model_config['name'] == 'gmm':
                # GMM: use log probability as score
                threshold = joblib.load(model_config['threshold_path'])
                y_scores = model.score_samples(X_test)  # Log probability
                y_pred = np.where(y_scores < threshold, -1, 1)

            elif hasattr(model, 'decision_function'):
                # Models with decision_function (SVM, LOF, Isolation Forest)
                y_scores = model.decision_function(X_test)
                y_pred = model.predict(X_test)

            else:
                # Fallback
                y_pred = model.predict(X_test)
                y_scores = None

            # Calculate metrics
            accuracy = accuracy_score(y_test_binary, y_pred)
            precision = precision_score(y_test_binary, y_pred, pos_label=-1, zero_division=0)
            recall = recall_score(y_test_binary, y_pred, pos_label=-1, zero_division=0)
            f1 = f1_score(y_test_binary, y_pred, pos_label=-1, zero_division=0)

            metadata = {
                'accuracy': float(accuracy),
                'precision': float(precision),
                'recall': float(recall),
                'f1_score': float(f1)
            }

            # Save results
            saver = ResultsSaver(version="v1", model_name=model_config['name'])
            saver.save_predictions(y_test_binary, y_pred, y_scores, metadata)

            print(f"   ✓ {model_config['name']} curves saved")

        except Exception as e:
            print(f"   ✗ Error processing {model_config['name']}: {e}")

def generate_v2_curves():
    """Generate curves for V2 models (CIC-IDS2018)"""
    print_header("GENERATING V2 (CIC-IDS2018) CURVES")
    print("Note: Sampling 50K test samples for memory efficiency")

    try:
        # Load test data (sample for memory)
        test_features = pd.read_csv("../../datasets/cic-ids2018/processed/features/test_features.csv", nrows=50000)
        test_labels = pd.read_csv("../../datasets/cic-ids2018/processed/features/test_labels.csv", nrows=50000)
        y_test_binary = test_labels.iloc[:, 0].map({'Benign': 1, 'Attack': -1})

        models_config = [
            {
                'name': 'isolation_forest',
                'model_path': '../../results/models/v2/isolation_forest_model.pkl',
                'scaler_path': '../../results/models/v2/isolation_forest_scaler.pkl',
            },
            {
                'name': 'knn',
                'model_path': '../../results/models/v2/knn_model.pkl',
                'scaler_path': '../../results/models/v2/knn_scaler.pkl',
            },
            {
                'name': 'gmm',
                'model_path': '../../results/models/v2/gmm_model.pkl',
                'scaler_path': '../../results/models/v2/gmm_scaler.pkl',
                'threshold_path': '../../results/models/v2/gmm_threshold.pkl',
            }
        ]

        for model_config in models_config:
            try:
                print(f"\n  Processing {model_config['name']}...")

                model = joblib.load(model_config['model_path'])
                scaler = joblib.load(model_config['scaler_path'])
                X_test = scaler.transform(test_features)

                # Get predictions and scores
                if model_config['name'] == 'gmm':
                    threshold = joblib.load(model_config['threshold_path'])
                    y_scores = model.score_samples(X_test)
                    y_pred = np.where(y_scores < threshold, -1, 1)
                elif hasattr(model, 'decision_function'):
                    y_scores = model.decision_function(X_test)
                    y_pred = model.predict(X_test)
                else:
                    y_pred = model.predict(X_test)
                    y_scores = None

                # Calculate metrics
                accuracy = accuracy_score(y_test_binary, y_pred)
                precision = precision_score(y_test_binary, y_pred, pos_label=-1, zero_division=0)
                recall = recall_score(y_test_binary, y_pred, pos_label=-1, zero_division=0)
                f1 = f1_score(y_test_binary, y_pred, pos_label=-1, zero_division=0)

                metadata = {
                    'accuracy': float(accuracy),
                    'precision': float(precision),
                    'recall': float(recall),
                    'f1_score': float(f1)
                }

                # Save results
                saver = ResultsSaver(version="v2", model_name=model_config['name'])
                saver.save_predictions(y_test_binary, y_pred, y_scores, metadata)

                print(f"   ✓ {model_config['name']} curves saved")

            except Exception as e:
                print(f"   ✗ Error processing {model_config['name']}: {e}")

    except Exception as e:
        print(f"Error loading V2 data: {e}")

def generate_v3_curves():
    """Generate curves for V3 models (BCCC-cPacket 2024)"""
    print_header("GENERATING V3 (BCCC-cPacket 2024) CURVES")
    print("Note: V3 models available but dataset may not be present")
    print("Skipping for now - implement when dataset is available")

def main():
    print_header("ROC/PR CURVE GENERATOR FOR ALL MODELS")
    print("\nThis script generates ROC and PR curves for all trained models")
    print("Curves are saved in: results/test_results/{version}/")

    # Generate curves for each version
    generate_v1_curves()
    generate_v2_curves()
    # generate_v3_curves()  # Uncomment when V3 dataset is available

    print_header("✅ CURVE GENERATION COMPLETE!")
    print("\nCurves saved to:")
    print("  - results/test_results/v1/")
    print("  - results/test_results/v2/")
    print("\nUse these files in the dashboard for ROC/PR curve visualization.")

if __name__ == "__main__":
    main()
