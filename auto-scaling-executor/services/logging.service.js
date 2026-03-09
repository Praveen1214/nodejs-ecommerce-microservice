import ScalingLog from "../models/scaling-log.model.js";
import eventEmitter from "../utils/events.js";
import logger from "../utils/logger.js";

class LoggingService {
    #ALLOWED_ACTIONS = new Set(["scale_up", "scale_down", "no_change"]);

    #safeNumber(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    async logScalingResult(result) {
        try {
            if (!result || !this.#ALLOWED_ACTIONS.has(result.scale_action)) {
                return;
            }

            const payload = {
                ...result,
                request_pods: this.#safeNumber(result.request_pods, 0),
                previous_replicas: this.#safeNumber(result.previous_replicas, 0),
                attempted_additional_replicas: this.#safeNumber(result.attempted_additional_replicas, 0),
                additional_replicas: this.#safeNumber(result.additional_replicas, 0),
                required_replicas: this.#safeNumber(result.required_replicas, 0),
                source: result.source || "manual",
            };

            const logEntry = new ScalingLog(payload);
            const savedLog = await logEntry.save();

            eventEmitter.emit("scaling:logged", savedLog);

            logger.info({
                event: "SCALING_RESULT_STORED",
                deployment: payload.deployment,
                status: payload.status,
                scale_action: payload.scale_action,
                source: payload.source,
            });
        } catch (error) {
            logger.error({
                event: "SCALING_RESULT_STORE_FAILED",
                error: error.message,
                deployment: result?.deployment,
                scale_action: result?.scale_action,
            });
        }
    }

    async logPipelineEvent({ serviceId, event, status = "INFO", message = "", details = {}, source = "synthetic_window", timestamp = new Date() }) {
        try {
            if (!event) return;

            const payload = {
                deployment: (serviceId || "unknown").toLowerCase(),
                request_pods: 0,
                scale_action: "no_change",
                previous_replicas: 0,
                attempted_additional_replicas: 0,
                additional_replicas: 0,
                required_replicas: 0,
                status,
                message: message || event,
                source,
                pipeline_event: event,
                pipeline_details: details,
                timestamp,
            };

            const logEntry = new ScalingLog(payload);
            const savedLog = await logEntry.save();
            eventEmitter.emit("scaling:logged", savedLog);

            logger.info({
                event,
                service_id: serviceId,
                status,
                source,
                details,
            });
        } catch (error) {
            logger.error({
                event: "PIPELINE_EVENT_STORE_FAILED",
                pipeline_event: event,
                service_id: serviceId,
                error: error.message,
            });
        }
    }
}

export default new LoggingService();
