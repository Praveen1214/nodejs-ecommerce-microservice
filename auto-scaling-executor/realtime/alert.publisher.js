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
    severity: result.status === "ROLLED_BACK" ? "high" : "low"
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
