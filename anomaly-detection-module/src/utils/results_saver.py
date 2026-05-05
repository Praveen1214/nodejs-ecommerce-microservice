"""
Test Results Saver Module
Saves model predictions, probabilities, and true labels for generating ROC/PR curves
"""

import pandas as pd
import numpy as np
import json
import os
from datetime import datetime
from sklearn.metrics import roc_curve, precision_recall_curve, auc
import pickle

class ResultsSaver:
    """Saves test results for visualization and analysis"""

    def __init__(self, version="v1", model_name="model"):
        """
        Initialize results saver

        Args:
            version: Dataset version (v1, v2, v3)
            model_name: Name of the model
        """
        self.version = version
        self.model_name = model_name
        self.base_dir = f"results/test_results/{version}"
        os.makedirs(self.base_dir, exist_ok=True)

    def save_predictions(self, y_true, y_pred, y_scores=None, metadata=None):
        """
        Save predictions and scores for ROC/PR curve generation

        Args:
            y_true: True labels (1 for normal, -1 for anomaly)
            y_pred: Predicted labels (1 for normal, -1 for anomaly)
            y_scores: Decision scores or probabilities (higher = more normal)
            metadata: Additional metadata (accuracy, precision, etc.)
        """
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # Convert to numpy arrays
        y_true = np.array(y_true)
        y_pred = np.array(y_pred)
        if y_scores is not None:
            y_scores = np.array(y_scores)

        # Save raw predictions
        results = {
            'y_true': y_true.tolist(),
            'y_pred': y_pred.tolist(),
            'y_scores': y_scores.tolist() if y_scores is not None else None,
            'timestamp': timestamp,
            'model_name': self.model_name,
            'version': self.version
        }

        predictions_file = os.path.join(self.base_dir, f"{self.model_name}_predictions.pkl")
        with open(predictions_file, 'wb') as f:
            pickle.dump(results, f)

        print(f"✓ Predictions saved to: {predictions_file}")

        # Calculate and save ROC/PR curves if scores available
        if y_scores is not None:
            curves_data = self._calculate_curves(y_true, y_scores)
            curves_file = os.path.join(self.base_dir, f"{self.model_name}_curves.json")

            with open(curves_file, 'w') as f:
                json.dump(curves_data, f, indent=2)

            print(f"✓ ROC/PR curves saved to: {curves_file}")

        # Save metadata
        if metadata:
            metadata['timestamp'] = timestamp
            metadata['model_name'] = self.model_name
            metadata['version'] = self.version

            metadata_file = os.path.join(self.base_dir, f"{self.model_name}_metadata.json")
            with open(metadata_file, 'w') as f:
                json.dump(metadata, f, indent=2)

            print(f"✓ Metadata saved to: {metadata_file}")

    def _calculate_curves(self, y_true, y_scores):
        """Calculate ROC and PR curves"""
        # Convert labels to binary (0=anomaly, 1=normal) for sklearn
        y_true_binary = np.where(y_true == 1, 1, 0)

        # For anomaly detection, we want to predict anomalies (class 0)
        # So invert scores: higher score = more likely to be anomaly
        y_scores_inverted = -y_scores

        # Calculate ROC curve
        fpr, tpr, roc_thresholds = roc_curve(y_true_binary, y_scores)
        roc_auc = auc(fpr, tpr)

        # Calculate PR curve
        precision, recall, pr_thresholds = precision_recall_curve(y_true_binary, y_scores)
        pr_auc = auc(recall, precision)

        # Subsample for efficiency (keep every 10th point)
        step = max(1, len(fpr) // 100)

        curves_data = {
            'roc': {
                'fpr': fpr[::step].tolist(),
                'tpr': tpr[::step].tolist(),
                'thresholds': roc_thresholds[::step].tolist(),
                'auc': float(roc_auc)
            },
            'pr': {
                'precision': precision[::step].tolist(),
                'recall': recall[::step].tolist(),
                'thresholds': pr_thresholds[::step].tolist() if len(pr_thresholds) > 0 else [],
                'auc': float(pr_auc)
            }
        }

        return curves_data

    def save_training_history(self, history_dict):
        """
        Save training history (for neural networks like Autoencoder)

        Args:
            history_dict: Dictionary with 'loss', 'val_loss', etc.
        """
        history_file = os.path.join(self.base_dir, f"{self.model_name}_training_history.json")

        # Convert numpy arrays to lists if present
        history_serializable = {}
        for key, value in history_dict.items():
            if isinstance(value, np.ndarray):
                history_serializable[key] = value.tolist()
            elif isinstance(value, list):
                history_serializable[key] = value
            else:
                history_serializable[key] = [float(value)]

        with open(history_file, 'w') as f:
            json.dump(history_serializable, f, indent=2)

        print(f"✓ Training history saved to: {history_file}")


def load_results(version, model_name):
    """
    Load saved results for a specific model

    Args:
        version: Dataset version (v1, v2, v3)
        model_name: Name of the model

    Returns:
        Dictionary with predictions, curves, metadata
    """
    base_dir = f"results/test_results/{version}"

    results = {}

    # Load predictions
    predictions_file = os.path.join(base_dir, f"{model_name}_predictions.pkl")
    if os.path.exists(predictions_file):
        with open(predictions_file, 'rb') as f:
            results['predictions'] = pickle.load(f)

    # Load curves
    curves_file = os.path.join(base_dir, f"{model_name}_curves.json")
    if os.path.exists(curves_file):
        with open(curves_file, 'r') as f:
            results['curves'] = json.load(f)

    # Load metadata
    metadata_file = os.path.join(base_dir, f"{model_name}_metadata.json")
    if os.path.exists(metadata_file):
        with open(metadata_file, 'r') as f:
            results['metadata'] = json.load(f)

    # Load training history
    history_file = os.path.join(base_dir, f"{model_name}_training_history.json")
    if os.path.exists(history_file):
        with open(history_file, 'r') as f:
            results['training_history'] = json.load(f)

    return results


def export_curves_for_dashboard(version):
    """
    Export all curves for a version in dashboard-compatible format

    Args:
        version: Dataset version (v1, v2, v3)

    Returns:
        Dictionary with all model curves
    """
    base_dir = f"results/test_results/{version}"

    if not os.path.exists(base_dir):
        return {}

    dashboard_data = {}

    # Find all curve files
    for filename in os.listdir(base_dir):
        if filename.endswith('_curves.json'):
            model_name = filename.replace('_curves.json', '')

            with open(os.path.join(base_dir, filename), 'r') as f:
                curves = json.load(f)
                dashboard_data[model_name] = curves

    return dashboard_data


# Example usage
if __name__ == "__main__":
    # Example: Save results for a model
    saver = ResultsSaver(version="v1", model_name="knn")

    # Simulate predictions
    y_true = np.array([1, 1, -1, -1, 1, -1])
    y_pred = np.array([1, 1, -1, 1, 1, -1])
    y_scores = np.array([0.9, 0.8, -0.7, 0.3, 0.6, -0.9])

    metadata = {
        'accuracy': 0.833,
        'precision': 0.75,
        'recall': 0.67,
        'f1_score': 0.71
    }

    saver.save_predictions(y_true, y_pred, y_scores, metadata)

    # Load results
    results = load_results("v1", "knn")
    print("\nLoaded results:", results.keys())
