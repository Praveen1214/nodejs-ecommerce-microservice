import { getIO } from "./socket.js"

export function emitScalingEvent(result) {
  const io = getIO()

  const payload = {
    deployment: result.deployment,
    previous_replicas: result.previous_replicas,
    required_replicas: result.required_replicas,
    status: result.status,
    message: result.message || (result.rollback_reason && result.rollback_reason.length > 0 ? result.rollback_reason.join(", ") : ""),
    validationScore: result.validation?.score ?? null,
    promoted: result.production_promotion?.promoted ?? false,
    timestamp: new Date().toISOString(),
    rule: result.scale_action === 'scale_up' ? "Scale Up Triggered" : "Scale Down Triggered",
    severity: result.status === "ROLLED_BACK" ? "high" : "low",
    source: result.source || "manual",
    prediction_metadata: result.prediction_metadata || null,
  }

  if (result.status === "ROLLED_BACK") {
    io.emit("scaling:rolled_back", payload)
    console.log("🔴 scaling:rolled_back emitted")
  } else if (
    result.status === "SUCCESS_VALIDATED" ||
    result.status === "SUCCESS_NO_VALIDATION"
  ) {
    io.emit("scaling:scaled", payload)
    console.log("🟢 scaling:scaled emitted")
  }
}

/**
 * Emit a prediction event to the dashboard via Socket.IO.
 * Fired every time the ML controller produces a prediction,
 * regardless of whether it triggers scaling or not.
 */
export function emitPredictionEvent(predictionData) {
  try {
    const io = getIO()

    const payload = {
      step: predictionData.step,
      deployment: predictionData.deployment,
      current_pods: predictionData.current_pods,
      predicted_pods: predictionData.predicted_pods,
      scale_action: predictionData.scale_action,
      ml_latency_ms: predictionData.ml_latency_ms,
      window_end_utc: predictionData.window_end_utc,
      executor_status: predictionData.executor_status || null,
      dry_run: predictionData.dry_run || false,
      validation_status: predictionData.validation_status || null,
      timestamp: new Date().toISOString(),
    }

    io.emit("prediction:result", payload)
    console.log(`🤖 prediction:result emitted — ${payload.deployment} ${payload.scale_action} (${payload.current_pods}→${payload.predicted_pods})`)
  } catch (e) {
    // Socket may not be initialized; swallow
  }
}

export function emitSystemAlert(payload) {
  const io = getIO()

  const formattedPayload = {
    title: payload.title || "System Notification",
    message: payload.message || "",
    type: payload.type || "info",
    timestamp: new Date().toISOString()
  }

  io.emit("system:alert", formattedPayload)
  console.log(`🔵 system:alert emitted: ${formattedPayload.title}`)
}
