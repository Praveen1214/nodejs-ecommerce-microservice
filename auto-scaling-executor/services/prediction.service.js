/**
 * Prediction Service (ES Module)
 * ================================
 * Connects the ML Prediction API <-> K8s Scaling Executor to form
 * a closed-loop proactive autoscaling system.
 *
 * Converted from the old standalone controller script into a reusable service
 * that runs inside the auto-scaling-executor Express app.
 */

import https from "https";
import http from "http";
import { emitPredictionEvent } from "../realtime/alert.publisher.js";
import eventEmitter from "../utils/events.js";
import ScalingService from "./scaling.service.js";
import MetricsService from "./metrics.service.js";
import LoggingService from "./logging.service.js";
import logger from "../utils/logger.js";

// ============================================================
// Configuration (read from env)
// ============================================================

const ML_API_URL = process.env.ML_API_URL
  || "https://mlapi-b3h4fpduauancfcg.southeastasia-01.azurewebsites.net";

const DEFAULT_EXECUTOR_PORT = Number(process.env.PORT || 6000);
const EXECUTOR_URL = process.env.EXECUTOR_URL
  || `http://localhost:${DEFAULT_EXECUTOR_PORT}/api/v1/scale-with-metrics`;


const ML_API_TIMEOUT_MS = Number(process.env.ML_API_TIMEOUT_MS || 30_000);
const ML_API_RETRIES = Number(process.env.ML_API_RETRIES || 2);

const LOOKBACK = 48; // sliding window size (48 rows Ã— 21 features)

const FEATURE_COLS = [
  "request_rate_rps",          "latency_p95_ms",            "latency_p99_ms",
  "error_rate_percent",        "queue_length",              "pod_cpu_usage_percent_avg",
  "pod_cpu_usage_percent_p95", "pod_memory_usage_mb_avg",   "pod_memory_usage_mb_p95",
  "hour_sin",                  "hour_cos",                  "day_sin",
  "day_cos",                   "mesh_inbound_rps",          "mesh_inbound_latency_p95",
  "mesh_inbound_error_rate",   "degree_centrality",         "eigenvector_centrality",
  "betweenness_centrality",    "closeness_centrality",
];

// ============================================================
// State
// ============================================================

let running = false;
let stopRequested = false;
let currentStats = null;

// ============================================================
// ANSI colour helpers
// ============================================================

const RESET = "\x1b[0m";
const COLORS = {
  INFO:     "\x1b[94m",
  PREDICT:  "\x1b[96m",
  SCALE:    "\x1b[91m",
  SKIP:     "\x1b[90m",
  OK:       "\x1b[92m",
  WARN:     "\x1b[93m",
  ERROR:    "\x1b[91m",
  "DRY-RUN":"\x1b[95m",
  VALIDATE: "\x1b[96m",
  ROLLBACK: "\x1b[95m",
};

function log(level, message) {
  const ts    = new Date().toISOString().slice(11, 19);
  const color = COLORS[level] || "";
  const lbl   = level.padStart(8, " ").slice(0, 8);
  console.log(`  ${color}[${ts}] [${lbl}]${RESET} ${message}`);
}

// ============================================================
// 1. HTTP helper â€” Promise-based (no npm deps)
// ============================================================

function request(url, { method = "GET", body = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === "https:" ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers:  { "Content-Type": "application/json", "Accept": "application/json" },
    };

    const chunks = [];
    const req = lib.request(options, (res) => {
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw  = Buffer.concat(chunks).toString();
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          return reject(new Error(`Invalid JSON from ${url}: ${raw.slice(0, 200)}`));
        }
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
        resolve(data);
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on("error", reject);

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function toIsoTimestamp(value) {
  const dt = value ? new Date(value) : new Date();
  if (Number.isNaN(dt.getTime())) return new Date().toISOString();
  return dt.toISOString();
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function parseWindowToNumbers(window = []) {
  return window.map((row) => row.map((cell) => Number(cell)));
}

function rowToRawMetrics(row = []) {
  return {
    request_rate_rps: row[0],
    latency_p95_ms: row[1],
    latency_p99_ms: row[2],
    error_rate_percent: row[3],
    queue_length: row[4],
    pod_cpu_usage_percent_avg: row[5],
    pod_cpu_usage_percent_p95: row[6],
    pod_memory_usage_mb_avg: row[7],
    pod_memory_usage_mb_p95: row[8],
    current_pod_count: row[20],
  };
}

function normalizeRawMetrics(rawMetrics = {}) {
  const errorPct = Number(rawMetrics.error_rate_percent ?? 0);
  const errorRate = Math.min(Math.max(errorPct, 0), 1);
  const successRate = Number((1 - errorRate).toFixed(4));

  const latencyBefore = Number(Number(rawMetrics.latency_p95_ms ?? 0).toFixed(2));
  const cpuPercent = Number(Number(rawMetrics.pod_cpu_usage_percent_avg ?? 0).toFixed(2));
  const memPercentRaw = (Number(rawMetrics.pod_memory_usage_mb_p95 ?? 0) / 1024) * 100;
  const memPercent = Math.min(Number(memPercentRaw.toFixed(2)), 100);

  return {
    successRate,
    errorRate: Number(errorRate.toFixed(4)),
    p95LatencyBefore: latencyBefore,
    p95LatencyAfter: Number((latencyBefore * 0.6).toFixed(2)),
    cpuPercent,
    memPercent,
    restartCount: 0,
    trafficRecovery: 0.95,
  };
}

async function callPredictWithRetry(windowData, windowEndUtc, serviceId, { timeoutMs = ML_API_TIMEOUT_MS, retries = ML_API_RETRIES, inputSource = "controller" } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const payload = {
        window_data: windowData,
        window_end_utc: windowEndUtc,
        service_id: serviceId,
        input_source: inputSource,
      };

      return await request(`${ML_API_URL}/predict`, {
        method: "POST",
        body: payload,
        timeoutMs,
      });
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      const waitMs = 300 * (attempt + 1);
      logger.warn({
        event: "PREDICTION_RETRY",
        service_id: serviceId,
        attempt: attempt + 1,
        retries,
        wait_ms: waitMs,
        error: err.message,
      });
      await sleep(waitMs);
    }
  }

  throw lastError;
}

// ============================================================
// 2. Simulation data fetch
// ============================================================

async function fetchSimulationData() {
  log("INFO", "Fetching simulation data from ML API...");
  const body = await request(`${ML_API_URL}/simulation-data`, { timeoutMs: 60_000 });
  const data = body.data;
  log("INFO", `Loaded ${data.length} simulation rows (total dataset: ${body.total_rows})`);
  return data;
}

// ============================================================
// 3. Window builder
// ============================================================

function buildWindow(rows) {
  const windowData = rows.map((row) => {
    const values = FEATURE_COLS.map((col) => parseFloat(row[col]));
    values.push(parseFloat(row["current_pod_count"]));
    return values;
  });
  const windowEndUtc = rows[rows.length - 1].timestamp;
  return { windowData, windowEndUtc };
}

// ============================================================
// 4. ML API caller
// ============================================================

async function callPredict(windowData, windowEndUtc, serviceId = "Order") {
  const payload = {
    window_data:    windowData,
    window_end_utc: windowEndUtc,
    service_id:     serviceId,
    input_source:   "controller",
  };
  return request(`${ML_API_URL}/predict`, { method: "POST", body: payload, timeoutMs: 30_000 });
}

function logPredictionResponse(prediction, context = "") {
  const snapshot = {
    service_id: prediction.service_id || "Order",
    window_end_utc: prediction.window_end_utc || null,
    current_pods: prediction.current_pods,
    predicted_pods: prediction.predicted_pods,
    scale_action: prediction.scale_action,
    latency_ms: prediction.latency_ms,
  };
  const prefix = context ? `${context} ` : "";
  log("PREDICT", `${prefix}ML response: ${JSON.stringify(snapshot)}`);
}

// ============================================================
// 5. Prediction â†’ Executor payload converter
// ============================================================

function buildExecutorPayload(prediction, rawMetrics) {
  const { current_pods, predicted_pods, scale_action } = prediction;

  if (scale_action === "no_change") return null;

  const requestPods = Math.abs(predicted_pods - current_pods);
  const metrics = normalizeRawMetrics(rawMetrics);

  return {
    services: [{
      deployment:   (prediction.service_id || "Order").toLowerCase(),
      request_pods: requestPods,
      scale_action,
      metrics,
    }],
  };
}

async function sendToExecutor(payload, dryRun = false, context = "scale") {
  if (dryRun) {
    log("DRY-RUN", `${context}: would send to ${EXECUTOR_URL}\n${JSON.stringify(payload, null, 2)}`);
    return { status: "dry-run", message: "Skipped (dry-run mode)" };
  }

  try {
    log("SCALE", `${context}: POST ${EXECUTOR_URL}`);
    log("SCALE", `${context}: payload=${JSON.stringify(payload)}`);

    const executorResponse = await request(EXECUTOR_URL, { method: "POST", body: payload });
    const firstResult = Array.isArray(executorResponse?.results) ? executorResponse.results[0] : null;
    const status = firstResult?.status || executorResponse?.status || "executed";
    const message = firstResult?.message || executorResponse?.message || "Executor call completed";

    log("OK", `${context}: executor status=${status}`);
    return {
      status,
      message,
      executor_response: executorResponse,
    };
  } catch (err) {
    if (err.code === "ECONNREFUSED" || err.message.includes("connect")) {
      log("WARN", `Executor not reachable at ${EXECUTOR_URL} - is it running?`);
      return { status: "error", message: "Executor service unreachable" };
    }
    log("ERROR", `Executor call failed: ${err.message}`);
    return { status: "error", message: err.message };
  }
}

async function executeScalingHttp(prediction, rawMetrics, dryRun = false) {
  const { current_pods, predicted_pods, scale_action } = prediction;

  if (scale_action === "no_change") {
    log("SKIP", "Skipping executor call because scale_action=no_change");
    return { status: "skipped", message: "no_change - no scaling needed" };
  }

  const payload = buildExecutorPayload(prediction, rawMetrics);
  const result = await sendToExecutor(payload, dryRun, "scale");

  if (result.status === "error" || result.status === "dry-run") {
    return result;
  }

  return {
    ...result,
    source: "ml_prediction",
    prediction_metadata: {
      current_pods,
      predicted_pods,
      ml_latency_ms: prediction.latency_ms,
      window_end_utc: prediction.window_end_utc || null,
    },
  };
}

async function executeRollbackHttp(rollbackPayload, dryRun = false) {
  const result = await sendToExecutor(rollbackPayload, dryRun, "rollback");
  if (result.status === "error" || result.status === "dry-run") return result;
  return { ...result, source: "ml_prediction" };
}

// ============================================================
// 6. Legacy in-process scaling path (unused, kept for reference)
// ============================================================

async function legacyExecuteScalingInProcess(prediction, rawMetrics, dryRun = false) {
  return executeScalingHttp(prediction, rawMetrics, dryRun);

  if (scale_action === "no_change") {
    return { status: "skipped", message: "no_change â€” no scaling needed" };
  }

  if (dryRun) {
    const payload = buildExecutorPayload(prediction, rawMetrics);
    log("DRY-RUN", `Would scale:\n${JSON.stringify(payload, null, 2)}`);
    return { status: "dry-run", message: "Skipped (dry-run mode)" };
  }

  const deployment = (prediction.service_id || "Order").toLowerCase();
  const requestPods = Math.abs(predicted_pods - current_pods);

  // Build metrics from raw simulation data
  const errorPct    = parseFloat(rawMetrics.error_rate_percent ?? 0);
  const errorRate   = Math.min(Math.max(errorPct / 100.0, 0), 1);
  const successRate = parseFloat((1.0 - errorRate).toFixed(4));
  const cpuPct      = parseFloat(rawMetrics.pod_cpu_usage_percent_avg ?? 0);
  let   memPct      = parseFloat(rawMetrics.pod_memory_usage_mb_p95 ?? 0) / 1024 * 100;
  memPct = Math.min(parseFloat(memPct.toFixed(2)), 100);
  const latencyBefore = parseFloat(parseFloat(rawMetrics.latency_p95_ms ?? 0).toFixed(2));

  const metrics = {
    successRate,
    errorRate:        parseFloat(errorRate.toFixed(4)),
    p95LatencyBefore: latencyBefore,
    p95LatencyAfter:  parseFloat((latencyBefore * 0.6).toFixed(2)),
    cpuPercent:       parseFloat(cpuPct.toFixed(2)),
    memPercent:       memPct,
    restartCount:     0,
    trafficRecovery:  0.95,
  };

  try {
    // Call ScalingService directly â€” same process, no HTTP
    const result = await ScalingService.scaleOneWithMetrics({
      deployment,
      request_pods: requestPods,
      metrics,
      scale_action,
    });

    // Tag the result with ML prediction source
    result.source = "ml_prediction";
    result.prediction_metadata = {
      current_pods,
      predicted_pods,
      ml_latency_ms: prediction.latency_ms,
      window_end_utc: prediction.window_end_utc || null,
    };

    // Capture deployment health
    try {
      const namespace = process.env.K8S_NAMESPACE || "ecommerce-test";
      await DeploymentHealthService.captureDeploymentHealthRealtime(deployment, namespace);
    } catch (e) {
      // non-critical
    }

    // Emit socket event so dashboard gets real-time update
    try {
      emitScalingEvent(result);
    } catch (e) {
      // socket may not be initialized
    }

    return result;
  } catch (err) {
    log("ERROR", `Executor call failed: ${err.message}`);
    return { status: "error", message: err.message };
  }
}

// Helper for rollback payloads (validation still uses HTTP-style payload)
async function legacyExecuteRollbackInProcess(rollbackPayload, dryRun = false) {
  return executeRollbackHttp(rollbackPayload, dryRun);
  if (dryRun) {
    log("DRY-RUN", `Rollback payload:\n${JSON.stringify(rollbackPayload, null, 2)}`);
    return { status: "dry-run", message: "Rollback skipped (dry-run)" };
  }

  const svc = rollbackPayload.services[0];
  try {
    const result = await ScalingService.scaleOneWithMetrics({
      deployment:   svc.deployment,
      request_pods: svc.request_pods,
      metrics:      svc.metrics,
      scale_action: svc.scale_action,
    });
    result.source = "ml_prediction";
    try { emitScalingEvent(result); } catch (e) { /* swallow */ }
    return result;
  } catch (err) {
    log("ERROR", `Rollback failed: ${err.message}`);
    return { status: "error", message: err.message };
  }
}

// ============================================================
// 7. Validate + Rollback
// ============================================================

async function validateScaleAction(data, step, originalPrediction, dryRun = false) {
  const nextStart = step + 1;
  const nextEnd   = nextStart + LOOKBACK;

  if (nextEnd > data.length) {
    return { status: "skipped", message: "Not enough lookahead data", rollbackPayload: null };
  }

  let nextPred;
  try {
    const nextRows = data.slice(nextStart, nextEnd);
    const { windowData, windowEndUtc } = buildWindow(nextRows);
    nextPred = await callPredict(windowData, windowEndUtc, originalPrediction.service_id || "Order");
  } catch (err) {
    log("WARN", `Validate: ML API call failed â€” ${err.message}`);
    return { status: "skipped", message: `ML API error: ${err.message}`, rollbackPayload: null };
  }

  const origAction   = originalPrediction.scale_action;
  const nextAction   = nextPred.scale_action;
  const origPredPods = originalPrediction.predicted_pods;
  const nextCurrPods = nextPred.current_pods;
  const nextPredPods = nextPred.predicted_pods;

  if (origAction === "no_change") {
    if (nextAction === "no_change") {
      const reason = `Confirmed: no_change still valid Ã¢â‚¬â€ next window predicts no_change (${nextPredPods} pods)`;
      log("VALIDATE", `Ã¢Å“â€œ ${reason}`);
      return { status: "validated", message: reason, rollbackPayload: null };
    }

    const reason = `No-change drift detected Ã¢â‚¬â€ next window predicts ${nextAction} (${nextPredPods} pods)`;
    log("WARN", reason);
    return { status: "drift", message: reason, rollbackPayload: null };
  }

  const conflict = (
    (origAction === "scale_up"   && nextAction === "scale_down") ||
    (origAction === "scale_down" && nextAction === "scale_up")
  );

  if (conflict) {
    const rollbackAction = origAction === "scale_up" ? "scale_down" : "scale_up";
    const rollbackPods   = Math.max(Math.abs(origPredPods - nextCurrPods), 1);

    const rollbackPayload = {
      services: [{
        deployment:   (originalPrediction.service_id || "Order").toLowerCase(),
        request_pods: rollbackPods,
        scale_action: rollbackAction,
        metrics: {
          successRate:      0.95,
          errorRate:        0.05,
          p95LatencyBefore: 0,
          p95LatencyAfter:  0,
          cpuPercent:       0,
          memPercent:       0,
          restartCount:     0,
          trafficRecovery:  0.90,
        },
      }],
    };

    const reason = `Original action=${origAction} (â†’${origPredPods} pods) ` +
                   `but next step says ${nextAction} (â†’${nextPredPods} pods) â€” ROLLING BACK`;

    log("ROLLBACK", reason);

    if (dryRun) {
      log("DRY-RUN", `Rollback payload:\n${JSON.stringify(rollbackPayload, null, 2)}`);
    } else {
      const result = await executeRollbackHttp(rollbackPayload, false);
      log("ROLLBACK", `Rollback executor result: ${JSON.stringify(result)}`);
    }

    return { status: "rollback", message: reason, rollbackPayload };
  }

  const reason = `Confirmed: ${origAction} still valid â€” ` +
                 `next window predicts ${nextAction} (${nextPredPods} pods)`;
  log("VALIDATE", `âœ“ ${reason}`);
  return { status: "validated", message: reason, rollbackPayload: null };
}

// ============================================================
// 8. Single prediction (for on-demand API calls)
// ============================================================

async function runSinglePrediction({ serviceId = "Order", dryRun = false, validate = false } = {}) {
  const data = await fetchSimulationData();

  if (data.length < LOOKBACK) {
    throw new Error(`Not enough simulation data: need ${LOOKBACK} rows, got ${data.length}`);
  }

  // Use the last 48 rows as the prediction window
  const windowRows = data.slice(data.length - LOOKBACK);
  const { windowData, windowEndUtc } = buildWindow(windowRows);
  const latestRow = windowRows[windowRows.length - 1];

  const prediction = await callPredict(windowData, windowEndUtc, serviceId);
  const { current_pods, predicted_pods, scale_action, latency_ms } = prediction;

  // Add window_end_utc to prediction for metadata tracking
  prediction.window_end_utc = windowEndUtc;
  logPredictionResponse(prediction, "single");

  let executorResult = null;

  if (scale_action !== "no_change") {
    executorResult = await executeScalingHttp(prediction, latestRow, dryRun);
  }

  const deployment = (serviceId || "Order").toLowerCase();

  // Emit prediction event to dashboard
  const predictionEvent = {
    step: 1,
    deployment,
    current_pods,
    predicted_pods,
    scale_action,
    ml_latency_ms: latency_ms,
    window_end_utc: windowEndUtc,
    executor_status: executorResult?.status || (scale_action === "no_change" ? "skipped" : null),
    dry_run: dryRun,
  };

  try { emitPredictionEvent(predictionEvent); } catch (e) { /* swallow */ }
  eventEmitter.emit("prediction:result", predictionEvent);

  return {
    prediction: {
      current_pods,
      predicted_pods,
      scale_action,
      latency_ms,
      service_id: serviceId,
      window_end_utc: windowEndUtc,
    },
    executor_result: executorResult,
    dry_run: dryRun,
  };
}

async function processMetricsWindow({
  serviceId = "Order",
  timestamp = new Date().toISOString(),
  window = [],
  dryRun = false,
  validate = true,
  source = "synthetic_window",
} = {}) {
  const normalizedServiceId = String(serviceId || "Order");
  const windowEndUtc = toIsoTimestamp(timestamp);

  if (!Array.isArray(window) || window.length !== LOOKBACK) {
    throw new Error(`window must contain exactly ${LOOKBACK} rows`);
  }
  for (let r = 0; r < window.length; r++) {
    if (!Array.isArray(window[r]) || window[r].length !== FEATURE_COLS.length + 1) {
      throw new Error(`window row ${r} must contain exactly ${FEATURE_COLS.length + 1} values`);
    }
    for (let c = 0; c < window[r].length; c++) {
      if (!isFiniteNumber(Number(window[r][c]))) {
        throw new Error(`window row ${r}, col ${c} must be a finite number`);
      }
    }
  }

  const numericWindow = parseWindowToNumbers(window);
  const lastRow = numericWindow[numericWindow.length - 1] || [];

  await LoggingService.logPipelineEvent({
    serviceId: normalizedServiceId,
    event: "prediction_received",
    status: "INFO",
    source,
    timestamp: new Date(windowEndUtc),
    details: {
      rows: numericWindow.length,
      columns: numericWindow[0]?.length || 0,
      dryRun,
      validate,
    },
  });

  logger.info({
    event: "prediction_received",
    service_id: normalizedServiceId,
    rows: numericWindow.length,
    columns: numericWindow[0]?.length || 0,
    dry_run: dryRun,
    validate,
    source,
  });

  let prediction;
  try {
    prediction = await callPredictWithRetry(numericWindow, windowEndUtc, normalizedServiceId, {
      timeoutMs: ML_API_TIMEOUT_MS,
      retries: ML_API_RETRIES,
      inputSource: source,
    });
  } catch (err) {
    await LoggingService.logPipelineEvent({
      serviceId: normalizedServiceId,
      event: "prediction_processed",
      status: "ERROR",
      source,
      timestamp: new Date(windowEndUtc),
      details: { error: err.message },
      message: "Prediction failed",
    });
    throw err;
  }
  prediction.window_end_utc = windowEndUtc;

  await LoggingService.logPipelineEvent({
    serviceId: normalizedServiceId,
    event: "prediction_processed",
    status: "SUCCESS",
    source,
    timestamp: new Date(windowEndUtc),
    details: {
      current_pods: prediction.current_pods,
      predicted_pods: prediction.predicted_pods,
      scale_action: prediction.scale_action,
      latency_ms: prediction.latency_ms,
    },
  });

  const deployment = normalizedServiceId.toLowerCase();
  const rawMetrics = rowToRawMetrics(lastRow);
  const metrics = normalizeRawMetrics(rawMetrics);
  const requestPods = Math.max(1, Math.abs(Number(prediction.predicted_pods || 0) - Number(prediction.current_pods || 0)));

  let scalingResult;
  let validationStatus = null;

  const shouldValidate = Boolean(validate);

  if (prediction.scale_action === "no_change") {
    await LoggingService.logPipelineEvent({
      serviceId: normalizedServiceId,
      event: "validation_skipped",
      status: "INFO",
      source,
      timestamp: new Date(windowEndUtc),
      details: { reason: shouldValidate ? "scale_action=no_change" : "validate=false", dryRun },
    });

    if (dryRun && shouldValidate) {
      const extracted = MetricsService.extractFromPayload(metrics);
      const stability = MetricsService.evaluateStability(extracted);
      const scoreData = MetricsService.calculateResilienceScore(extracted);
      const passed = stability.isStable && scoreData.score >= Number(process.env.RESILIENCE_THRESHOLD || 0.7);

      scalingResult = {
        deployment,
        request_pods: 0,
        scale_action: "no_change",
        previous_replicas: Number(prediction.current_pods || 0),
        attempted_additional_replicas: 0,
        additional_replicas: 0,
        required_replicas: Number(prediction.current_pods || 0),
        status: "NO_ACTION_DRY_RUN",
        message: "Dry-run no_change processed with validation metrics",
        source,
        prediction_metadata: {
          current_pods: Number(prediction.current_pods || 0),
          predicted_pods: Number(prediction.predicted_pods || 0),
          ml_latency_ms: Number(prediction.latency_ms || 0),
          window_end_utc: windowEndUtc,
        },
        validation: {
          ...scoreData,
          passed,
          rolledBack: false,
          skipped: false,
          threshold: Number(process.env.RESILIENCE_THRESHOLD || 0.7),
          hardSafetyPassed: stability.isStable,
          reasons: stability.reasons,
          metricsEvaluation: stability.evaluations || [],
          standardsUsed: MetricsService.THRESHOLDS,
        },
      };
      await LoggingService.logScalingResult(scalingResult);
    } else if (dryRun) {
      scalingResult = {
        deployment,
        request_pods: 0,
        scale_action: "no_change",
        previous_replicas: Number(prediction.current_pods || 0),
        attempted_additional_replicas: 0,
        additional_replicas: 0,
        required_replicas: Number(prediction.current_pods || 0),
        status: "NO_ACTION_DRY_RUN",
        message: "Dry-run no_change processed (validation disabled)",
        source,
        prediction_metadata: {
          current_pods: Number(prediction.current_pods || 0),
          predicted_pods: Number(prediction.predicted_pods || 0),
          ml_latency_ms: Number(prediction.latency_ms || 0),
          window_end_utc: windowEndUtc,
        },
        validation: {
          passed: null,
          rolledBack: false,
          skipped: true,
          reason: "validate=false",
        },
      };
      await LoggingService.logScalingResult(scalingResult);
    } else {
      scalingResult = await ScalingService.scaleOneWithMetrics({
        deployment,
        request_pods: 1,
        scale_action: "no_change",
        metrics: shouldValidate ? metrics : undefined,
      });
      scalingResult.source = source;
      scalingResult.prediction_metadata = {
        current_pods: Number(prediction.current_pods || 0),
        predicted_pods: Number(prediction.predicted_pods || 0),
        ml_latency_ms: Number(prediction.latency_ms || 0),
        window_end_utc: windowEndUtc,
      };
      // no_change path in ScalingService now logs automatically
    }

    validationStatus = shouldValidate && scalingResult?.validation?.passed === false ? "failed" : "skipped";

    await LoggingService.logPipelineEvent({
      serviceId: normalizedServiceId,
      event: "no_change",
      status: scalingResult?.status || "NO_ACTION",
      source,
      timestamp: new Date(windowEndUtc),
      details: {
        message: scalingResult?.message,
        validation_status: validationStatus,
      },
    });
  } else {
    await LoggingService.logPipelineEvent(
      shouldValidate
        ? {
            serviceId: normalizedServiceId,
            event: "validation_triggered",
            status: "INFO",
            source,
            timestamp: new Date(windowEndUtc),
            details: {
              action: prediction.scale_action,
              request_pods: requestPods,
              dryRun,
            },
          }
        : {
            serviceId: normalizedServiceId,
            event: "validation_skipped",
            status: "INFO",
            source,
            timestamp: new Date(windowEndUtc),
            details: {
              action: prediction.scale_action,
              request_pods: requestPods,
              dryRun,
              reason: "validate=false",
            },
          }
    );

    if (dryRun && shouldValidate) {
      const extracted = MetricsService.extractFromPayload(metrics);
      const stability = MetricsService.evaluateStability(extracted);
      const scoreData = MetricsService.calculateResilienceScore(extracted);
      const passed = stability.isStable && scoreData.score >= Number(process.env.RESILIENCE_THRESHOLD || 0.7);

      scalingResult = {
        deployment,
        request_pods: requestPods,
        scale_action: prediction.scale_action,
        previous_replicas: Number(prediction.current_pods || 0),
        attempted_additional_replicas: requestPods,
        additional_replicas: requestPods,
        required_replicas: Number(prediction.predicted_pods || 0),
        status: passed ? "DRY_RUN_VALIDATED" : "DRY_RUN_VALIDATION_FAILED",
        message: "Dry-run scaling validation completed (no real scaling executed)",
        source,
        prediction_metadata: {
          current_pods: Number(prediction.current_pods || 0),
          predicted_pods: Number(prediction.predicted_pods || 0),
          ml_latency_ms: Number(prediction.latency_ms || 0),
          window_end_utc: windowEndUtc,
        },
        validation: {
          ...scoreData,
          passed,
          rolledBack: false,
          skipped: false,
          threshold: Number(process.env.RESILIENCE_THRESHOLD || 0.7),
          hardSafetyPassed: stability.isStable,
          reasons: stability.reasons,
          metricsEvaluation: stability.evaluations || [],
          standardsUsed: MetricsService.THRESHOLDS,
        },
      };
      await LoggingService.logScalingResult(scalingResult);
    } else if (dryRun) {
      scalingResult = {
        deployment,
        request_pods: requestPods,
        scale_action: prediction.scale_action,
        previous_replicas: Number(prediction.current_pods || 0),
        attempted_additional_replicas: requestPods,
        additional_replicas: requestPods,
        required_replicas: Number(prediction.predicted_pods || 0),
        status: "DRY_RUN_NO_VALIDATION",
        message: "Dry-run scaling processed (validation disabled)",
        source,
        prediction_metadata: {
          current_pods: Number(prediction.current_pods || 0),
          predicted_pods: Number(prediction.predicted_pods || 0),
          ml_latency_ms: Number(prediction.latency_ms || 0),
          window_end_utc: windowEndUtc,
        },
        validation: {
          passed: null,
          rolledBack: false,
          skipped: true,
          reason: "validate=false",
        },
      };
      await LoggingService.logScalingResult(scalingResult);
    } else {
      scalingResult = await ScalingService.scaleOneWithMetrics({
        deployment,
        request_pods: requestPods,
        metrics: shouldValidate ? metrics : undefined,
        scale_action: prediction.scale_action,
      });
      scalingResult.source = source;
      scalingResult.prediction_metadata = {
        current_pods: Number(prediction.current_pods || 0),
        predicted_pods: Number(prediction.predicted_pods || 0),
        ml_latency_ms: Number(prediction.latency_ms || 0),
        window_end_utc: windowEndUtc,
      };
    }

    validationStatus = shouldValidate
      ? (
          scalingResult?.validation?.rolledBack
            ? "rolled_back"
            : (scalingResult?.validation?.passed ? "validated" : "failed")
        )
      : "skipped";

    await LoggingService.logPipelineEvent({
      serviceId: normalizedServiceId,
      event: "scale_executed",
      status: scalingResult?.status || "UNKNOWN",
      source,
      timestamp: new Date(windowEndUtc),
      details: {
        action: prediction.scale_action,
        request_pods: requestPods,
        validation_status: validationStatus,
        required_replicas: scalingResult?.required_replicas,
      },
    });
  }

  const predictionEvent = {
    deployment,
    current_pods: Number(prediction.current_pods || 0),
    predicted_pods: Number(prediction.predicted_pods || 0),
    scale_action: prediction.scale_action,
    ml_latency_ms: Number(prediction.latency_ms || 0),
    window_end_utc: windowEndUtc,
    executor_status: scalingResult?.status || "NO_ACTION",
    dry_run: dryRun,
    validation_status: validationStatus,
    source,
  };
  try { emitPredictionEvent(predictionEvent); } catch (e) { /* swallow */ }
  eventEmitter.emit("prediction:result", predictionEvent);

  return {
    prediction: {
      current_pods: Number(prediction.current_pods || 0),
      predicted_pods: Number(prediction.predicted_pods || 0),
      scale_action: prediction.scale_action,
      latency_ms: Number(prediction.latency_ms || 0),
      service_id: normalizedServiceId,
      window_end_utc: windowEndUtc,
    },
    scaling_result: scalingResult,
    dry_run: dryRun,
    source,
  };
}

// ============================================================
// 9. Controller loop (runs in background)
// ============================================================

async function runControllerLoop({
  intervalSec  = 60,
  maxSteps     = null,
  dryRun       = false,
  startOffset  = 0,
  validate     = false,
  serviceId    = "Order",
} = {}) {
  if (running) {
    throw new Error("Prediction controller is already running");
  }

  running = true;
  stopRequested = false;

  // Banner
  console.log();
  console.log("=".repeat(76));
  console.log("  SMART RESOURCE ALLOCATION CONTROLLER (embedded)");
  console.log("  ML Prediction API  â†â†’  K8s Scaling Executor (HTTP)");
  console.log("=".repeat(76));
  console.log(`  ML API:     ${ML_API_URL}`);
  console.log(`  Executor:   ${EXECUTOR_URL}`);
  console.log(`  Service:    ${serviceId}`);
  console.log(`  Interval:   ${intervalSec}s${intervalSec === 60 ? " (real-time)" : ""}`);
  console.log(`  Dry-run:    ${dryRun}`);
  console.log(`  Validate:   ${validate}`);
  console.log(`  Max steps:  ${maxSteps ?? "unlimited"}`);
  console.log("=".repeat(76));

  // Fetch simulation data
  let data = await fetchSimulationData();

  if (startOffset > 0) {
    data = data.slice(startOffset);
    log("INFO", `Skipped first ${startOffset} rows (start-offset)`);
  }

  let totalSteps = data.length - LOOKBACK;
  if (maxSteps) totalSteps = Math.min(totalSteps, maxSteps);
  log("INFO", `Ready to run ${totalSteps} prediction steps`);
  console.log();

  // Tracking
  const stats = {
    predictions:    0,
    scale_ups:      0,
    scale_downs:    0,
    no_changes:     0,
    executor_calls: 0,
    executor_errors:0,
    validation_checks: 0,
    validation_skipped: 0,
    validation_drifts: 0,
    validated:      0,
    rollbacks:      0,
    latencies:      [],
    started_at:     new Date().toISOString(),
    service_id:     serviceId,
  };

  const actionDisplay = {
    scale_up:   `\x1b[91mâ–² SCALE UP\x1b[0m  `,
    scale_down: `\x1b[92mâ–¼ SCALE DOWN\x1b[0m`,
    no_change:  `\x1b[90mâ€” NO CHANGE\x1b[0m `,
  };

  const hdr = `  ${"Step".padEnd(6)} ${"Time (sim)".padEnd(22)} ${"Curr".padEnd(6)} ${"Pred".padEnd(6)} ` +
              `${"Action".padEnd(14)} ${"Exec Result".padEnd(20)} Latency`;
  console.log(hdr);
  console.log("  " + "-".repeat(84));

  // Main loop
  for (let step = 0; step < totalSteps; step++) {
    if (stopRequested) {
      log("INFO", "Stop requested â€” ending controller loop");
      break;
    }

    const windowRows = data.slice(step, step + LOOKBACK);
    if (windowRows.length < LOOKBACK) break;

    const { windowData, windowEndUtc } = buildWindow(windowRows);
    const latestRow = windowRows[windowRows.length - 1];

    let prediction;
    try {
      prediction = await callPredict(windowData, windowEndUtc, serviceId);
    } catch (err) {
      log("ERROR", `Step ${step + 1}: ML API failed â€” ${err.message}`);
      continue;
    }

    const { current_pods: current, predicted_pods: predicted,
            scale_action: action,  latency_ms: latency } = prediction;

    // Attach window_end_utc for metadata
    prediction.window_end_utc = windowEndUtc;
    logPredictionResponse(prediction, `step=${step + 1}`);

    stats.predictions++;
    stats.latencies.push(latency);

    let execResult = "â€”";
    let executorStatus = null;
    let validationStatus = null;

    if (action === "no_change") {
      stats.no_changes++;
      execResult = "skipped";
      executorStatus = "skipped";
      if (validate) {
        const vresult = await validateScaleAction(data, step, prediction, dryRun);
        validationStatus = vresult.status;
        stats.validation_checks++;

        if (vresult.status === "validated") {
          stats.validated++;
          execResult += " | valid";
        } else if (vresult.status === "drift") {
          stats.validation_drifts++;
          execResult += " | drift";
        } else if (vresult.status === "skipped") {
          stats.validation_skipped++;
          execResult += " | v-skip";
        }
      }
    } else {
      const result = await executeScalingHttp(prediction, latestRow, dryRun);
      stats.executor_calls++;

      if (result.status === "error") {
        stats.executor_errors++;
        execResult = `ERR: ${(result.message || "?").slice(0, 15)}`;
        executorStatus = "error";
      } else if (dryRun) {
        execResult = "dry-run OK";
        executorStatus = "dry-run";
      } else {
        execResult = result.status || "executed";
        executorStatus = result.status || "executed";
      }

      if (action === "scale_up")   stats.scale_ups++;
      else                         stats.scale_downs++;

      // Validate + Rollback
      if (validate) {
        const vresult = await validateScaleAction(data, step, prediction, dryRun);
        validationStatus = vresult.status;
        stats.validation_checks++;
        if (vresult.status === "validated") {
          stats.validated++;
          execResult += " âœ“valid";
        } else if (vresult.status === "rollback") {
          stats.rollbacks++;
          execResult += " â†©rollback";
        }
      }
    }

    // Emit prediction event to dashboard (every step, including no_change)
    const deployment = (serviceId || "Order").toLowerCase();
    const predictionEvent = {
      step: step + 1,
      deployment,
      current_pods: current,
      predicted_pods: predicted,
      scale_action: action,
      ml_latency_ms: latency,
      window_end_utc: windowEndUtc,
      executor_status: executorStatus,
      dry_run: dryRun,
      validation_status: validationStatus,
    };
    try { emitPredictionEvent(predictionEvent); } catch (e) { /* swallow */ }
    eventEmitter.emit("prediction:result", predictionEvent);

    // Print row
    const display = actionDisplay[action] || action;
    console.log(
      `  ${String(step + 1).padEnd(6)} ${String(windowEndUtc).padEnd(22)} ` +
      `${String(current).padEnd(6)} ${String(predicted).padEnd(6)} ` +
      `${display}  ${execResult.padEnd(20)} ${latency.toFixed(1)}ms`
    );

    currentStats = { ...stats };

    // Wait
    if (intervalSec > 0 && step < totalSteps - 1) {
      await sleep(intervalSec * 1000);
    }
  }

  // Summary
  printSummary(stats);
  currentStats = { ...stats, finished_at: new Date().toISOString() };
  running = false;
  stopRequested = false;

  return currentStats;
}

// ============================================================
// Summary printer
// ============================================================

function printSummary(stats) {
  const total = stats.predictions;
  if (total === 0) return;

  const avg = stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length;
  const min = Math.min(...stats.latencies);
  const max = Math.max(...stats.latencies);

  const pct = (n) => `(${((n / total) * 100).toFixed(1)}%)`;

  console.log();
  console.log("=".repeat(76));
  console.log("  CONTROLLER SESSION SUMMARY");
  console.log("=".repeat(76));
  console.log(`  Total predictions:     ${total}`);
  console.log(`  Scale ups:             ${String(stats.scale_ups).padStart(4)}  ${pct(stats.scale_ups)}`);
  console.log(`  Scale downs:           ${String(stats.scale_downs).padStart(4)}  ${pct(stats.scale_downs)}`);
  console.log(`  No change:             ${String(stats.no_changes).padStart(4)}  ${pct(stats.no_changes)}`);
  console.log(`  Executor calls sent:   ${stats.executor_calls}`);
  console.log(`  Executor errors:       ${stats.executor_errors}`);
  console.log(`  Validation checks:     ${stats.validation_checks}`);
  console.log(`  Validations passed:    ${stats.validated}`);
  console.log(`  Validation drifts:     ${stats.validation_drifts}`);
  console.log(`  Validation skipped:    ${stats.validation_skipped}`);
  console.log(`  Rollbacks triggered:   ${stats.rollbacks}`);
  console.log(`  Avg prediction latency: ${avg.toFixed(1)}ms`);
  console.log(`  Min/Max latency:       ${min.toFixed(1)}ms / ${max.toFixed(1)}ms`);
  console.log("=".repeat(76));
  console.log();
}

// ============================================================
// Utility
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// Public API
// ============================================================

const PredictionService = {
  /** Run a single on-demand prediction */
  runSinglePrediction,

  /** Process external 48x21 metric windows (dashboard synthetic load) */
  processMetricsWindow,

  /** Start the background prediction loop */
  startLoop: runControllerLoop,

  /** Request the loop to stop gracefully */
  stopLoop() {
    if (!running) return { status: "not_running" };
    stopRequested = true;
    return { status: "stop_requested" };
  },

  /** Check if the loop is currently running */
  isRunning() { return running; },

  /** Get current stats (or last session stats) */
  getStats() { return currentStats; },

  /** Get ML API URL for status display */
  getConfig() {
    return {
      ml_api_url: ML_API_URL,
      executor: EXECUTOR_URL,
      lookback_window: LOOKBACK,
      feature_count: FEATURE_COLS.length,
    };
  },
};

export default PredictionService;

