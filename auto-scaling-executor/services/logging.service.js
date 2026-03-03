import ScalingLog from "../models/scaling-log.model.js";
import eventEmitter from "../utils/events.js";

class LoggingService {
    async logScalingResult(result) {
        try {
            // Only store scale_up or scale_down actions
            if (result.scale_action !== "scale_up" && result.scale_action !== "scale_down") {
                return;
            }

            const logEntry = new ScalingLog(result);
            const savedLog = await logEntry.save();

            // Emit event for real-time updates (SSE)
            eventEmitter.emit("scaling:logged", savedLog);

            console.log(`✅ Scaling result stored in MongoDB for deployment: ${result.deployment} (${result.status})`);
        } catch (error) {
            console.error("❌ Failed to store scaling result in MongoDB:", error.message);
        }
    }
}

export default new LoggingService();
