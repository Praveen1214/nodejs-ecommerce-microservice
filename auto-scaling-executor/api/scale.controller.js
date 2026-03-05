import express from "express"
import k8sExecutor from "../services/k8s-executor.service.js"
import validationOrchestrator from "../services/validation-orchestrator.service.js"
import logger from "../utils/logger.js"

const router = express.Router()

class ScalingService {
  constructor() {
    this.mode = "K8S"
    this.testNamespace = process.env.TEST_NAMESPACE
    this.prodNamespace = process.env.PROD_NAMESPACE
  }

  getMode() {
    return this.mode
  }

  /**
   * SCALE MULTIPLE SERVICES (NO METRICS)
   * Simple scaling without validation layer (TEST namespace only)
   */
  async scaleMultiple(services = []) {
    const results = []

    for (const svc of services) {
      const deployment = svc.deployment
      const requestPods = Number(svc.request_pods)

      if (!deployment || !requestPods) {
        throw new Error("deployment and request_pods are required")
      }

      const previous = await k8sExecutor.getCurrentReplicas(
        deployment,
        this.testNamespace
      )

      const additional = Math.max(requestPods - previous, 0)

      const scaleResult = await k8sExecutor.scaleDeployment(
        deployment,
        requestPods,
        this.testNamespace
      )

      results.push({
        deployment,
        request_pods: requestPods,
        previous_replicas: previous,
        attempted_additional_replicas: additional,
        additional_replicas: additional,
        required_replicas: requestPods,
        status: scaleResult.status === "SUCCESS" ? "SUCCESS" : "FAILED",
        message:
          scaleResult.status === "SUCCESS"
            ? "Scale executed in TEST namespace"
            : "Scale failed",
      })
    }

    return {
      mode: this.mode,
      results,
    }
  }

  /**
   * SCALE ONE SERVICE WITH METRICS + VALIDATION + ROLLBACK
   * THIS IS YOUR ADVANCED PATH (TEST → VALIDATE)
   */
  async scaleOneWithMetrics(service) {
    const { deployment, request_pods, metrics = {}, chaosTest = false } = service

    if (!deployment || !request_pods) {
      throw new Error("deployment and request_pods are required")
    }

    // 1️⃣ Read current replicas in TEST namespace
    const previousReplicas = await k8sExecutor.getCurrentReplicas(
      deployment,
      this.testNamespace
    )

    const additionalReplicas = Math.max(
      request_pods - previousReplicas,
      0
    )

    // 2️⃣ Execute scale FIRST in TEST
    if (additionalReplicas > 0) {
      await k8sExecutor.scaleDeploymentIncremental(
        deployment,
        additionalReplicas,
        this.testNamespace
      )
    }

    // 3️⃣ Run validation
    const validationResult =
      await validationOrchestrator.validateAndFinalizeScale({
        deployment,
        request_pods,
        additional_replicas: additionalReplicas,
        metrics,
        chaosTest,
        resilienceThreshold: 0.7,
      })

    logger.info({
      event: "SCALE_WITH_VALIDATION_RESULT",
      deployment,
      namespace: this.testNamespace,
      validation: validationResult.validation,
      status: validationResult.status,
    })

    return validationResult
  }
}

const scalingService = new ScalingService()

/**
 * POST /api/v1/scale
 * Simple scaling endpoint without metrics validation
 */
router.post("/scale", async (req, res) => {
  try {
    const body = req.body

    if (Array.isArray(body.services)) {
      const result = await scalingService.scaleMultiple(body.services)
      return res.status(200).json(result)
    }

    const { deployment, request_pods } = body

    if (!deployment || !request_pods) {
      return res.status(400).json({
        error: "deployment and request_pods are required",
      })
    }

    const result = await scalingService.scaleMultiple([
      { deployment, request_pods },
    ])

    return res.status(200).json(result)
  } catch (error) {
    logger.error({ event: "SCALE_ERROR", error: error.message })
    return res.status(500).json({ error: error.message })
  }
})

export default router