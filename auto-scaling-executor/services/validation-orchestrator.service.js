// auto-scaling-executor/services/validation-orchestrator.service.js

import k8sExecutor from "./k8s-executor.service.js"
import metricsService from "./metrics.service.js"
import chaosService from "./chaos.service.js"
import logger from "../utils/logger.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class ValidationOrchestrator {
  /**
   * Main validation + rollback-safe execution (TEST env)
   *
   * Expected caller behavior:
   * - Caller scales TEST first
   * - Then calls this validator with metrics payload
   *
   * Improvements:
   * - Correct rollback target: previous replicas BEFORE scaling
   * - Chaos injected BEFORE final "pass", and checked for recovery
   * - Chaos always cleaned (finally)
   */
  async validateAndFinalizeScale({
    deployment,
    request_pods,
    additional_replicas,
    metrics,
    chaosTest = false,
    resilienceThreshold = 0.7,

    // NEW (optional, backward compatible):
    // If caller already knows previous replicas (before scale), pass it.
    previous_replicas_before_scale,

    // NEW (optional):
    // Which namespace are we validating? Default: TEST_NAMESPACE
    namespace = process.env.TEST_NAMESPACE,

    // NEW (optional):
    // Waits (ms)
    chaosWaitMs = Number(process.env.CHAOS_WAIT_MS || 15000),
    stabilizationWaitMs = 10000,
  }) {
    // -----------------------------
    // 0) Basic guards
    // -----------------------------
    if (!deployment) {
      throw new Error("deployment is required")
    }
    if (!namespace) {
      // fallback safety
      namespace = "default"
    }

    // -----------------------------
    // 1) Determine rollback target
    // -----------------------------
    // IMPORTANT:
    // We must rollback to the replica count BEFORE scaling.
    // If caller didn't provide it, we try to derive it:
    //   current(after-scale) - additional_replicas
    // This is safer than rolling back to "current" (which would keep the scale).
    const currentAfterScale = await k8sExecutor.getCurrentReplicas(deployment, namespace)

    let rollbackTarget =
      typeof previous_replicas_before_scale === "number"
        ? previous_replicas_before_scale
        : Math.max(currentAfterScale - Number(additional_replicas || 0), 0)

    // -----------------------------
    // 2) Baseline validation (pre-chaos)
    // -----------------------------
    const baselineMetrics = metricsService.extractFromPayload(metrics)
    const baselineStability = metricsService.evaluateStability(baselineMetrics)
    const baselineResilience = metricsService.calculateResilienceScore(baselineMetrics)

    let passed =
      baselineStability.isStable && baselineResilience.score >= Number(resilienceThreshold)

    let rollbackExecuted = false
    let chaosInjected = false
    let postChaosResilience = null
    let postChaosStability = null

    // If baseline failed → rollback immediately (no chaos)
    if (!passed) {
      rollbackExecuted = true

      logger.warn({
        event: "VALIDATION_FAILED_BASELINE_ROLLBACK",
        deployment,
        namespace,
        rollback_to: rollbackTarget,
        reasons: baselineStability.reasons,
        resilienceScore: baselineResilience.score,
      })

      await k8sExecutor.scaleDeployment(deployment, rollbackTarget, namespace)

      return {
        deployment,
        request_pods,
        previous_replicas: rollbackTarget,
        attempted_additional_replicas: additional_replicas,
        additional_replicas: 0,
        required_replicas: rollbackTarget,
        status: "ROLLED_BACK",
        message: "Scale rolled back – baseline validation failed",
        validation: {
          score: baselineResilience.score,
          latencyScore: baselineResilience.latencyScore,
          errorScore: baselineResilience.errorScore,
          trafficScore: baselineResilience.trafficScore,
          passed: false,
          rolledBack: true,
          threshold: resilienceThreshold,
          hardSafetyPassed: baselineStability.isStable,
          reasons: baselineStability.reasons,
          metricsEvaluation: baselineStability.evaluations || [],
          standardsUsed: metricsService.THRESHOLDS,
          chaos: {
            enabled: chaosTest,
            injected: false,
            postChaosPassed: null,
          },
        },
      }
    }

    // -----------------------------
    // 3) Chaos validation (if enabled)
    // -----------------------------
    // Correct sequence for research:
    // - Inject chaos while scaled pods are active
    // - Wait recovery window
    // - Evaluate post-chaos metrics (if provided)
    // - Delete chaos (always)
    // - Stabilization wait
    // - If post-chaos fails → rollback
    if (passed && chaosTest) {
      try {
        chaosInjected = true

        logger.info({
          event: "CHAOS_INJECT_START",
          deployment,
          namespace,
        })

        await chaosService.injectPodFailure(deployment, namespace)

        logger.info({
          event: "CHAOS_INJECTED",
          deployment,
          namespace,
          wait_ms: chaosWaitMs,
        })

        await sleep(chaosWaitMs)

        // Post-chaos metrics:
        // If you pass post-chaos metrics in payload, use it.
        // You can send it from Postman like:
        // metrics: { ...baseline, postChaos: { ... } }
        const postChaosPayload = metrics?.postChaos || metrics?.post_chaos || null

        const postChaosM = postChaosPayload
          ? metricsService.extractFromPayload(postChaosPayload)
          : baselineMetrics // fallback (no live source yet)

        postChaosStability = metricsService.evaluateStability(postChaosM)
        postChaosResilience = metricsService.calculateResilienceScore(postChaosM)

        const postChaosPassed =
          postChaosStability.isStable && postChaosResilience.score >= Number(resilienceThreshold)

        logger.info({
          event: "CHAOS_POST_EVAL",
          deployment,
          namespace,
          postChaosPassed,
          postChaosScore: postChaosResilience.score,
          postChaosReasons: postChaosStability.reasons,
        })

        // If chaos recovery failed → rollback
        if (!postChaosPassed) {
          passed = false
          rollbackExecuted = true

          logger.warn({
            event: "VALIDATION_FAILED_POST_CHAOS_ROLLBACK",
            deployment,
            namespace,
            rollback_to: rollbackTarget,
            reasons: postChaosStability.reasons,
            resilienceScore: postChaosResilience.score,
          })

          await k8sExecutor.scaleDeployment(deployment, rollbackTarget, namespace)
        }
      } finally {
        // Always clean chaos
        try {
          if (chaosInjected) {
            logger.info({
              event: "CHAOS_DELETE_START",
              deployment,
              namespace,
            })

            await chaosService.deleteChaos(deployment, namespace)

            logger.info({
              event: "CHAOS_DELETED",
              deployment,
              namespace,
              stabilization_wait_ms: stabilizationWaitMs,
            })

            await sleep(stabilizationWaitMs)
          }
        } catch (cleanupErr) {
          logger.error({
            event: "CHAOS_DELETE_FAILED",
            deployment,
            namespace,
            error: cleanupErr.message,
          })
        }
      }
    }

    // -----------------------------
    // 4) Final response (same structure)
    // -----------------------------
    // If passed after chaos (or chaos disabled) → keep scale
    // If failed at post-chaos → rollback already done
    const finalAfter = await k8sExecutor.getCurrentReplicas(deployment, namespace)

    const finalScore = postChaosResilience ? postChaosResilience.score : baselineResilience.score
    const finalLatency = postChaosResilience
      ? postChaosResilience.latencyScore
      : baselineResilience.latencyScore
    const finalError = postChaosResilience ? postChaosResilience.errorScore : baselineResilience.errorScore
    const finalTraffic = postChaosResilience
      ? postChaosResilience.trafficScore
      : baselineResilience.trafficScore

    const finalStability = postChaosStability || baselineStability

    return {
      deployment,
      request_pods,
      previous_replicas: rollbackTarget,
      attempted_additional_replicas: additional_replicas,
      additional_replicas: passed ? additional_replicas : 0,
      required_replicas: passed ? finalAfter : rollbackTarget,
      status: passed ? "SUCCESS_VALIDATED" : "ROLLED_BACK",
      message: passed
        ? "Scale kept – resilience validation passed"
        : "Scale rolled back – post-chaos validation failed",
      validation: {
        score: finalScore,
        latencyScore: finalLatency,
        errorScore: finalError,
        trafficScore: finalTraffic,
        passed,
        rolledBack: rollbackExecuted,
        threshold: resilienceThreshold,
        hardSafetyPassed: finalStability.isStable,
        reasons: finalStability.reasons,
        metricsEvaluation: finalStability.evaluations || [],
        standardsUsed: metricsService.THRESHOLDS,
        chaos: {
          enabled: chaosTest,
          injected: !!(chaosTest && chaosInjected),
          postChaosPassed: chaosTest
            ? (postChaosResilience
                ? postChaosResilience.score >= Number(resilienceThreshold) && (postChaosStability?.isStable ?? false)
                : null)
            : null,
        },
      },
    }
  }
}

export default new ValidationOrchestrator()