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
 * Sends each record as a separate event.
 */
router.get("/events/deployment-health", async (req, res) => {
    setupSSE(res);
    console.log("🔌 SSE Client connected to /api/v1/events/deployment-health");

    // Send ALL records from database, one by one
    try {
        const allRecords = await DeploymentHealth.find()
            .sort({ createdAt: -1 });

        if (allRecords.length > 0) {
            // Send each record as a separate SSE event
            for (const record of allRecords) {
                res.write(`data: ${JSON.stringify(record)}\n\n`);
            }
            console.log(`📊 Sent ${allRecords.length} deployment health records (one by one)`);
        } else {
            res.write(`data: ${JSON.stringify({ 
                status: "empty", 
                message: "No health data yet. Trigger scaling to capture pod health."
            })}\n\n`);
        }
    } catch (err) {
        console.error("❌ Error fetching health records:", err.message);
        res.write(`data: ${JSON.stringify({ 
            status: "error", 
            message: err.message
        })}\n\n`);
    }

    const onHealthResult = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        console.log("📊 New deployment health data streamed:", data.deployment || "all deployments");
    };

    eventEmitter.on("health:result", onHealthResult);

    req.on("close", () => {
        console.log("🔌 SSE Client disconnected from /api/v1/events/deployment-health");
        eventEmitter.removeListener("health:result", onHealthResult);
        res.end();
    });
});

/**
 * GET /api/v1/deployment-health/latest
 * Get the most recent deployment health record
 */
router.get("/deployment-health/latest", async (req, res) => {
    try {
        const { deployment, namespace } = req.query;

        let query = {};
        if (deployment) query.deployment = deployment;
        if (namespace) query.namespace = namespace;

        const latestHealth = await DeploymentHealth.findOne(query)
            .sort({ createdAt: -1 });

        if (!latestHealth) {
            return res.status(404).json({ 
                error: "No health data found",
                message: "Trigger scaling to capture pod health data"
            });
        }

        res.status(200).json(latestHealth);
    } catch (error) {
        console.error("❌ Error fetching latest health:", error.message);
        res.status(500).json({ error: "Failed to fetch latest health data" });
    }
});

/**
 * GET /api/v1/deployment-health/all
 * Get all deployment health records
 */
router.get("/deployment-health/all", async (req, res) => {
    try {
        const { deployment, namespace, limit } = req.query;

        let query = {};
        if (deployment) query.deployment = deployment;
        if (namespace) query.namespace = namespace;

        let queryBuilder = DeploymentHealth.find(query).sort({ createdAt: -1 });
        
        if (limit) {
            queryBuilder = queryBuilder.limit(parseInt(limit));
        }

        const allRecords = await queryBuilder;

        res.status(200).json({
            count: allRecords.length,
            data: allRecords
        });
    } catch (error) {
        console.error("❌ Error fetching all health records:", error.message);
        res.status(500).json({ error: "Failed to fetch health records" });
    }
});

export default router;
