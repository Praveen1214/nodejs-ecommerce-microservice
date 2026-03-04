// auto-scaling-executor/api/collector.controller.js
// ============================================================
// REST endpoints to control the SSE-based Feature Collector
// ============================================================

import FeatureCollector from "../services/feature-collector.service.js";

export function registerCollectorRoutes(app) {
  /**
   * POST /api/v1/collector/start
   * Start listening to the SSE stream from the separate backend
   */
  app.post("/api/v1/collector/start", (req, res) => {
    FeatureCollector.start();
    res.json({
      status: "started",
      ...FeatureCollector.getStatus(),
    });
  });

  /**
   * POST /api/v1/collector/stop
   * Stop the SSE connection
   */
  app.post("/api/v1/collector/stop", (req, res) => {
    FeatureCollector.stop();
    res.json({
      status: "stopped",
      ...FeatureCollector.getStatus(),
    });
  });

  /**
   * GET /api/v1/collector/status
   * Get current collector status (running, window fill level, events received, config)
   */
  app.get("/api/v1/collector/status", (req, res) => {
    res.json(FeatureCollector.getStatus());
  });

  /**
   * POST /api/v1/collector/inject
   * Manually inject a single metric row for testing (bypasses SSE).
   *
   * Body: Array of 21 numbers (matching the model's feature order)
   *   OR: Object with named fields {request_rate_rps, latency_p95_ms, ..., current_pod_count}
   *
   * Example:
   *   POST /api/v1/collector/inject
   *   [73.3, 85.09, 111.69, 0.036, 0, 26.36, 30.07, 516.7, 575.8, 0, 1, -0.97, -0.22, 71.99, 83.33, 0.037, 0.83, 0.85, 0.65, 0.73, 2]
   */
  app.post("/api/v1/collector/inject", async (req, res) => {
    try {
      await FeatureCollector.injectRow(req.body);
      res.json({
        status: "injected",
        ...FeatureCollector.getStatus(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
