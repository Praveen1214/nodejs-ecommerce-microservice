import express from "express";
import DeploymentHealth from "../models/deployment-health.model.js";
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
 * POST /api/v1/deployment-health/report
 * Receives and stores deployment health metrics.
 */
router.post("/deployment-health/report", async (req, res) => {
    try {
        const healthData = req.body;

        const newHealth = new DeploymentHealth({
            ...healthData,
            createdAt: new Date()
        });

        const savedHealth = await newHealth.save();

        // Emit event for SSE
        eventEmitter.emit("health:result", savedHealth);

        res.status(201).json({
            message: "Deployment health report stored successfully",
            id: savedHealth._id
        });
    } catch (error) {
        console.error("❌ Error storing deployment health report:", error.message);
        res.status(500).json({ error: "Failed to store deployment health report" });
    }
});

/**
 * GET /api/v1/events/deployment-health
 * SSE endpoint for real-time deployment health updates.
 */
router.get("/events/deployment-health", async (req, res) => {
    setupSSE(res);
    console.log("🔌 SSE Client connected to /api/v1/events/deployment-health");

    // Send latest historical result
    try {
        const lastResult = await DeploymentHealth.findOne()
            .sort({ createdAt: -1 });

        if (lastResult) {
            res.write(`data: ${JSON.stringify(lastResult)}\n\n`);
        }
    } catch (err) {
        console.error("❌ Error fetching historical health result:", err.message);
    }

    const onHealthResult = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    eventEmitter.on("health:result", onHealthResult);

    req.on("close", () => {
        console.log("🔌 SSE Client disconnected from /api/v1/events/deployment-health");
        eventEmitter.removeListener("health:result", onHealthResult);
        res.end();
    });
});

export default router;
