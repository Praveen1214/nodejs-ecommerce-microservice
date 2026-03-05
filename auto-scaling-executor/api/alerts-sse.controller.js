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
 * Helper to map ScalingLog to Frontend Alert format
 */
function mapLogToAlert(log) {
    const isRollback = log.status === "ROLLED_BACK";
    const isScaleUp = log.scale_action === "scale_up";

    // Extract metrics for "Criteria" display
    const evaluations = log.validation?.metricsEvaluation || [];
    const mainMetric = evaluations[0];

    // Construct a more descriptive rule based on criteria (metrics)
    let ruleDescription = isScaleUp ? "Scale Up Triggered" : "Scale Down Triggered";
    if (evaluations.length > 0) {
        const criteria = evaluations.map(e => `${e.metric} (${e.tier})`).join(", ");
        ruleDescription = `Threshold reached: ${criteria}`;
    }

    return {
        _id: log._id,
        project: log.deployment.includes('product') ? "Online Bookstore" :
            (log.deployment.includes('order') ? "Hotel Management" : "Hospital Management"),
        service: log.deployment,
        severity: isRollback ? "critical" : (isScaleUp ? "high" : "medium"),
        // Do NOT map to 'resolved' immediately so they stay in 'Active' tab
        status: log.status,
        rule: ruleDescription,
        metric: mainMetric?.metric || "Replicas",
        currentValue: mainMetric ? mainMetric.value : log.required_replicas,
        threshold: mainMetric ? mainMetric.rangeUsed : `${log.previous_replicas} refs`,
        triggeredAt: log.timestamp,
        lastSeen: log.timestamp,
        source: "Autoscaler",
        environment: "prod",
        node: "k8s-cluster",
        action: log.status,
        description: `${log.message || "Scaling executed successfully"}${log.validation?.score !== undefined ? ` (Resilience Score: ${log.validation.score.toFixed(2)})` : ""}${log.validation?.reasons?.length > 0 ? ` - ${log.validation.reasons.join(', ')}` : ""}`,
        validation: log.validation
    };
}

/**
 * GET /api/v1/alerts/stream
 * Streams historical scaling logs and live updates in a format suitable for the Alerts UI.
 */
router.get("/alerts/stream", async (req, res) => {
    setupSSE(res);
    console.log("🔌 SSE Client connected to /alerts/stream");

    try {
        const recentLogs = await ScalingLog.find()
            .sort({ timestamp: -1 })
            .limit(20);

        recentLogs.reverse().forEach(log => {
            res.write(`data: ${JSON.stringify(mapLogToAlert(log))}\n\n`);
        });
    } catch (err) {
        console.error("❌ Error fetching historical alerts:", err.message);
    }

    const onScalingLogged = (savedLog) => {
        res.write(`data: ${JSON.stringify(mapLogToAlert(savedLog))}\n\n`);
    };

    eventEmitter.on("scaling:logged", onScalingLogged);

    req.on("close", () => {
        console.log("🔌 SSE Client disconnected from /alerts/stream");
        eventEmitter.removeListener("scaling:logged", onScalingLogged);
        res.end();
    });
});

export default router;
