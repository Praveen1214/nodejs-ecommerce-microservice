// auto-scaling-executor/services/scaling.service.js

import LocalScaler from "./local-scaler.service.js"
import K8sExecutor from "./k8s-executor.service.js"
import MetricsService from "./metrics.service.js"
import ChaosService from "./chaos.service.js"
import LoggingService from "./logging.service.js"
import ChaosExperiment from "../models/chaos-experiment.model.js"
import eventEmitter from "../utils/events.js"

class ScalingService {
  constructor() {
    this.RESILIENCE_THRESHOLD = Number(process.env.RESILIENCE_THRESHOLD || 0.7)
    this.CHAOS_WAIT_MS = Number(process.env.CHAOS_WAIT_MS || 10000) // 10s default
  }

  // Getter that reads from process.env each time (not cached)
  get AUTO_PROMOTE_TO_PROD() {
    return process.env.AUTO_PROMOTE_TO_PROD === "true"
  }

  get TEST_NAMESPACE() {
    return process.env.TEST_NAMESPACE || process.env.K8S_NAMESPACE || "ecommerce-test"
  }

  get PROD_NAMESPACE() {
    return process.env.PROD_NAMESPACE || "ecommerce-prod"
  }

  /**
   * Auto-promote test scaling to production
   * Scales the same deployment in prod to match the final replica count in test
   */
  async promoteToProduction(deployment, finalReplicas) {
    console.log(`📋 Auto-promotion check: AUTO_PROMOTE_TO_PROD=${this.AUTO_PROMOTE_TO_PROD}`)

    if (!this.AUTO_PROMOTE_TO_PROD) {
      return { promoted: false, reason: "AUTO_PROMOTE_TO_PROD disabled" }
    }

    try {
      console.log(`🚀 Auto-promoting ${deployment} to production (${finalReplicas} replicas)...`)

      // Scale prod deployment to same replica count
      const result = await K8sExecutor.scaleDeployment(deployment, finalReplicas, this.PROD_NAMESPACE)

      if (result.status === "SUCCESS") {
        console.log(`✅ Production scaled: ${deployment} -> ${finalReplicas} replicas`)
        return {
          promoted: true,
          deployment,
          namespace: this.PROD_NAMESPACE,
          replicas: finalReplicas,
          previous_replicas: result.previous_replicas,
        }
      }

      return { promoted: false, reason: result.error || "Scaling failed" }
    } catch (err) {
      console.error(`❌ Auto-promotion failed: ${err.message}`)
      return { promoted: false, reason: err.message }
    }
  }

  getMode() {
    return process.env.EXECUTION_MODE || "LOCAL"
  }

  validate(obj) {
    if (!obj.deployment || typeof obj.deployment !== "string" || obj.deployment.trim() === "") {
      throw new Error("deployment is required and must be a non-empty string")
    }
    if (!obj.request_pods || isNaN(Number(obj.request_pods))) {
      throw new Error("request_pods must be a valid number")
    }
    if (obj.request_pods <= 0) throw new Error("request_pods must be > 0")
  }

  calculatePods(requestPods) {
    return Math.max(1, requestPods)
  }

  /**
   * --- MAIN METHOD ---
   * IF scale_action is "no_change": return current state without scaling
   * IF scale_action is "scale_up": increment pods by request_pods
   * IF scale_action is "scale_down": decrement pods by request_pods
   *
   * IF metrics provided:
   *   1) Scale
   *   2) (K8S only) Inject chaos
   *   3) Validate metrics
   *   4) (K8S only) Rollback on failure
   *
   * IF NO metrics provided:
   *   Just scale to request_pods count directly (no validation, no rollback)
   */
  async scaleOneWithMetrics({ deployment, request_pods, metrics, scale_action = "scale_up" }) {
    this.validate({ deployment, request_pods })
    const mode = this.getMode()

    // ─────────────────────────────────────────
    // CHECK: scale_action
    // ─────────────────────────────────────────
    if (scale_action === "no_change") {
      const previousReplicas = await K8sExecutor.getCurrentReplicas(deployment)
      if (mode === "K8S" && previousReplicas === null) {
        return {
          deployment,
          request_pods,
          scale_action: "no_change",
          previous_replicas: null,
          attempted_additional_replicas: 0,
          additional_replicas: 0,
          required_replicas: null,
          status: "FAILED",
          message: `Unable to read current replicas for deployment '${deployment}'`,
          validation: {
            passed: false,
            rolledBack: false,
            skipped: true,
            reason: "Kubernetes replica lookup failed",
          },
        }
      }
      return {
        deployment,
        request_pods,
        scale_action: "no_change",
        previous_replicas: previousReplicas,
        attempted_additional_replicas: 0,
        additional_replicas: 0,
        required_replicas: previousReplicas,
        status: "NO_ACTION",
        message: "No scaling action applied – scale_action is 'no_change'",
        validation: {
          passed: null,
          rolledBack: false,
          skipped: true,
          reason: "scale_action set to no_change",
        },
      }
    }

    // Calculate pods based on scale_action
    let additionalPods = this.calculatePods(request_pods)
    if (scale_action === "scale_down") {
      additionalPods = -additionalPods
    }

    // ─────────────────────────────────────────
    // CHECK: Metrics provided?
    // ─────────────────────────────────────────
    const hasMetrics = metrics && Object.keys(metrics).length > 0

    // If NO metrics → just scale directly (no validation)
    if (!hasMetrics) {
      const namespace = process.env.K8S_NAMESPACE || "ecommerce-test"
      const baseResult =
        mode === "K8S"
          ? await K8sExecutor.scaleDeploymentIncremental(deployment, additionalPods)
          : LocalScaler.simulateScaling(deployment, additionalPods)

      if (baseResult.status === "SUCCESS") {
        // Auto-promote to production if enabled and in test namespace
        let productionPromotion = null
        if (mode === "K8S" && namespace === this.TEST_NAMESPACE) {
          productionPromotion = await this.promoteToProduction(deployment, baseResult.required_replicas)
        }

        const result = {
          deployment,
          request_pods,
          scale_action: scale_action,
          previous_replicas: baseResult.previous_replicas,
          attempted_additional_replicas: additionalPods,
          additional_replicas: baseResult.additional_replicas ?? additionalPods,
          required_replicas: baseResult.required_replicas,
          status: "SUCCESS_NO_VALIDATION",
          message: "Scaled successfully (no metrics provided, validation skipped)",
          production_promotion: productionPromotion,
          validation: {
            passed: null,
            rolledBack: false,
            skipped: true,
            reason: "No metrics in request body",
          },
        }

        // --- MONGODB LOGGING ---
        await LoggingService.logScalingResult(result)

        return result
      }

      const result = {
        ...baseResult,
        request_pods,
        scale_action: scale_action,
        attempted_additional_replicas: additionalPods,
        additional_replicas: 0,
        validation: {
          passed: false,
          rolledBack: false,
          skipped: true,
          reason: "Scaling failed before validation",
        },
      }

      // --- MONGODB LOGGING ---
      await LoggingService.logScalingResult(result)

      return result
    }

    // ─────────────────────────────────────────
    // WITH METRICS → Full validation flow
    // ─────────────────────────────────────────
    // STEP 1 – Apply scale (LOCAL or K8S)
    // ─────────────────────────────────────────
    let baseResult =
      mode === "K8S"
        ? await K8sExecutor.scaleDeploymentIncremental(deployment, additionalPods)
        : LocalScaler.simulateScaling(deployment, additionalPods)

    const attemptedAdditional = baseResult.additional_replicas ?? additionalPods

    if (baseResult.status !== "SUCCESS") {
      const result = {
        ...baseResult,
        request_pods,
        scale_action: scale_action,
        attempted_additional_replicas: attemptedAdditional,
        additional_replicas: 0,
        validation: {
          passed: false,
          rolledBack: false,
          skipped: true,
          reason: "Scaling failed before validation",
        },
      }

      // --- MONGODB LOGGING ---
      await LoggingService.logScalingResult(result)

      return result
    }

    // ─────────────────────────────────────────
    // (K8S ONLY) STEP 2 – Inject chaos & wait
    // ─────────────────────────────────────────
    const chaosEnabled = mode === "K8S"
    let chaosInjected = false
    let chaosData = null
    const namespace = process.env.K8S_NAMESPACE || "ecommerce-test"

    if (chaosEnabled) {
      try {
        const chaosResult = await ChaosService.injectPodFailure(deployment, namespace)
        chaosInjected = chaosResult.success
        if (chaosInjected) {
          chaosData = {
            startTime: chaosResult.startTime,
            affectedPods: chaosResult.affectedPods,
            experimentName: chaosResult.experimentName
          }
        }
      } catch (e) {
        console.error("Chaos injection error:", e.message)
      }

      // allow system to react to chaos (latency, errors, restarts ...)
      if (chaosInjected && this.CHAOS_WAIT_MS > 0) {
        await new Promise((r) => setTimeout(r, this.CHAOS_WAIT_MS))
      }
    }

    // We ALWAYS try to clean chaos at the end
    let validationResult = null
    try {
      // ─────────────────────────────────────────
      // STEP 3 – Validate metrics (payload-based)
      // ─────────────────────────────────────────
      const extracted = MetricsService.extractFromPayload(metrics || {})
      const stability = MetricsService.evaluateStability(extracted)
      const scoreData = MetricsService.calculateResilienceScore(extracted)

      const scorePassed = scoreData.score >= this.RESILIENCE_THRESHOLD
      const passed = stability.isStable && scorePassed
      
      // Store validation result for chaos experiment logging
      validationResult = passed

      // ─────────────────────────────────────────
      // STEP 4 – LOCAL MODE → NO rollback, only reporting
      // ─────────────────────────────────────────
      if (mode !== "K8S") {
        const result = {
          deployment,
          request_pods,
          scale_action: scale_action,
          previous_replicas: baseResult.previous_replicas,
          attempted_additional_replicas: attemptedAdditional,
          additional_replicas: attemptedAdditional,
          required_replicas: baseResult.required_replicas,
          status: passed ? "SUCCESS_VALIDATED_LOCAL" : "SUCCESS_VALIDATION_FAILED_LOCAL",
          message: baseResult.message,
          validation: {
            ...scoreData,
            passed,
            rolledBack: false,
            threshold: this.RESILIENCE_THRESHOLD,
            hardSafetyPassed: stability.isStable,
            reasons: stability.reasons,
            metricsEvaluation: stability.evaluations || [],
            standardsUsed: MetricsService.THRESHOLDS,
          },
        }

        // --- MONGODB LOGGING ---
        await LoggingService.logScalingResult(result)

        return result
      }

      // ─────────────────────────────────────────
      // STEP 5 – K8S MODE → PASS → keep scale
      // ─────────────────────────────────────────
      if (passed) {
        // Auto-promote to production if enabled and in test namespace
        console.log(`🔍 Checking auto-promotion: namespace=${namespace}, TEST_NAMESPACE=${this.TEST_NAMESPACE}, match=${namespace === this.TEST_NAMESPACE}`)

        let productionPromotion = null
        if (namespace === this.TEST_NAMESPACE) {
          productionPromotion = await this.promoteToProduction(deployment, baseResult.required_replicas)
        } else {
          console.log(`⏭️  Skipping auto-promotion (namespace mismatch)`)
          productionPromotion = { promoted: false, reason: `Not in test namespace (current: ${namespace})` }
        }

        const result = {
          deployment,
          request_pods,
          scale_action: scale_action,
          previous_replicas: baseResult.previous_replicas,
          attempted_additional_replicas: attemptedAdditional,
          additional_replicas: attemptedAdditional,
          required_replicas: baseResult.required_replicas,
          status: "SUCCESS_VALIDATED",
          message: "Scale kept – resilience validation passed",
          production_promotion: productionPromotion,
          validation: {
            ...scoreData,
            passed: true,
            rolledBack: false,
            threshold: this.RESILIENCE_THRESHOLD,
            hardSafetyPassed: stability.isStable,
            reasons: stability.reasons,
            metricsEvaluation: stability.evaluations || [],
            standardsUsed: MetricsService.THRESHOLDS,
          },
        }

        // --- MONGODB LOGGING ---
        await LoggingService.logScalingResult(result)

        return result
      }

      // ─────────────────────────────────────────
      // STEP 6 – K8S MODE → FAIL → rollback
      // ─────────────────────────────────────────
      await K8sExecutor.scaleDeployment(deployment, baseResult.previous_replicas)

      const result = {
        deployment,
        request_pods,
        scale_action: scale_action,
        previous_replicas: baseResult.previous_replicas,
        attempted_additional_replicas: attemptedAdditional,
        additional_replicas: 0,
        required_replicas: baseResult.previous_replicas,
        status: "ROLLED_BACK",
        message: "Resilience validation failed – scale rolled back",
        rollback_reason: stability.reasons,
        validation: {
          ...scoreData,
          passed: false,
          rolledBack: true,
          threshold: this.RESILIENCE_THRESHOLD,
          hardSafetyPassed: stability.isStable,
          reasons: stability.reasons,
          metricsEvaluation: stability.evaluations || [],
          standardsUsed: MetricsService.THRESHOLDS,
        },
      }

      // --- MONGODB LOGGING ---
      await LoggingService.logScalingResult(result)

      return result
    } finally {
      // Always attempt to remove chaos if we injected it
      if (chaosEnabled && chaosInjected && chaosData) {
        const cleanupResult = await ChaosService.deleteChaos(deployment, namespace)
        
        // Store chaos experiment data
        try {
          const recoveryTimeMs = cleanupResult.endTime - chaosData.startTime
          const recoveryTimeSeconds = Math.round(recoveryTimeMs / 1000)
          
          const experimentId = `exp_${deployment}_${Date.now()}`
          
          const chaosExperiment = new ChaosExperiment({
            experimentId,
            service: deployment,
            namespace,
            faultType: "pod-failure",
            startTime: chaosData.startTime,
            endTime: cleanupResult.endTime,
            durationSeconds: Math.round(this.CHAOS_WAIT_MS / 1000),
            latencyBefore: 0,
            latencyDuring: 0,
            latencyAfter: 0,
            errorRateBefore: 0,
            errorRateDuring: 0,
            errorRateAfter: 0,
            recoveryTimeSeconds,
            availabilityDuringChaos: validationResult !== null ? (validationResult ? 100 : 0) : 0,
            resilienceScore: validationResult !== null ? (validationResult ? 1.0 : 0.0) : 0.5,
            result: validationResult !== null ? (validationResult ? "PASS" : "FAIL") : "FAIL",
            createdAt: new Date()
          })
          
          // Add custom fields for the required data
          chaosExperiment.affectedPodsCount = chaosData.affectedPods
          chaosExperiment.restartCount = cleanupResult.restartCount
          chaosExperiment.experimentName = chaosData.experimentName
          
          const savedExperiment = await chaosExperiment.save()
          console.log(`✅ Chaos experiment stored: ${savedExperiment.experimentId}`)
          
          // Emit event for SSE
          eventEmitter.emit("chaos:result", savedExperiment)
          console.log("📡 Event emitted: chaos:result")
        } catch (err) {
          console.error("❌ Failed to store chaos experiment:", err.message)
        }
      }
    }
  }

  /**
   * Scale multiple services without metrics validation or chaos.
   * Keeps output shape consistent with other endpoints.
   */
  async scaleMultiple(services) {
    const mode = this.getMode()
    const namespace = process.env.K8S_NAMESPACE || "ecommerce-test"
    const results = []

    for (const svc of services) {
      try {
        this.validate(svc)
        const { deployment, request_pods } = svc
        const additionalPods = this.calculatePods(request_pods)

        const baseResult =
          mode === "K8S"
            ? await K8sExecutor.scaleDeploymentIncremental(deployment, additionalPods)
            : LocalScaler.simulateScaling(deployment, additionalPods)

        const attemptedAdditional = baseResult.additional_replicas ?? additionalPods

        const success = baseResult.status === "SUCCESS"

        // Auto-promote to production if enabled and in test namespace
        let productionPromotion = null
        if (success && mode === "K8S" && namespace === this.TEST_NAMESPACE) {
          productionPromotion = await this.promoteToProduction(deployment, baseResult.required_replicas)
        }

        const res = {
          deployment,
          request_pods,
          previous_replicas: baseResult.previous_replicas,
          attempted_additional_replicas: attemptedAdditional,
          additional_replicas: success ? attemptedAdditional : 0,
          required_replicas: baseResult.required_replicas,
          status: baseResult.status,
          message:
            baseResult.message ||
            (success ? "Scaled successfully" : baseResult.error || "Scaling failed"),
          production_promotion: productionPromotion,
        }

        // --- MONGODB LOGGING ---
        await LoggingService.logScalingResult({
          ...res,
          scale_action: additionalPods > 0 ? "scale_up" : "scale_down"
        })

        results.push(res)
      } catch (err) {
        results.push({
          deployment: svc?.deployment,
          request_pods: svc?.request_pods,
          previous_replicas: 0,
          attempted_additional_replicas: 0,
          additional_replicas: 0,
          required_replicas: 0,
          status: "FAILED",
          message: err.message,
        })
      }
    }

    return { mode, results }
  }

  async scaleMultipleWithMetrics(services) {
    const results = []
    for (const svc of services) {
      results.push(await this.scaleOneWithMetrics(svc))
    }
    return { mode: this.getMode(), results }
  }
}

export default new ScalingService()
