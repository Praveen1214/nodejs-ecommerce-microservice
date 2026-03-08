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
    const isSuccess = log.status === "SUCCESS_VALIDATED" || log.status === "SUCCESS";
    const isPromoted = log.production_promotion?.promoted;

    // Extract metrics for "Criteria" display
    const evaluations = log.validation?.metricsEvaluation || [];
    const mainMetric = evaluations[0];

    // Construct a more descriptive rule based on criteria (metrics)
    let ruleDescription = isScaleUp ? "Scale Up Triggered" : "Scale Down Triggered";
    if (evaluations.length > 0) {
        const criteria = evaluations.map(e => `${e.metric} (${e.tier})`).join(", ");
        ruleDescription = `Threshold reached: ${criteria}`;
    }

    // Build detailed rollback information
    let rollbackDetails = null;
    if (isRollback) {
        rollbackDetails = {
            action: "ROLLBACK_EXECUTED",
            reason: log.validation?.reasons?.join(", ") || log.rollback_reason?.join(", ") || "Validation failed",
            previousReplicas: log.previous_replicas,
            attemptedReplicas: log.previous_replicas + (log.attempted_additional_replicas || 0),
            rolledBackTo: log.required_replicas,
            resilienceScore: log.validation?.score,
            chaosTestFailed: log.validation?.chaos?.injected && !log.validation?.chaos?.postChaosPassed,
            timestamp: log.timestamp
        };
    }

    // Build detailed success/promotion information
    let promotionDetails = null;
    if (isPromoted) {
        promotionDetails = {
            promoted: true,
            environment: log.production_promotion.namespace,
            previousReplicas: log.production_promotion.previous_replicas,
            newReplicas: log.production_promotion.replicas,
            reason: log.production_promotion.reason || "Auto-promoted after validation"
        };
    }

    // Create comprehensive description
    let description = "";
    if (isRollback) {
        description = `⚠️ ROLLBACK: ${log.deployment} scaling failed. Rolled back from ${rollbackDetails.attemptedReplicas} to ${rollbackDetails.rolledBackTo} replicas. Reason: ${rollbackDetails.reason}`;
        if (rollbackDetails.chaosTestFailed) {
            description += " | Chaos test failed - system did not meet resilience threshold";
        }
    } else if (isSuccess) {
        description = `✅ SUCCESS: ${log.deployment} scaled from ${log.previous_replicas} to ${log.required_replicas} replicas`;
        if (log.validation?.score !== undefined) {
            description += ` | Resilience Score: ${log.validation.score.toFixed(2)}`;
        }
        if (log.validation?.chaos?.injected) {
            description += ` | Chaos Test: ${log.validation.chaos.postChaosPassed ? "PASSED" : "N/A"}`;
        }
        if (isPromoted) {
            description += ` | 🚀 Auto-promoted to ${promotionDetails.environment}`;
        }
    } else {
        description = log.message || "Scaling event recorded";
    }

    // Determine alert severity
    let severity = "info";
    if (isRollback) {
        severity = "critical";
    } else if (isScaleUp && log.required_replicas > 50) {
        severity = "high";
    } else if (isScaleUp) {
        severity = "medium";
    }

    return {
        _id: log._id,
        project: log.deployment.includes('product') ? "Online Bookstore" :
            (log.deployment.includes('order') ? "Hotel Management" : "Hospital Management"),
        service: log.deployment,
        severity: severity,
        status: log.status,
        rule: ruleDescription,
        metric: mainMetric?.metric || "Replicas",
        currentValue: mainMetric ? mainMetric.value : log.required_replicas,
        threshold: mainMetric ? mainMetric.rangeUsed : `${log.previous_replicas} refs`,
        triggeredAt: log.timestamp,
        lastSeen: log.timestamp,
        source: "Autoscaler",
        environment: isPromoted ? "prod" : "test",
        node: "k8s-cluster",
        action: isRollback ? "ROLLBACK" : (isSuccess ? "SCALED" : log.status),
        description: description,
        
        // Detailed monitoring information
        details: {
            scaleAction: log.scale_action,
            previousReplicas: log.previous_replicas,
            currentReplicas: log.required_replicas,
            requestedPods: log.request_pods,
            additionalReplicas: log.additional_replicas,
            attemptedReplicas: log.attempted_additional_replicas
        },
        
        // Rollback specific details (if applicable)
        rollback: rollbackDetails,
        
        // Production promotion details (if applicable)
        promotion: promotionDetails,
        
        // Validation metrics
        validation: log.validation ? {
            score: log.validation.score,
            passed: log.validation.passed,
            rolledBack: log.validation.rolledBack,
            threshold: log.validation.threshold,
            latencyScore: log.validation.latencyScore,
            errorScore: log.validation.errorScore,
            trafficScore: log.validation.trafficScore,
            reasons: log.validation.reasons,
            chaos: log.validation.chaos,
            metricsEvaluation: log.validation.metricsEvaluation
        } : null
    };
}

/**
 * GET /api/v1/alerts/stream
 * Streams ROLLBACK-ONLY logs and live updates for monitoring dashboard.
 * Only returns logs where status = "ROLLED_BACK"
 */
router.get("/alerts/stream", async (req, res) => {
    setupSSE(res);
    console.log("🔌 SSE Client connected to /alerts/stream (ROLLBACK ONLY)");

    try {
        // Fetch only rollback logs
        const rollbackLogs = await ScalingLog.find({ status: "ROLLED_BACK" })
            .sort({ timestamp: -1 })
            .limit(50);

        console.log(`📊 Sending ${rollbackLogs.length} rollback alerts`);

        rollbackLogs.reverse().forEach(log => {
            res.write(`data: ${JSON.stringify(mapLogToAlert(log))}\n\n`);
        });
    } catch (err) {
        console.error("❌ Error fetching rollback alerts:", err.message);
    }

    // Only emit rollback events in real-time
    const onScalingLogged = (savedLog) => {
        if (savedLog.status === "ROLLED_BACK") {
            console.log(`🚨 Broadcasting rollback alert: ${savedLog.deployment}`);
            res.write(`data: ${JSON.stringify(mapLogToAlert(savedLog))}\n\n`);
        }
    };

    eventEmitter.on("scaling:logged", onScalingLogged);

    req.on("close", () => {
        console.log("🔌 SSE Client disconnected from /alerts/stream");
        eventEmitter.removeListener("scaling:logged", onScalingLogged);
        res.end();
    });
});

export default router;
