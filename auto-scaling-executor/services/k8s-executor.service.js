import { KubeConfig, AppsV1Api } from "@kubernetes/client-node"
import logger from "../utils/logger.js"
import path from "path"
import os from "os"

class K8sExecutor {
  constructor() {
    try {
      const kc = new KubeConfig()

      // Auto-detect: in-cluster (pod) vs local (kubeconfig file)
      if (process.env.KUBERNETES_SERVICE_HOST) {
        kc.loadFromCluster()
        logger.info({ event: "K8S_INIT_IN_CLUSTER" })
      } else {
        const kubeConfigPath = process.env.KUBECONFIG || path.join(os.homedir(), ".kube", "config")
        kc.loadFromFile(kubeConfigPath)
        logger.info({ event: "K8S_INIT_KUBECONFIG", kubeconfig: kubeConfigPath })
      }

      this.appsApi = kc.makeApiClient(AppsV1Api)
      this.ns = process.env.K8S_NAMESPACE || "default"

      logger.info({
        event: "K8S_INIT_SUCCESS",
        namespace: this.ns,
      })
    } catch (err) {
      logger.error({
        event: "K8S_INIT_ERROR",
        error: err.message,
      })
    }
  }

  /**
   * Get current replica count of deployment using K8s API
   */
  async getCurrentReplicas(deployment) {
    if (!deployment) {
      logger.error({ event: "K8S_GET_FAILED", error: "Deployment name is required" })
      return 0
    }

    try {
      const res = await this.appsApi.readNamespacedDeployment({ name: deployment, namespace: this.ns })
      const replicas = res.spec?.replicas ?? 0

      logger.info({
        event: "K8S_GET_SUCCESS",
        deployment,
        namespace: this.ns,
        replicas,
      })

      return replicas
    } catch (err) {
      logger.error({
        event: "K8S_GET_FAILED",
        deployment,
        namespace: this.ns,
        error: err.body?.message || err.message,
      })

      return 0
    }
  }

  /**
   * Scale deployment to an absolute replica count using K8s Scale sub-resource
   */
  async scaleDeployment(deployment, replicas) {
    if (!deployment) {
      return {
        deployment,
        previous_replicas: 0,
        required_replicas: replicas,
        status: "FAILED",
        error: "Deployment name is required",
      }
    }

    const previous = await this.getCurrentReplicas(deployment)

    try {
      const scale = await this.appsApi.readNamespacedDeploymentScale({
        name: deployment,
        namespace: this.ns,
      })
      scale.spec.replicas = replicas
      await this.appsApi.replaceNamespacedDeploymentScale({
        name: deployment,
        namespace: this.ns,
        body: scale,
      })

      logger.info({
        event: "SCALING_EXECUTED_K8S",
        deployment,
        namespace: this.ns,
        previous_replicas: previous,
        required_replicas: replicas,
        status: "SUCCESS",
      })

      return {
        deployment,
        previous_replicas: previous,
        required_replicas: replicas,
        status: "SUCCESS",
      }
    } catch (err) {
      logger.error({
        event: "SCALING_FAILED_K8S",
        deployment,
        namespace: this.ns,
        previous_replicas: previous,
        required_replicas: replicas,
        error: err.body?.message || err.message,
      })

      return {
        deployment,
        previous_replicas: previous,
        required_replicas: replicas,
        status: "FAILED",
        error: err.body?.message || err.message,
      }
    }
  }

  /**
   * Scale deployment incrementally (add to current replicas)
   */
  async scaleDeploymentIncremental(deployment, additionalReplicas) {
    if (!deployment) {
      return {
        deployment,
        previous_replicas: 0,
        required_replicas: additionalReplicas,
        status: "FAILED",
        error: "Deployment name is required",
      }
    }

    const current = await this.getCurrentReplicas(deployment)
    const newTotal = Math.max(1, current + additionalReplicas)

    try {
      const scale = await this.appsApi.readNamespacedDeploymentScale({
        name: deployment,
        namespace: this.ns,
      })
      scale.spec.replicas = newTotal
      await this.appsApi.replaceNamespacedDeploymentScale({
        name: deployment,
        namespace: this.ns,
        body: scale,
      })

      logger.info({
        event: "SCALING_EXECUTED_K8S_INCREMENTAL",
        deployment,
        namespace: this.ns,
        previous_replicas: current,
        additional_replicas: additionalReplicas,
        required_replicas: newTotal,
        status: "SUCCESS",
      })

      return {
        deployment,
        previous_replicas: current,
        additional_replicas: additionalReplicas,
        required_replicas: newTotal,
        status: "SUCCESS",
      }
    } catch (err) {
      logger.error({
        event: "SCALING_FAILED_K8S_INCREMENTAL",
        deployment,
        namespace: this.ns,
        previous_replicas: current,
        additional_replicas: additionalReplicas,
        error: err.body?.message || err.message,
      })

      return {
        deployment,
        previous_replicas: current,
        additional_replicas: additionalReplicas,
        required_replicas: newTotal,
        status: "FAILED",
        error: err.body?.message || err.message,
      }
    }
  }
}

export default new K8sExecutor()
