// auto-scaling-executor/api/scale-with-metrics.controller.js

import express from "express"
import ScalingService from "../services/scaling.service.js"

const router = express.Router()

/**
 * POST /api/v1/scale-with-metrics
 * Supports:
 *   - Single service scaling
 *   - Multi service scaling
 * Returns consistent output structure:
 *    {
 *      "mode": "K8S",
 *      "results": [
 *         {
 *           "deployment": "...",
 *           "previous_replicas": 4,
 *           "attempted_additional_replicas": 3,
 *           "additional_replicas": 3,
 *           "required_replicas": 7,
 *           "status": "SUCCESS_VALIDATED",
 *           "message": "Scale kept – resilience validation passed",
 *           "validation": { ... }
 *         }
 *      ]
 *    }
 */
router.post("/scale-with-metrics", async (req, res) => {
  try {
    const body = req.body

    // ─────────────────────────────────────────
    // MULTI-SERVICE REQUEST
    // ─────────────────────────────────────────
    if (Array.isArray(body.services)) {
      const results = []

      for (const svc of body.services) {
        const result = await ScalingService.scaleOneWithMetrics({
          deployment: svc.deployment,
          request_pods: svc.request_pods,
          metrics: svc.metrics || {},
          scale_action: svc.scale_action || "scale_up",
        })

        results.push(result)
      }

      return res.status(200).json({
        mode: ScalingService.getMode(),
        results,
      })
    }

    // ─────────────────────────────────────────
    // SINGLE SERVICE REQUEST
    // ─────────────────────────────────────────
    const result = await ScalingService.scaleOneWithMetrics({
      deployment: body.deployment,
      request_pods: body.request_pods,
      metrics: body.metrics || {},
      scale_action: body.scale_action || "scale_up",
    })

    return res.status(200).json({
      mode: ScalingService.getMode(),
      results: [result],
    })
  } catch (err) {
    console.error("❌ scale-with-metrics error:", err.message)

    return res.status(400).json({
      success: false,
      error: err.message,
    })
  }
})

export default router
