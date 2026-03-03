import express from "express";
import { emitScalingEvent } from "../realtime/alert.publisher.js";

const router = express.Router();

/**
 * POST /api/v1/alerts/publish
 * Manually trigger a real-time scaling alert notification.
 */
router.post("/alerts/publish", async (req, res) => {
    try {
        const result = req.body;

        if (!result.deployment || !result.status) {
            return res.status(400).json({ error: "deployment and status are required" });
        }

        // Emit the socket event
        emitScalingEvent(result);

        res.status(200).json({
            success: true,
            message: `Alert published for ${result.deployment}`,
            payload: result
        });
    } catch (err) {
        console.error("❌ Alert publish error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/v1/alerts/system
 * Trigger a generic global system notification.
 */
router.post("/alerts/system", async (req, res) => {
    try {
        const payload = req.body;

        if (!payload.message) {
            return res.status(400).json({ error: "message is required" });
        }

        const { emitSystemAlert } = await import("../realtime/alert.publisher.js");
        emitSystemAlert(payload);

        res.status(200).json({
            success: true,
            message: "System alert published",
            payload
        });
    } catch (err) {
        console.error("❌ System alert publish error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

export default router;
