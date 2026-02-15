import { KubeConfig, AppsV1Api } from "@kubernetes/client-node"
import logger from "../utils/logger.js"
import path from "path"
import os from "os"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

class K8sExecutor {
  constructor() {
    try {
      const kc = new KubeConfig()

      //  VERY IMPORTANT FIX:
      // Ensure Node uses the SAME kubeconfig kubectl uses.
      const kubeConfigPath = process.env.KUBECONFIG || path.join(os.homedir(), ".kube", "config")

      kc.loadFromFile(kubeConfigPath)

      this.appsApi = kc.makeApiClient(AppsV1Api)
      this.ns = process.env.K8S_NAMESPACE || "default"

      logger.info({
        event: "K8S_INIT_SUCCESS",
        kubeconfig: kubeConfigPath,
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
   * Get current replica count of deployment using kubectl
   */
  async getCurrentReplicas(deployment) {
    console.log(" getCurrentReplicas called with:", {
      deployment,
      type: typeof deployment,
      ns: this.ns,
    })

    if (!deployment) {
      logger.error({
        event: "K8S_GET_FAILED",
        error: "Deployment name is required",
      })
      return 0
    }

    try {
      const cmd = `kubectl get deployment ${deployment} -n ${this.ns} -o jsonpath='{.spec.replicas}'`
      console.log(`Executing: ${cmd}`)
      const { stdout } = await execAsync(cmd)
      console.log(` Raw output: "${stdout}"`)
      const replicas = parseInt(stdout.trim().replace(/'/g, "")) || 0
      console.log(`Parsed replicas: ${replicas}`)

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
        error: err.message,
      })

      return 0
    }
  }

  /**
   * Scale deployment using kubectl command
   */
  async scaleDeployment(deployment, replicas) {
    console.log(" scaleDeployment called with:", {
      deployment,
      type: typeof deployment,
      replicas,
    })

    if (!deployment) {
      const error = "Deployment name is required"
      return {
        deployment,
        previous_replicas: 0,
        required_replicas: replicas,
        status: "FAILED",
        error,
      }
    }

    const previous = await this.getCurrentReplicas(deployment)

    try {
      // Use kubectl scale command directly
      const cmd = `kubectl scale deployment ${deployment} -n ${this.ns} --replicas=${replicas}`
      await execAsync(cmd)

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
        error: err.message,
      })

      return {
        deployment,
        previous_replicas: previous,
        required_replicas: replicas,
        status: "FAILED",
        error: err.message,
      }
    }
  }

  /**
   * Scale deployment incrementally (add to current replicas)
   */
  async scaleDeploymentIncremental(deployment, additionalReplicas) {
    console.log(" scaleDeploymentIncremental called with:", {
      deployment,
      additionalReplicas,
    })

    if (!deployment) {
      const error = "Deployment name is required"
      return {
        deployment,
        previous_replicas: 0,
        required_replicas: additionalReplicas,
        status: "FAILED",
        error,
      }
    }

    const current = await this.getCurrentReplicas(deployment)
    const newTotal = current + additionalReplicas

    console.log(` Incremental scaling: ${current} + ${additionalReplicas} = ${newTotal}`)

    try {
      const cmd = `kubectl scale deployment ${deployment} -n ${this.ns} --replicas=${newTotal}`
      await execAsync(cmd)

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
        error: err.message,
      })

      return {
        deployment,
        previous_replicas: current,
        additional_replicas: additionalReplicas,
        required_replicas: newTotal,
        status: "FAILED",
        error: err.message,
      }
    }
  }
}

export default new K8sExecutor()
