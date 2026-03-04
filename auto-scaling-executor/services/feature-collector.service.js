// auto-scaling-executor/services/feature-collector.service.js
// ============================================================
// FEATURE COLLECTOR — Automated Pipeline Connector
// ============================================================
//
// Supports TWO modes:
//
//   MODE 1 — "SSE" (default when SSE_URL is set and reachable):
//     Connects to a separate backend's SSE stream, receives one
//     21-column metric row per event (~1 per minute).
//
//   MODE 2 — "POLL" (fallback / simulation):
//     Fetches all simulation data from ML_SERVICE_URL/simulation-data,
//     then feeds rows one at a time on a configurable interval.
//     This is useful when no SSE backend is available (e.g., Azure
//     deployment without SSE endpoint).
//
// In BOTH modes:
//   1. Maintains a sliding window of 48 time-steps in memory
//   2. Once window is full, calls ML Prediction Service (/predict)
//   3. Forwards predictions to the Executor (/api/v1/scale-with-metrics)
//
// This is what makes the system FULLY AUTOMATED:
//   Metrics → Collector (window) → ML predicts →
//   Executor scales → Validates → Promote or Rollback
// ============================================================

import logger from "../utils/logger.js";
import {
  collectorWindowSize,
  collectorEventsTotal,
  collectorRunning,
  predictionsTotal,
  predictionLatencyMs,
  predictedPods,
  currentPods,
  scalingActionsTotal,
  resilienceScore,
  resilienceLatencyScore,
  resilienceErrorScore,
  resilienceTrafficScore,
  validationResultsTotal,
  rollbacksTotal,
  promotionsTotal,
  lastCpuPercent,
  lastMemPercent,
  lastErrorRate,
  lastP95Latency,
  scalingDurationMs,
  scalingPodDelta,
} from "./prometheus-metrics.service.js";

class FeatureCollector {
  constructor() {
    // SSE source — the separate backend that streams metric rows
    this.SSE_URL = process.env.SSE_URL || "http://localhost:8000/simulation-data-stream";

    this.ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://localhost:8000";
    this.EXECUTOR_URL = process.env.EXECUTOR_URL || "http://localhost:6000";
    this.K8S_NAMESPACE = process.env.K8S_NAMESPACE || "ecommerce-test";
    this.TARGET_SERVICE = process.env.TARGET_SERVICE || "order";
    this.TARGET_DEPLOYMENT = process.env.TARGET_DEPLOYMENT || "order";

    // Sliding window buffer: keeps last 48 data points (48 × 21 features)
    this.WINDOW_SIZE = 48;
    this.window = [];

    // Connection state
    this._controller = null; // AbortController for fetch-based SSE
    this._running = false;
    this._reconnectTimer = null;
    this._reconnectDelayMs = 5000; // Retry SSE connection after 5s on failure
    this._eventsReceived = 0;
    this._predictionsTriggered = 0;
    this._lastEventTime = null;

    // Polling mode state
    this._mode = "SSE"; // "SSE" or "POLL"
    this._pollTimer = null;
    this._pollData = []; // Cached simulation data rows
    this._pollIndex = 0; // Current row index in simulation data
    // Poll interval: how fast to feed rows (ms). Default 2s for demo speed.
    // Set POLL_INTERVAL_MS=60000 for real-time (1 row/min) simulation.
    this.POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);
  }

  // ============================================================
  // SSE Connection — Connects to the Separate Backend
  // ============================================================

  /**
   * Connect to the SSE stream and start consuming metric events.
   *
   * Expected SSE event format (one per minute):
   *   event: metrics
   *   data: {"timestamp":"2026-01-15T14:05:00Z","request_rate_rps":73.3,...,"current_pod_count":2}
   *
   * OR as a raw array (matching the model's 21-column order):
   *   event: metrics
   *   data: [73.3, 85.09, 111.69, ...]
   */
  async _connectSSE() {
    logger.info({
      event: "SSE_CONNECTING",
      url: this.SSE_URL,
    });

    try {
      this._controller = new AbortController();

      const response = await fetch(this.SSE_URL, {
        signal: this._controller.signal,
        headers: { "Accept": "text/event-stream" },
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: HTTP ${response.status}`);
      }

      logger.info({
        event: "SSE_CONNECTED",
        url: this.SSE_URL,
        status: response.status,
      });

      // Read the SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (this._running) {
        const { done, value } = await reader.read();

        if (done) {
          logger.warn({ event: "SSE_STREAM_ENDED" });
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const events = this._parseSSEBuffer(buffer);
        buffer = events.remaining;

        for (const evt of events.parsed) {
          await this._handleMetricEvent(evt);
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        logger.info({ event: "SSE_DISCONNECTED", reason: "Manual stop" });
        return;
      }

      logger.error({
        event: "SSE_CONNECTION_ERROR",
        error: err.message,
      });

      // If SSE fails, fall back to polling mode
      if (this._running) {
        logger.info({
          event: "SSE_FALLBACK_TO_POLL",
          message: "SSE endpoint not available — switching to POLL mode (fetches /simulation-data)",
        });
        this._mode = "POLL";
        await this._startPolling();
      }
    }
  }

  /**
   * Parse SSE text protocol from buffer.
   * Returns { parsed: [{event, data}], remaining: string }
   */
  _parseSSEBuffer(buffer) {
    const parsed = [];
    const blocks = buffer.split("\n\n");

    // Last block might be incomplete — keep it in remaining
    const remaining = blocks.pop() || "";

    for (const block of blocks) {
      if (!block.trim()) continue;

      let eventType = "message";
      let dataLines = [];

      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
        // Ignore comments (lines starting with :) and other fields
      }

      if (dataLines.length > 0) {
        parsed.push({
          event: eventType,
          data: dataLines.join("\n"),
        });
      }
    }

    return { parsed, remaining };
  }

  // ============================================================
  // Polling Mode — Fetch /simulation-data & Replay Rows
  // ============================================================

  /**
   * Fetch all simulation data from the ML service and replay
   * rows one at a time on a timer interval.
   */
  async _startPolling() {
    try {
      logger.info({
        event: "POLL_FETCHING_DATA",
        url: `${this.ML_SERVICE_URL}/simulation-data`,
      });

      const response = await fetch(`${this.ML_SERVICE_URL}/simulation-data`);
      if (!response.ok) {
        throw new Error(`Failed to fetch simulation data: HTTP ${response.status}`);
      }

      const json = await response.json();
      this._pollData = json.data || [];
      this._pollIndex = 0;

      logger.info({
        event: "POLL_DATA_LOADED",
        total_rows: this._pollData.length,
        interval_ms: this.POLL_INTERVAL_MS,
        estimated_first_prediction_ms: Math.min(this.WINDOW_SIZE, this._pollData.length) * this.POLL_INTERVAL_MS,
      });

      if (this._pollData.length === 0) {
        logger.error({ event: "POLL_NO_DATA", message: "Simulation data is empty" });
        return;
      }

      // Start feeding rows on a timer
      this._pollNextRow(); // Feed first row immediately
      this._pollTimer = setInterval(() => this._pollNextRow(), this.POLL_INTERVAL_MS);

    } catch (err) {
      logger.error({
        event: "POLL_FETCH_ERROR",
        error: err.message,
      });

      // Retry after delay
      if (this._running) {
        this._reconnectTimer = setTimeout(() => this._startPolling(), this._reconnectDelayMs);
      }
    }
  }

  /**
   * Feed the next simulation row into the pipeline
   */
  async _pollNextRow() {
    if (!this._running || this._pollIndex >= this._pollData.length) {
      if (this._pollIndex >= this._pollData.length) {
        logger.info({
          event: "POLL_DATA_EXHAUSTED",
          message: "All simulation rows consumed — restarting from beginning",
          total_processed: this._pollIndex,
        });
        this._pollIndex = 0; // Loop back to start
      }
      return;
    }

    const rowObj = this._pollData[this._pollIndex];
    this._pollIndex++;

    // Convert the named object to an SSE-like event for the shared handler
    await this._handleMetricEvent({
      event: "metrics",
      data: JSON.stringify(rowObj),
    });
  }

  // ============================================================
  // Event Handling — Process Each Metric Row (shared by SSE & POLL)
  // ============================================================

  /**
   * Handle a single metric event (one row of metrics).
   * Used by both SSE mode and POLL mode.
   */
  async _handleMetricEvent(evt) {
    try {
      const rawData = JSON.parse(evt.data);
      let row;

      if (Array.isArray(rawData)) {
        // Format 1: Raw array of 21 numbers in the exact column order
        row = rawData.map(Number);
      } else if (typeof rawData === "object") {
        // Format 2: Named object — convert to the 21-column array
        row = this._objectToRow(rawData);
      } else {
        logger.warn({ event: "INVALID_DATA", data: evt.data.substring(0, 100) });
        return;
      }

      // Validate row has exactly 21 columns
      if (row.length !== 21) {
        logger.warn({
          event: "WRONG_COLUMNS",
          expected: 21,
          got: row.length,
        });
        return;
      }

      this._eventsReceived++;
      this._lastEventTime = new Date().toISOString();

      // --- Prometheus: track event received ---
      collectorEventsTotal.inc({ mode: this._mode });

      // Add to sliding window
      this.window.push(row);
      if (this.window.length > this.WINDOW_SIZE) {
        this.window.shift(); // Remove oldest to maintain window size
      }

      // --- Prometheus: update window gauge ---
      collectorWindowSize.set(this.window.length);

      logger.info({
        event: "WINDOW_STATUS",
        size: this.window.length,
        required: this.WINDOW_SIZE,
        rps: row[0]?.toFixed(1),
        pods: row[20],
        events_total: this._eventsReceived,
        mode: this._mode,
      });

      // Only predict once we have a full 48-row window
      if (this.window.length < this.WINDOW_SIZE) {
        logger.info({
          event: "WINDOW_FILLING",
          message: `Need ${this.WINDOW_SIZE - this.window.length} more events before first prediction`,
        });
        return;
      }

      // Full window → trigger prediction + scaling pipeline
      await this._predictAndScale();

    } catch (err) {
      logger.error({
        event: "EVENT_PROCESSING_ERROR",
        error: err.message,
        data: evt.data?.substring(0, 200),
      });
    }
  }

  /**
   * Convert a named metric object to the 21-column array.
   * Column order MUST match the ML model's FEATURE_COLS + current_pod_count.
   */
  _objectToRow(obj) {
    return [
      Number(obj.request_rate_rps ?? 0),           // 1
      Number(obj.latency_p95_ms ?? 0),             // 2
      Number(obj.latency_p99_ms ?? 0),             // 3
      Number(obj.error_rate_percent ?? 0),         // 4
      Number(obj.queue_length ?? 0),               // 5
      Number(obj.pod_cpu_usage_percent_avg ?? 0),  // 6
      Number(obj.pod_cpu_usage_percent_p95 ?? 0),  // 7
      Number(obj.pod_memory_usage_mb_avg ?? 0),    // 8
      Number(obj.pod_memory_usage_mb_p95 ?? 0),    // 9
      Number(obj.hour_sin ?? 0),                   // 10
      Number(obj.hour_cos ?? 0),                   // 11
      Number(obj.day_sin ?? 0),                    // 12
      Number(obj.day_cos ?? 0),                    // 13
      Number(obj.mesh_inbound_rps ?? 0),           // 14
      Number(obj.mesh_inbound_latency_p95 ?? 0),   // 15
      Number(obj.mesh_inbound_error_rate ?? 0),    // 16
      Number(obj.degree_centrality ?? 0),          // 17
      Number(obj.eigenvector_centrality ?? 0),     // 18
      Number(obj.betweenness_centrality ?? 0),     // 19
      Number(obj.closeness_centrality ?? 0),       // 20
      Number(obj.current_pod_count ?? 0),          // 21
    ];
  }

  // ============================================================
  // ML Prediction + Executor Pipeline
  // ============================================================

  /**
   * Send the 48×21 window to the ML service, then forward prediction to executor
   */
  async _predictAndScale() {
    try {
      // 1. Call ML Prediction Service
      const windowEndUtc = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

      const predictionBody = {
        window_data: this.window,
        window_end_utc: windowEndUtc,
        service_id: this.TARGET_SERVICE,
        input_source: this._mode === "POLL" ? "simulation-poll-collector" : "sse-feature-collector",
      };

      logger.info({ event: "CALLING_ML_SERVICE", url: this.ML_SERVICE_URL });

      const mlStartTime = Date.now();
      const mlResponse = await fetch(`${this.ML_SERVICE_URL}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(predictionBody),
      });

      if (!mlResponse.ok) {
        const text = await mlResponse.text();
        throw new Error(`ML Service error ${mlResponse.status}: ${text}`);
      }

      const prediction = await mlResponse.json();
      this._predictionsTriggered++;

      // --- Prometheus: record prediction metrics ---
      const mlDuration = Date.now() - mlStartTime;
      predictionLatencyMs.observe(mlDuration);
      predictionsTotal.inc({ status: "success" });
      predictedPods.set({ deployment: this.TARGET_DEPLOYMENT }, prediction.predicted_pods ?? 0);
      currentPods.set({ deployment: this.TARGET_DEPLOYMENT }, prediction.current_pods ?? 0);

      logger.info({
        event: "ML_PREDICTION_RECEIVED",
        current_pods: prediction.current_pods,
        predicted_pods: prediction.predicted_pods,
        scale_action: prediction.scale_action,
        predict_for: prediction.predict_timestamp,
        latency_ms: prediction.latency_ms,
        predictions_total: this._predictionsTriggered,
      });

      // 2. If no change needed, skip executor
      if (prediction.scale_action === "no_change") {
        logger.info({ event: "NO_SCALING_NEEDED", pods: prediction.current_pods });
        return;
      }

      // 3. Forward to Executor for scaling + validation
      await this._sendToExecutor(prediction);

    } catch (err) {
      // --- Prometheus: record prediction failure ---
      predictionsTotal.inc({ status: "error" });

      logger.error({
        event: "PREDICT_AND_SCALE_ERROR",
        error: err.message,
        stack: err.stack,
      });
    }
  }

  /**
   * Forward prediction to the Auto-Scaling Executor
   */
  async _sendToExecutor(prediction) {
    const { predicted_pods, current_pods, scale_action } = prediction;
    const latestRow = this.window[this.window.length - 1];

    // Build metrics payload for executor's validation layer
    const metricsPayload = {
      success_rate: Math.max(0, 100 - (latestRow[3] || 0)), // 100 - error_rate_percent
      error_rate: latestRow[3] || 0,                          // error_rate_percent
      latency_p95: latestRow[1] || 60,                        // latency_p95_ms
      cpu_usage: latestRow[5] || 25,                           // pod_cpu_usage_percent_avg
      memory_usage: latestRow[7] || 550,                       // pod_memory_usage_mb_avg
      restarts: 0,
      rps: latestRow[0] || 50,                                 // request_rate_rps
      traffic_recovery_rate: 95,
    };

    const podDelta = Math.abs(predicted_pods - current_pods);

    const body = {
      deployment: this.TARGET_DEPLOYMENT,
      request_pods: podDelta,
      scale_action: scale_action,
      metrics: metricsPayload,
    };

    // --- Prometheus: record scaling attempt ---
    scalingPodDelta.set({ deployment: this.TARGET_DEPLOYMENT }, scale_action === "scale_down" ? -podDelta : podDelta);
    const scalingStartTime = Date.now();

    logger.info({
      event: "EXECUTOR_REQUEST",
      deployment: this.TARGET_DEPLOYMENT,
      scale_action,
      current_pods,
      predicted_pods,
      pod_delta: podDelta,
    });

    const response = await fetch(`${this.EXECUTOR_URL}/api/v1/scale-with-metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Executor error ${response.status}: ${text}`);
    }

    const result = await response.json();

    // --- Prometheus: record executor result metrics ---
    const scalingDuration = Date.now() - scalingStartTime;
    scalingDurationMs.observe({ deployment: this.TARGET_DEPLOYMENT }, scalingDuration);

    // Parse result from the executor (results array format)
    const executorResult = result.results?.[0] || result;
    const dep = this.TARGET_DEPLOYMENT;
    const action = scale_action;

    if (executorResult.status === "SUCCESS_VALIDATED" || executorResult.status === "SUCCESS_VALIDATED_LOCAL") {
      scalingActionsTotal.inc({ deployment: dep, action, status: "success" });
      promotionsTotal.inc({ deployment: dep });
      validationResultsTotal.inc({ deployment: dep, result: "passed" });
    } else if (executorResult.status === "ROLLED_BACK") {
      scalingActionsTotal.inc({ deployment: dep, action, status: "rolled_back" });
      rollbacksTotal.inc({ deployment: dep });
      validationResultsTotal.inc({ deployment: dep, result: "failed" });
    } else if (executorResult.status === "SUCCESS_NO_VALIDATION") {
      scalingActionsTotal.inc({ deployment: dep, action, status: "success" });
      validationResultsTotal.inc({ deployment: dep, result: "skipped" });
    } else if (executorResult.status === "SUCCESS_VALIDATION_FAILED_LOCAL") {
      scalingActionsTotal.inc({ deployment: dep, action, status: "failed" });
      validationResultsTotal.inc({ deployment: dep, result: "failed" });
    } else {
      scalingActionsTotal.inc({ deployment: dep, action, status: "failed" });
    }

    // Record validation sub-scores if present
    const v = executorResult.validation;
    if (v && typeof v.score === "number") {
      resilienceScore.set({ deployment: dep }, v.score);
      if (typeof v.latencyScore === "number") resilienceLatencyScore.set({ deployment: dep }, v.latencyScore);
      if (typeof v.errorScore === "number") resilienceErrorScore.set({ deployment: dep }, v.errorScore);
      if (typeof v.trafficScore === "number") resilienceTrafficScore.set({ deployment: dep }, v.trafficScore);
    }

    // Record raw system health values from the metrics payload we sent
    lastCpuPercent.set({ deployment: dep }, metricsPayload.cpu_usage ?? 0);
    lastMemPercent.set({ deployment: dep }, metricsPayload.memory_usage ?? 0);
    lastErrorRate.set({ deployment: dep }, metricsPayload.error_rate ?? 0);
    lastP95Latency.set({ deployment: dep }, metricsPayload.latency_p95 ?? 0);

    logger.info({
      event: "EXECUTOR_RESULT",
      status: executorResult.status,
      deployment: executorResult.deployment,
      validated: executorResult.validation?.passed,
      rolledBack: executorResult.validation?.rolledBack,
    });

    return result;
  }

  // ============================================================
  // Lifecycle — Start / Stop / Status
  // ============================================================

  /**
   * Start the collection pipeline.
   * Tries SSE first; if SSE endpoint returns 404, falls back to POLL mode.
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._mode = "SSE"; // Start with SSE, will fallback to POLL if needed

    // --- Prometheus: mark collector as running ---
    collectorRunning.set(1);

    logger.info({
      event: "FEATURE_COLLECTOR_STARTED",
      mode: "SSE (with POLL fallback)",
      sse_url: this.SSE_URL,
      ml_service: this.ML_SERVICE_URL,
      executor: this.EXECUTOR_URL,
      namespace: this.K8S_NAMESPACE,
      service: this.TARGET_SERVICE,
      poll_interval_ms: this.POLL_INTERVAL_MS,
    });

    this._connectSSE();
  }

  /**
   * Stop the collection pipeline (both SSE and POLL)
   */
  stop() {
    this._running = false;

    // Abort the SSE fetch connection
    if (this._controller) {
      this._controller.abort();
      this._controller = null;
    }

    // Clear reconnect timer
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    // Clear poll timer
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }

    // --- Prometheus: mark collector as stopped ---
    collectorRunning.set(0);

    logger.info({ event: "FEATURE_COLLECTOR_STOPPED" });
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      running: this._running,
      mode: this._mode,
      window_size: this.window.length,
      window_required: this.WINDOW_SIZE,
      ready: this.window.length >= this.WINDOW_SIZE,
      events_received: this._eventsReceived,
      predictions_triggered: this._predictionsTriggered,
      last_event_time: this._lastEventTime,
      poll_info: this._mode === "POLL" ? {
        total_rows: this._pollData.length,
        current_index: this._pollIndex,
        interval_ms: this.POLL_INTERVAL_MS,
      } : null,
      config: {
        sse_url: this.SSE_URL,
        ml_service_url: this.ML_SERVICE_URL,
        executor_url: this.EXECUTOR_URL,
        namespace: this.K8S_NAMESPACE,
        target_service: this.TARGET_SERVICE,
        target_deployment: this.TARGET_DEPLOYMENT,
      },
    };
  }

  /**
   * Manually inject a metric row (for testing without SSE/POLL)
   */
  async injectRow(row) {
    await this._handleMetricEvent({
      event: "metrics",
      data: JSON.stringify(row),
    });
  }
}

export default new FeatureCollector();
