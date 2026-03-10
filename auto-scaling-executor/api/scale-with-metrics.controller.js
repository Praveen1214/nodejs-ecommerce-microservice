// auto-scaling-executor/api/scale-with-metrics.controller.js

import express from "express"
import ScalingService from "../services/scaling.service.js"
import DeploymentHealthService from "../services/deployment-health.service.js"
import { emitScalingEvent } from "../realtime/alert.publisher.js"

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
  console.log(`\n[${new Date().toLocaleTimeString()}] 📥 RECEIVED SCALING REQUEST from UI`);
  console.log(JSON.stringify(req.body, null, 2));

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

        // Capture deployment health in real-time (NO DB storage)
        try {
          const namespace = process.env.K8S_NAMESPACE || "ecommerce-test"
          await DeploymentHealthService.captureDeploymentHealthRealtime(svc.deployment, namespace)
        } catch (e) {
          console.error("❌ Failed to capture deployment health:", e.message)
        }

        // Emit socket event for each result
        try {
          emitScalingEvent(result)
        } catch (e) {
          // socket may not be initialized in some environments; swallow
        }

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

    // Capture deployment health in real-time (NO DB storage)
    try {
      const namespace = process.env.K8S_NAMESPACE || "ecommerce-test"
      await DeploymentHealthService.captureDeploymentHealthRealtime(body.deployment, namespace)
    } catch (e) {
      console.error("❌ Failed to capture deployment health:", e.message)
    }

    // Emit socket event for single result
    try {
      emitScalingEvent(result)
    } catch (e) {
      // socket may not be initialized in some environments; swallow
    }

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
