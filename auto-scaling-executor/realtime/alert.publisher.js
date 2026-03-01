import { getIO } from "./socket.js"

export function emitScalingEvent(result) {
  const io = getIO()

  const payload = {
    deployment: result.deployment,
    previous_replicas: result.previous_replicas,
    required_replicas: result.required_replicas,
    status: result.status,
    validationScore: result.validation?.score ?? null,
    promoted: result.production_promotion?.promoted ?? false,
    timestamp: new Date().toISOString(),
  }

  if (result.status === "ROLLED_BACK") {
    io.emit("scaling:rolled_back", payload)
    console.log("🔴 scaling:rolled_back emitted")
  }

  if (
    result.status === "SUCCESS_VALIDATED" ||
    result.status === "SUCCESS_NO_VALIDATION"
  ) {
    io.emit("scaling:scaled", payload)
    console.log("🟢 scaling:scaled emitted")
  }
}
