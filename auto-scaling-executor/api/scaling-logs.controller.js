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
 * Query params:
 *   - all=true: Get all records
 *   - page=1&limit=10: Use pagination (default: page=1, limit=50)
 */
router.get("/scaling-events/stream", async (req, res) => {
    setupSSE(res);
    console.log("🔌 SSE Client connected to /scaling-events/stream");

    try {
        const { all, page = 1, limit = 50 } = req.query;
        
        let query = ScalingLog.find()
            .select("deployment scale_action status previous_replicas required_replicas timestamp")
            .sort({ timestamp: -1 });

        // If all=true, don't apply pagination
        if (all !== "true") {
            const skip = (parseInt(page) - 1) * parseInt(limit);
            query = query.skip(skip).limit(parseInt(limit));
        }

        const recentLogs = await query;

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
 * Query params:
 *   - all=true: Get all records
 *   - page=1&limit=10: Use pagination (default: page=1, limit=50)
 */
router.get("/resilience-metrics/stream", async (req, res) => {
    setupSSE(res);
    console.log("🔌 SSE Client connected to /resilience-metrics/stream");

    try {
        const { all, page = 1, limit = 50 } = req.query;
        
        let query = ScalingLog.find({ "validation.metricsEvaluation": { $exists: true, $ne: [] } })
            .select("deployment validation timestamp")
            .sort({ timestamp: -1 });

        // If all=true, don't apply pagination
        if (all !== "true") {
            const skip = (parseInt(page) - 1) * parseInt(limit);
            query = query.skip(skip).limit(parseInt(limit));
        }

        const recentLogs = await query;

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
                timestamp: savedLog.timestamp,
                type: "SCALING_LOG"
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
    };

    const onHealthResult = (healthData) => {
        if (healthData.projects) {
            healthData.projects.forEach(project => {
                project.services.forEach(service => {
                    const payload = {
                        _id: `live-${project.name}-${service.serviceName}-${Date.now()}`,
                        project: project.name,
                        deployment: service.serviceName.replace(" Service", ""),
                        validation: {
                            metricsEvaluation: service.metrics.map(m => {
                                let key = m.label.toLowerCase();
                                if (key.includes("memory")) key = "memPercent";
                                else if (key.includes("cpu")) key = "cpuPercent";
                                else if (key.includes("success")) key = "successRate";
                                else if (key.includes("error")) key = "errorRate";
                                else if (key.includes("latency")) key = "p95LatencyAfter";
                                else if (key.includes("pod health")) key = "successRate"; // Map health to success for display

                                return {
                                    metric: key,
                                    label: m.label,
                                    value: parseFloat(m.value),
                                    unit: m.unit,
                                    icon: m.icon,
                                    tier: m.status.toUpperCase(),
                                    status: m.status,
                                    history: m.history || [parseFloat(m.value)]
                                };
                            })
                        },
                        timestamp: healthData.createdAt || new Date(),
                        type: "LIVE_STATUS"
                    };
                    res.write(`data: ${JSON.stringify(payload)}\n\n`);
                });
            });
        }
    };

    eventEmitter.on("scaling:logged", onScalingLogged);
    eventEmitter.on("health:result", onHealthResult);

    req.on("close", () => {
        eventEmitter.removeListener("scaling:logged", onScalingLogged);
        eventEmitter.removeListener("health:result", onHealthResult);
        res.end();
    });
});

/**
 * GET /api/v1/deployment-status/stream
 * Streams live status (replicas, CPU, Mem) for all deployments.
 */
router.get("/deployment-status/stream", async (req, res) => {
    setupSSE(res);
    console.log("🔌 SSE Client connected to /deployment-status/stream");

    try {
        // Initial state: Get latest status for each unique deployment
        const latestStatuses = await ScalingLog.aggregate([
            { $sort: { timestamp: -1 } },
            {
                $group: {
                    _id: "$deployment",
                    latest: { $first: "$$ROOT" }
                }
            }
        ]);

        latestStatuses.forEach(item => {
            res.write(`data: ${JSON.stringify(item.latest)}\n\n`);
        });
    } catch (err) {
        console.error("❌ Error fetching deployment statuses:", err.message);
    }

    const onScalingLogged = (savedLog) => {
        // Broadcast every scaling event as a status update
        res.write(`data: ${JSON.stringify(savedLog)}\n\n`);
    };

    eventEmitter.on("scaling:logged", onScalingLogged);
    req.on("close", () => {
        eventEmitter.removeListener("scaling:logged", onScalingLogged);
        res.end();
    });
});

export default router;
