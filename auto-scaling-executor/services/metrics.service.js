// auto-scaling-executor/services/metrics.service.js

class MetricsService {
  // Standard recommended metric thresholds
  THRESHOLDS = {
    successRate: {
      healthy: 0.99,
      warning: 0.97,
      critical: 0.95,
    },
    errorRate: {
      healthy: 0.001,
      warning: 0.01,
      critical: 0.05,
    },
    p95Latency: {
      healthy_ms: 500,
      warning_ms: 800,
      critical_ms: 1000,
    },
    latencyRegression: {
      healthy_change_percent: 0.0,
      warning_change_percent: 10,
      critical_change_percent: 20,
    },
    cpuPercent: {
      healthy: 70,
      warning: 80,
      critical: 90,
    },
    memPercent: {
      healthy: 75,
      warning: 85,
      critical: 90,
    },
    restartCount: {
      healthy_per_hour: 0,
      warning_per_hour: 1,
      critical_per_hour: 3,
    },
    trafficRecovery: {
      healthy: 0.98,
      warning: 0.95,
      critical: 0.9,
    },
  }

  /**
   * Normalize raw metric payload
   */
  extractFromPayload(metrics = {}) {
    return {
      successRate: Number(metrics.successRate ?? 0),
      errorRate: Number(metrics.errorRate ?? 0),
      p95LatencyBefore: Number(metrics.p95LatencyBefore ?? 0),
      p95LatencyAfter: Number(metrics.p95LatencyAfter ?? 0),
      cpuPercent: Number(metrics.cpuPercent ?? 0),
      memPercent: Number(metrics.memPercent ?? 0),
      restartCount: Number(metrics.restartCount ?? 0),
      trafficRecovery: Number(metrics.trafficRecovery ?? 1),
    }
  }

  /**
   * RULE-BASED STABILITY VALIDATION
   * (Hard constraints – any violation => unstable)
   */
  evaluateStability(m) {
    const reasons = []
    const evaluations = []

    // Success Rate Evaluation
    const successRateStatus = this.#evaluateMetricTier(
      m.successRate,
      this.THRESHOLDS.successRate,
      "successRate",
      true
    )
    evaluations.push(successRateStatus)
    if (m.successRate < this.THRESHOLDS.successRate.critical) {
      reasons.push(
        `Success rate too low (${m.successRate} < ${this.THRESHOLDS.successRate.critical})`
      )
    }

    // Error Rate Evaluation
    const errorRateStatus = this.#evaluateMetricTier(
      m.errorRate,
      this.THRESHOLDS.errorRate,
      "errorRate",
      false
    )
    evaluations.push(errorRateStatus)
    if (m.errorRate > this.THRESHOLDS.errorRate.critical) {
      reasons.push(`Error rate too high (${m.errorRate} > ${this.THRESHOLDS.errorRate.critical})`)
    }

    // CPU Evaluation
    const cpuStatus = this.#evaluateMetricTier(
      m.cpuPercent,
      this.THRESHOLDS.cpuPercent,
      "cpuPercent",
      false
    )
    evaluations.push(cpuStatus)
    if (m.cpuPercent > this.THRESHOLDS.cpuPercent.critical) {
      reasons.push(
        `CPU usage too high (${m.cpuPercent}% > ${this.THRESHOLDS.cpuPercent.critical}%)`
      )
    }

    // Memory Evaluation
    const memStatus = this.#evaluateMetricTier(
      m.memPercent,
      this.THRESHOLDS.memPercent,
      "memPercent",
      false
    )
    evaluations.push(memStatus)
    if (m.memPercent > this.THRESHOLDS.memPercent.critical) {
      reasons.push(
        `Memory usage too high (${m.memPercent}% > ${this.THRESHOLDS.memPercent.critical}%)`
      )
    }

    // Restart Count Evaluation
    const restartStatus = this.#evaluateMetricTier(
      m.restartCount,
      this.THRESHOLDS.restartCount,
      "restartCount",
      false
    )
    evaluations.push(restartStatus)
    if (m.restartCount >= this.THRESHOLDS.restartCount.critical_per_hour) {
      reasons.push(
        `Too many restarts (${m.restartCount} >= ${this.THRESHOLDS.restartCount.critical_per_hour})`
      )
    }

    // Traffic Recovery Evaluation
    const trafficStatus = this.#evaluateMetricTier(
      m.trafficRecovery,
      this.THRESHOLDS.trafficRecovery,
      "trafficRecovery",
      true
    )
    evaluations.push(trafficStatus)
    if (m.trafficRecovery < this.THRESHOLDS.trafficRecovery.critical) {
      reasons.push(
        `Traffic recovery too low (${(m.trafficRecovery * 100).toFixed(0)}% < ${(
          this.THRESHOLDS.trafficRecovery.critical * 100
        ).toFixed(0)}%)`
      )
    }

    // Latency-specific compound rule
    if (m.p95LatencyBefore > 0 && m.p95LatencyAfter > 0) {
      const changePercent = ((m.p95LatencyAfter - m.p95LatencyBefore) / m.p95LatencyBefore) * 100

      const latencyStatus = this.#evaluateMetricTier(
        m.p95LatencyAfter,
        this.THRESHOLDS.p95Latency,
        "p95LatencyAfter",
        false
      )
      evaluations.push(latencyStatus)

      const regressionStatus = this.#evaluateMetricTier(
        changePercent,
        this.THRESHOLDS.latencyRegression,
        "latencyRegression",
        false
      )
      evaluations.push(regressionStatus)

      if (m.p95LatencyAfter > this.THRESHOLDS.p95Latency.critical_ms) {
        reasons.push(
          `p95LatencyAfter too high (${m.p95LatencyAfter}ms > ${this.THRESHOLDS.p95Latency.critical_ms}ms)`
        )
      }

      if (changePercent > this.THRESHOLDS.latencyRegression.critical_change_percent) {
        reasons.push(
          `Latency regression too large (${changePercent.toFixed(1)}% > ${
            this.THRESHOLDS.latencyRegression.critical_change_percent
          }%)`
        )
      }
    }

    return {
      isStable: reasons.length === 0,
      reasons,
      evaluations,
    }
  }

  /**
   * SOFT RESILIENCE SCORE (0–1)
   * Used for graded decisions & research analysis
   */
  calculateResilienceScore({ p95LatencyAfter, errorRate, trafficRecovery = 1 }) {
    const latencyScore = this.#latencyScore(p95LatencyAfter)
    const errorScore = this.#errorScore(errorRate)
    const trafficScore = this.#trafficScore(trafficRecovery)

    const score = Number((0.4 * latencyScore + 0.3 * errorScore + 0.3 * trafficScore).toFixed(3))

    return {
      score,
      latencyScore,
      errorScore,
      trafficScore,
    }
  }

  /**
   * --- PRIVATE HELPERS ---
   */

  /**
   * Evaluate which tier a metric falls into (HEALTHY/WARNING/CRITICAL)
   */
  #evaluateMetricTier(value, thresholds, metricName, higherIsBetter = true) {
    let tier = "CRITICAL"
    let rangeUsed = ""

    if (higherIsBetter) {
      // For metrics like successRate, trafficRecovery (higher is better)
      if (value >= thresholds.healthy) {
        tier = "HEALTHY"
        rangeUsed = `>= ${thresholds.healthy}`
      } else if (value >= thresholds.warning) {
        tier = "WARNING"
        rangeUsed = `${thresholds.warning} - ${thresholds.healthy}`
      } else if (value >= thresholds.critical) {
        tier = "CRITICAL"
        rangeUsed = `${thresholds.critical} - ${thresholds.warning}`
      } else {
        tier = "FAILED"
        rangeUsed = `< ${thresholds.critical}`
      }
    } else {
      // For metrics like errorRate, CPU, memory (lower is better)
      const healthyKey = Object.keys(thresholds).find((k) => k.includes("healthy"))
      const warningKey = Object.keys(thresholds).find((k) => k.includes("warning"))
      const criticalKey = Object.keys(thresholds).find((k) => k.includes("critical"))

      const healthyVal = thresholds[healthyKey]
      const warningVal = thresholds[warningKey]
      const criticalVal = thresholds[criticalKey]

      if (value <= healthyVal) {
        tier = "HEALTHY"
        rangeUsed = `<= ${healthyVal}`
      } else if (value <= warningVal) {
        tier = "WARNING"
        rangeUsed = `${healthyVal} - ${warningVal}`
      } else if (value <= criticalVal) {
        tier = "CRITICAL"
        rangeUsed = `${warningVal} - ${criticalVal}`
      } else {
        tier = "FAILED"
        rangeUsed = `> ${criticalVal}`
      }
    }

    return {
      metric: metricName,
      value,
      tier,
      rangeUsed,
      standard: thresholds,
    }
  }

  #latencyScore(latency) {
    if (latency <= this.THRESHOLDS.p95Latency.healthy_ms) return 1
    if (latency >= this.THRESHOLDS.p95Latency.critical_ms) return 0
    return (
      1 -
      (latency - this.THRESHOLDS.p95Latency.healthy_ms) /
        (this.THRESHOLDS.p95Latency.critical_ms - this.THRESHOLDS.p95Latency.healthy_ms)
    )
  }

  #errorScore(errorRate) {
    if (errorRate <= this.THRESHOLDS.errorRate.healthy) return 1
    if (errorRate >= this.THRESHOLDS.errorRate.critical) return 0
    return (
      1 -
      (errorRate - this.THRESHOLDS.errorRate.healthy) /
        (this.THRESHOLDS.errorRate.critical - this.THRESHOLDS.errorRate.healthy)
    )
  }

  #trafficScore(trafficRecovery) {
    if (trafficRecovery >= this.THRESHOLDS.trafficRecovery.healthy) return 1
    if (trafficRecovery <= this.THRESHOLDS.trafficRecovery.critical) return 0
    return (
      (trafficRecovery - this.THRESHOLDS.trafficRecovery.critical) /
      (this.THRESHOLDS.trafficRecovery.healthy - this.THRESHOLDS.trafficRecovery.critical)
    )
  }
}

export default new MetricsService()
