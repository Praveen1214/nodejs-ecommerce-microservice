/**
 * Prediction Controller (API Routes)
 * ====================================
 * Exposes REST endpoints to interact with the ML prediction service.
 *
 * Endpoints:
 *   GET  /prediction/status     — Check if prediction loop is running + config
 *   POST /prediction/start      — Start the background prediction loop
 *   POST /prediction/stop       — Stop the background prediction loop
 *   POST /prediction/predict    — Run a single on-demand prediction
 *   GET  /prediction/stats      — Get latest prediction stats
 */

import express from "express";
import PredictionService from "../services/prediction.service.js";
import eventEmitter from "../utils/events.js";

const router = express.Router();

/**
 * Helper to setup SSE
 */
function setupSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

// ─────────────────────────────────────────
// GET /api/v1/prediction/status
// ─────────────────────────────────────────
router.get("/prediction/status", (req, res) => {
  res.json({
    running: PredictionService.isRunning(),
    config:  PredictionService.getConfig(),
    stats:   PredictionService.getStats(),
  });
});

// ─────────────────────────────────────────
// POST /api/v1/prediction/start
// Start the background prediction loop
// Body (all optional):
//   { intervalSec, maxSteps, dryRun, startOffset, validate, serviceId }
// ─────────────────────────────────────────
router.post("/prediction/start", async (req, res) => {
  if (PredictionService.isRunning()) {
    return res.status(409).json({ error: "Prediction controller is already running" });
  }

  const {
    intervalSec  = parseInt(process.env.PREDICTION_INTERVAL) || 60,
    maxSteps     = process.env.PREDICTION_MAX_STEPS ? parseInt(process.env.PREDICTION_MAX_STEPS) : null,
    dryRun       = process.env.PREDICTION_DRY_RUN === "true",
    startOffset  = parseInt(process.env.PREDICTION_START_OFFSET) || 0,
    validate     = process.env.PREDICTION_VALIDATE === "true",
    serviceId    = process.env.PREDICTION_SERVICE_ID || "Order",
  } = req.body || {};

  // Start the loop in background (don't await — it runs continuously)
  PredictionService.startLoop({ intervalSec, maxSteps, dryRun, startOffset, validate, serviceId })
    .then((stats) => {
      console.log("📊 Prediction loop finished:", stats?.predictions, "predictions completed");
    })
    .catch((err) => {
      console.error("❌ Prediction loop error:", err.message);
    });

  res.json({
    message: "Prediction controller started",
    config: { intervalSec, maxSteps, dryRun, startOffset, validate, serviceId },
  });
});

// ─────────────────────────────────────────
// POST /api/v1/prediction/stop
// Stop the background prediction loop
// ─────────────────────────────────────────
router.post("/prediction/stop", (req, res) => {
  const result = PredictionService.stopLoop();
  res.json(result);
});

// ─────────────────────────────────────────
// POST /api/v1/prediction/predict
// Run a single on-demand prediction
// Body (all optional):
//   { serviceId, dryRun, validate }
// ─────────────────────────────────────────
router.post("/prediction/predict", async (req, res) => {
  try {
    const {
      serviceId = process.env.PREDICTION_SERVICE_ID || "Order",
      dryRun    = process.env.PREDICTION_DRY_RUN === "true",
      validate  = false,
    } = req.body || {};

    const result = await PredictionService.runSinglePrediction({ serviceId, dryRun, validate });
    res.json(result);
  } catch (err) {
    console.error("❌ Prediction error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// GET /api/v1/prediction/stats
// Get current or last session stats
// ─────────────────────────────────────────
router.get("/prediction/stats", (req, res) => {
  const stats = PredictionService.getStats();
  res.json({
    running: PredictionService.isRunning(),
    stats:   stats || { message: "No prediction session has run yet" },
  });
});

// ─────────────────────────────────────────
// GET /api/v1/prediction/stream
// SSE stream — real-time prediction events for dashboard
// Each prediction step is pushed as it happens
// ─────────────────────────────────────────
router.get("/prediction/stream", (req, res) => {
  setupSSE(res);
  console.log("🔌 SSE Client connected to /prediction/stream");

  const onPrediction = (predictionData) => {
    res.write(`data: ${JSON.stringify(predictionData)}\n\n`);
  };

  eventEmitter.on("prediction:result", onPrediction);

  req.on("close", () => {
    eventEmitter.removeListener("prediction:result", onPrediction);
    console.log("🔌 SSE Client disconnected from /prediction/stream");
    res.end();
  });
});

export default router;
