import k8sExecutor from "./k8s-executor.service.js"
import metricsService from "./metrics.service.js"
import chaosService from "./chaos.service.js"
import logger from "../utils/logger.js"

class ValidationOrchestrator {
  /**
   * Main validation + rollback-safe execution
   */
  async validateAndFinalizeScale({
    deployment,
    request_pods,
    additional_replicas,
    metrics,
    chaosTest = false,
    resilienceThreshold = 0.7,
  }) {
    // 1️⃣ Normalize metrics
    const m = metricsService.extractFromPayload(metrics)

    // 2️⃣ HARD safety validation
    const stability = metricsService.evaluateStability(m)

    // 3️⃣ SOFT resilience score
    const resilience = metricsService.calculateResilienceScore(m)

    // 4️⃣ Decide scale outcome
    const passed = stability.isStable && resilience.score >= resilienceThreshold

    const currentReplicas = await k8sExecutor.getCurrentReplicas(deployment)

    let rollbackExecuted = false

    // 5️⃣ OPTIONAL chaos validation (research novelty)
    if (passed && chaosTest) {
      await chaosService.injectPodFailure(deployment)
      await new Promise((r) => setTimeout(r, 15000))
      await chaosService.deleteChaos(deployment)
    }

    // 6️⃣ ROLLBACK LOGIC (DO NOT TOUCH EXECUTOR)
    if (!passed) {
      rollbackExecuted = true

      logger.warn({
        event: "VALIDATION_FAILED_ROLLBACK",
        deployment,
        rollback_to: currentReplicas,
        reasons: stability.reasons,
        resilienceScore: resilience.score,
      })

      await k8sExecutor.scaleDeployment(deployment, currentReplicas)
    }

    // 7️⃣ Final response (KEEP YOUR FORMAT)
    return {
      deployment,
      request_pods,
      previous_replicas: currentReplicas,
      attempted_additional_replicas: additional_replicas,
      additional_replicas: passed ? additional_replicas : 0,
      required_replicas: passed ? currentReplicas + additional_replicas : currentReplicas,
      status: passed ? "SUCCESS_VALIDATED" : "ROLLED_BACK",
      message: passed
        ? "Scale kept – resilience validation passed"
        : "Scale rolled back – validation failed",
      validation: {
        score: resilience.score,
        latencyScore: resilience.latencyScore,
        errorScore: resilience.errorScore,
        trafficScore: resilience.trafficScore,
        passed,
        rolledBack: rollbackExecuted,
        threshold: resilienceThreshold,
        hardSafetyPassed: stability.isStable,
        reasons: stability.reasons,
        metricsEvaluation: stability.evaluations || [],
        standardsUsed: metricsService.THRESHOLDS,
      },
    }
  }
}

export default new ValidationOrchestrator()
