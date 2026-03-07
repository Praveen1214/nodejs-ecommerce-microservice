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
 * Sends each record as a separate event with pagination support.
 * Query params: ?page=1&limit=10
 */
router.get("/events/deployment-health", async (req, res) => {
    setupSSE(res);
    console.log("🔌 SSE Client connected to /api/v1/events/deployment-health");

    // Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Send paginated records from database, one by one
    try {
        const totalCount = await DeploymentHealth.countDocuments();
        const totalPages = Math.ceil(totalCount / limit);

        const paginatedRecords = await DeploymentHealth.find()
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        if (paginatedRecords.length > 0) {
            // Send pagination info first
            res.write(`data: ${JSON.stringify({
                type: "pagination_info",
                page: page,
                limit: limit,
                totalRecords: totalCount,
                totalPages: totalPages,
                hasMore: page < totalPages
            })}\n\n`);

            // Send each record as a separate SSE event
            for (const record of paginatedRecords) {
                res.write(`data: ${JSON.stringify(record)}\n\n`);
            }
            console.log(`📊 Sent ${paginatedRecords.length} deployment health records (page ${page}/${totalPages})`);
        } else {
            res.write(`data: ${JSON.stringify({ 
                status: "empty", 
                message: "No health data yet. Trigger scaling to capture pod health.",
                page: page,
                totalRecords: 0
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
 * Get all deployment health records with pagination
 * Query params: ?page=1&limit=10&deployment=product&namespace=ecommerce-test
 */
router.get("/deployment-health/all", async (req, res) => {
    try {
        const { deployment, namespace, page = 1, limit = 10 } = req.query;

        let query = {};
        if (deployment) query.deployment = deployment;
        if (namespace) query.namespace = namespace;

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const totalCount = await DeploymentHealth.countDocuments(query);
        const totalPages = Math.ceil(totalCount / limitNum);

        const records = await DeploymentHealth.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum);

        res.status(200).json({
            page: pageNum,
            limit: limitNum,
            totalRecords: totalCount,
            totalPages: totalPages,
            hasMore: pageNum < totalPages,
            count: records.length,
            data: records
        });
    } catch (error) {
        console.error("❌ Error fetching all health records:", error.message);
        res.status(500).json({ error: "Failed to fetch health records" });
    }
});

export default router;
