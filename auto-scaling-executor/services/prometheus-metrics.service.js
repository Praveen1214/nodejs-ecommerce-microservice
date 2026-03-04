// auto-scaling-executor/services/prometheus-metrics.service.js
// ============================================================
// PROMETHEUS METRICS — Exposes autoscaling pipeline observability
// ============================================================
//
// Tracks every stage of the predictive autoscaling pipeline:
//   Collector → ML Prediction → Scaling → Validation → Promote/Rollback
//
// Scraping: GET /metrics  (exposed in index.js)
// ============================================================

import client from "prom-client";

const register = new client.Registry();

// Default Node.js process metrics (heap, GC, event loop, etc.)
client.collectDefaultMetrics({ register, prefix: "executor_nodejs_" });

// ============================================================
// 1. FEATURE COLLECTOR METRICS
// ============================================================

/** Gauge: current sliding window fill level (0–48) */
const collectorWindowSize = new client.Gauge({
  name: "executor_collector_window_size",
  help: "Current number of rows in the 48-step sliding window",
});

/** Counter: total metric events received from SSE/POLL */
const collectorEventsTotal = new client.Counter({
  name: "executor_collector_events_total",
  help: "Total metric events received by the feature collector",
  labelNames: ["mode"], // SSE | POLL
});

/** Gauge: collector running state (1 = running, 0 = stopped) */
const collectorRunning = new client.Gauge({
  name: "executor_collector_running",
  help: "Whether the feature collector is actively running (1=yes, 0=no)",
});

// ============================================================
// 2. ML PREDICTION METRICS
// ============================================================

/** Counter: total predictions requested from ML service */
const predictionsTotal = new client.Counter({
  name: "executor_predictions_total",
  help: "Total ML predictions triggered",
  labelNames: ["status"], // success | error
});

/** Histogram: ML prediction latency (round-trip to FastAPI) */
const predictionLatencyMs = new client.Histogram({
  name: "executor_prediction_latency_ms",
  help: "Latency of ML prediction requests in milliseconds",
  buckets: [50, 100, 200, 500, 1000, 2000, 5000],
});

/** Gauge: last predicted pod count from the BiLSTM model */
const predictedPods = new client.Gauge({
  name: "executor_predicted_pods",
  help: "Last predicted pod count from the ML model",
  labelNames: ["deployment"],
});

/** Gauge: current pod count at time of prediction */
const currentPods = new client.Gauge({
  name: "executor_current_pods",
  help: "Current pod count at time of prediction",
  labelNames: ["deployment"],
});

// ============================================================
// 3. SCALING ACTION METRICS
// ============================================================

/** Counter: total scaling actions attempted */
const scalingActionsTotal = new client.Counter({
  name: "executor_scaling_actions_total",
  help: "Total scaling actions by type and outcome",
  labelNames: ["deployment", "action", "status"],
  // action: scale_up | scale_down | no_change
  // status: success | failed | rolled_back
});

/** Histogram: end-to-end scaling + validation duration */
const scalingDurationMs = new client.Histogram({
  name: "executor_scaling_duration_ms",
  help: "End-to-end time for scale + validate + promote/rollback in ms",
  labelNames: ["deployment"],
  buckets: [100, 500, 1000, 2000, 5000, 10000, 30000, 60000],
});

/** Gauge: last attempted pod delta per deployment */
const scalingPodDelta = new client.Gauge({
  name: "executor_scaling_pod_delta",
  help: "Last attempted pod count change (positive=up, negative=down)",
  labelNames: ["deployment"],
});

// ============================================================
// 4. VALIDATION METRICS
// ============================================================

/** Gauge: latest resilience score (0–1) per deployment */
const resilienceScore = new client.Gauge({
  name: "executor_resilience_score",
  help: "Latest composite resilience score (0-1)",
  labelNames: ["deployment"],
});

/** Gauge: latest latency sub-score (0–1) */
const resilienceLatencyScore = new client.Gauge({
  name: "executor_resilience_latency_score",
  help: "Latest latency component of resilience score",
  labelNames: ["deployment"],
});

/** Gauge: latest error sub-score (0–1) */
const resilienceErrorScore = new client.Gauge({
  name: "executor_resilience_error_score",
  help: "Latest error-rate component of resilience score",
  labelNames: ["deployment"],
});

/** Gauge: latest traffic sub-score (0–1) */
const resilienceTrafficScore = new client.Gauge({
  name: "executor_resilience_traffic_score",
  help: "Latest traffic-recovery component of resilience score",
  labelNames: ["deployment"],
});

/** Counter: validation outcomes */
const validationResultsTotal = new client.Counter({
  name: "executor_validation_results_total",
  help: "Total validation outcomes",
  labelNames: ["deployment", "result"],
  // result: passed | failed | skipped
});

/** Counter: rollbacks executed */
const rollbacksTotal = new client.Counter({
  name: "executor_rollbacks_total",
  help: "Total rollbacks executed after validation failure",
  labelNames: ["deployment"],
});

/** Counter: promotions (scale kept) */
const promotionsTotal = new client.Counter({
  name: "executor_promotions_total",
  help: "Total promotions (scaling kept after validation passed)",
  labelNames: ["deployment"],
});

// ============================================================
// 5. CHAOS ENGINEERING METRICS
// ============================================================

/** Counter: chaos tests injected */
const chaosInjectionsTotal = new client.Counter({
  name: "executor_chaos_injections_total",
  help: "Total chaos pod-failure injections",
  labelNames: ["deployment", "status"], // success | failed
});

// ============================================================
// 6. SYSTEM HEALTH METRICS (latest raw values from payload)
// ============================================================

/** Gauge: latest CPU % seen in validation payload */
const lastCpuPercent = new client.Gauge({
  name: "executor_last_cpu_percent",
  help: "Latest CPU usage percentage from validation payload",
  labelNames: ["deployment"],
});

/** Gauge: latest memory % seen in validation payload */
const lastMemPercent = new client.Gauge({
  name: "executor_last_mem_percent",
  help: "Latest memory usage percentage from validation payload",
  labelNames: ["deployment"],
});

/** Gauge: latest error rate seen in validation payload */
const lastErrorRate = new client.Gauge({
  name: "executor_last_error_rate",
  help: "Latest error rate from validation payload",
  labelNames: ["deployment"],
});

/** Gauge: latest p95 latency seen in validation payload */
const lastP95Latency = new client.Gauge({
  name: "executor_last_p95_latency_ms",
  help: "Latest p95 latency in ms from validation payload",
  labelNames: ["deployment"],
});

// ============================================================
// Register all metrics
// ============================================================

const allMetrics = [
  collectorWindowSize,
  collectorEventsTotal,
  collectorRunning,
  predictionsTotal,
  predictionLatencyMs,
  predictedPods,
  currentPods,
  scalingActionsTotal,
  scalingDurationMs,
  scalingPodDelta,
  resilienceScore,
  resilienceLatencyScore,
  resilienceErrorScore,
  resilienceTrafficScore,
  validationResultsTotal,
  rollbacksTotal,
  promotionsTotal,
  chaosInjectionsTotal,
  lastCpuPercent,
  lastMemPercent,
  lastErrorRate,
  lastP95Latency,
];

allMetrics.forEach((m) => register.registerMetric(m));

// ============================================================
// Export named metrics + registry
// ============================================================

export {
  register,
  // Collector
  collectorWindowSize,
  collectorEventsTotal,
  collectorRunning,
  // Prediction
  predictionsTotal,
  predictionLatencyMs,
  predictedPods,
  currentPods,
  // Scaling
  scalingActionsTotal,
  scalingDurationMs,
  scalingPodDelta,
  // Validation
  resilienceScore,
  resilienceLatencyScore,
  resilienceErrorScore,
  resilienceTrafficScore,
  validationResultsTotal,
  rollbacksTotal,
  promotionsTotal,
  // Chaos
  chaosInjectionsTotal,
  // System health
  lastCpuPercent,
  lastMemPercent,
  lastErrorRate,
  lastP95Latency,
};
