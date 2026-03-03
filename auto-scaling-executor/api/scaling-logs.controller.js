import express from "express";
import ScalingLog from "../models/scaling-log.model.js";
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

/**
 * GET /api/v1/scaling-events/stream
 * Streams only basic scaling event information.
 */
router.get("/scaling-events/stream", async (req, res) => {
    setupSSE(res);
    console.log("🔌 SSE Client connected to /scaling-events/stream");

    try {
        const recentLogs = await ScalingLog.find()
            .select("deployment scale_action status previous_replicas required_replicas timestamp")
            .sort({ timestamp: -1 })
            .limit(10);

        recentLogs.reverse().forEach(log => {
            res.write(`data: ${JSON.stringify(log)}\n\n`);
        });
    } catch (err) {
        console.error("❌ Error fetching scaling events:", err.message);
    }

    const onScalingLogged = (savedLog) => {
        const payload = {
            _id: savedLog._id,
            deployment: savedLog.deployment,
            scale_action: savedLog.scale_action,
            status: savedLog.status,
            previous_replicas: savedLog.previous_replicas,
            required_replicas: savedLog.required_replicas,
            timestamp: savedLog.timestamp
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    eventEmitter.on("scaling:logged", onScalingLogged);
    req.on("close", () => {
        eventEmitter.removeListener("scaling:logged", onScalingLogged);
        res.end();
    });
});

/**
 * GET /api/v1/resilience-metrics/stream
 * Streams validation and resilience metrics.
 */
router.get("/resilience-metrics/stream", async (req, res) => {
    setupSSE(res);
    console.log("🔌 SSE Client connected to /resilience-metrics/stream");

    try {
        const recentLogs = await ScalingLog.find({ "validation.metricsEvaluation": { $exists: true, $ne: [] } })
            .select("deployment validation timestamp")
            .sort({ timestamp: -1 })
            .limit(10);

        recentLogs.reverse().forEach(log => {
            res.write(`data: ${JSON.stringify(log)}\n\n`);
        });
    } catch (err) {
        console.error("❌ Error fetching resilience metrics:", err.message);
    }

    const onScalingLogged = (savedLog) => {
        if (savedLog.validation && savedLog.validation.metricsEvaluation) {
            const payload = {
                _id: savedLog._id,
                deployment: savedLog.deployment,
                validation: savedLog.validation,
                timestamp: savedLog.timestamp
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
    };

    eventEmitter.on("scaling:logged", onScalingLogged);
    req.on("close", () => {
        eventEmitter.removeListener("scaling:logged", onScalingLogged);
        res.end();
    });
});

export default router;
