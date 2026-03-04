import express from "express";
import ChaosExperiment from "../models/chaos-experiment.model.js";
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
 * POST /api/v1/chaos/experiment-result
 * Receives chaos experiment results and stores them in MongoDB.
 */
router.post("/chaos/experiment-result", async (req, res) => {
    try {
        const {
            service,
            faultType,
            latencyBefore,
            latencyDuring,
            latencyAfter,
            errorRateDuring,
            recoveryTimeSeconds,
            resilienceScore,
            result,
            namespace,
            durationSeconds,
            availabilityDuringChaos,
            startTime,
            endTime
        } = req.body;

        const experimentId = `exp_${Date.now()}`;

        const newExperiment = new ChaosExperiment({
            experimentId,
            service,
            namespace: namespace || "ecommerce-test",
            faultType,
            startTime,
            endTime,
            durationSeconds,
            latencyBefore,
            latencyDuring,
            latencyAfter,
            errorRateDuring,
            recoveryTimeSeconds,
            availabilityDuringChaos,
            resilienceScore,
            result,
            createdAt: new Date()
        });

        const savedExperiment = await newExperiment.save();

        // Emit event for SSE
        eventEmitter.emit("chaos:result", savedExperiment);

        res.status(201).json({
            message: "Chaos experiment result stored successfully",
            experimentId: savedExperiment.experimentId
        });
    } catch (error) {
        console.error("❌ Error storing chaos result:", error.message);
        res.status(500).json({ error: "Failed to store chaos experiment result" });
    }
});

/**
 * GET /api/v1/events/chaos
 * SSE endpoint for real-time chaos experiment updates.
 */
router.get("/events/chaos", async (req, res) => {
    setupSSE(res);
    console.log("🔌 SSE Client connected to /api/v1/events/chaos");

    // Send historical results (last 10)
    try {
        const historicalResults = await ChaosExperiment.find()
            .sort({ createdAt: -1 })
            .limit(10);

        historicalResults.reverse().forEach(exp => {
            res.write(`data: ${JSON.stringify(exp)}\n\n`);
        });
    } catch (err) {
        console.error("❌ Error fetching historical chaos results:", err.message);
    }

    const onChaosResult = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    eventEmitter.on("chaos:result", onChaosResult);

    req.on("close", () => {
        console.log("🔌 SSE Client disconnected from /api/v1/events/chaos");
        eventEmitter.removeListener("chaos:result", onChaosResult);
        res.end();
    });
});

export default router;
