import express from "express";
import PredictionService from "../services/prediction.service.js";

const router = express.Router();

const REQUIRED_ROWS = 48;
const REQUIRED_COLS = 21;

function validateWindow(window) {
  if (!Array.isArray(window)) {
    return "window must be an array";
  }
  if (window.length !== REQUIRED_ROWS) {
    return `window must have exactly ${REQUIRED_ROWS} rows`;
  }

  for (let r = 0; r < window.length; r++) {
    const row = window[r];
    if (!Array.isArray(row)) {
      return `window row ${r} must be an array`;
    }
    if (row.length !== REQUIRED_COLS) {
      return `window row ${r} must have exactly ${REQUIRED_COLS} values`;
    }

    for (let c = 0; c < row.length; c++) {
      const value = Number(row[c]);
      if (!Number.isFinite(value)) {
        return `window row ${r}, col ${c} must be a finite number`;
      }
    }
  }

  return null;
}

async function handleMetricsWindow(req, res) {
  try {
    const {
      serviceId,
      timestamp,
      window,
      dryRun = false,
      validate = true,
      source = "synthetic_window",
    } = req.body || {};

    if (!serviceId || typeof serviceId !== "string") {
      return res.status(400).json({ error: "serviceId is required and must be a string" });
    }

    const validationError = validateWindow(window);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const result = await PredictionService.processMetricsWindow({
      serviceId,
      timestamp,
      window,
      dryRun: Boolean(dryRun),
      validate: Boolean(validate),
      source,
    });

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      error: err.message,
      context: "Failed to process metrics window",
    });
  }
}

/**
 * POST /api/v1/metrics/window
 * POST /api/v1/window (compatibility alias)
 *
 * Ingests a 48x21 metrics window and runs the full ML -> validation -> scaling pipeline.
 */
router.post("/metrics/window", handleMetricsWindow);
router.post("/window", handleMetricsWindow);

export default router;
