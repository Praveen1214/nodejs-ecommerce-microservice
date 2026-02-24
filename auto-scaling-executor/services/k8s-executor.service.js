import { KubeConfig, AppsV1Api } from "@kubernetes/client-node"
import logger from "../utils/logger.js"
import path from "path"
import os from "os"
import { exec } from "child_process"
import { promisify } from "util"
import fs from "fs"
import { fileURLToPath } from "url"
import { dirname } from "path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const execAsync = promisify(exec)

class K8sExecutor {
  constructor() {
    try {
      const kc = new KubeConfig()

      const kubeConfigPath =
        process.env.KUBECONFIG || path.join(os.homedir(), ".kube", "config")

      kc.loadFromFile(kubeConfigPath)

      this.appsApi = kc.makeApiClient(AppsV1Api)

      logger.info({
        event: "K8S_INIT_SUCCESS",
        kubeconfig: kubeConfigPath,
      })
    } catch (err) {
      logger.error({
        event: "K8S_INIT_ERROR",
        error: err.message,
      })
    }
  }

  /**
   * Get current replica count
   */
  async getCurrentReplicas(deployment, namespace) {
    const ns = namespace || process.env.K8S_NAMESPACE || "ecommerce-test"

    console.log(" getCurrentReplicas called with:", {
      deployment,
      type: typeof deployment,
      ns,
    })

    if (!deployment) {
      logger.error({
        event: "K8S_GET_FAILED",
        error: "Deployment name is required",
      })
      return 0
    }

    try {
      const cmd = `kubectl get deployment ${deployment} -n ${ns} -o jsonpath='{.spec.replicas}'`
      console.log(`Executing: ${cmd}`)

      const { stdout } = await execAsync(cmd)

      const replicas = parseInt(stdout.trim().replace(/'/g, "")) || 0

      logger.info({
        event: "K8S_GET_SUCCESS",
        deployment,
        namespace: ns,
        replicas,
      })

      return replicas
    } catch (err) {
      logger.error({
        event: "K8S_GET_FAILED",
        deployment,
        namespace: ns,
        error: err.message,
      })
      return 0
    }
  }

  /**
   * Update YAML manifest file with new replica count
   * This makes scaling persist across ArgoCD syncs
   */
  async updateYamlManifest(deployment, replicas, namespace) {
    if (process.env.UPDATE_YAML_ON_SCALE !== "true") {
      logger.info({
        event: "YAML_UPDATE_SKIPPED",
        reason: "UPDATE_YAML_ON_SCALE not enabled",
      })
      return { updated: false, reason: "Feature disabled" }
    }

    try {
      // Determine environment folder based on namespace
      let envFolder = "test"
      if (namespace.includes("prod")) {
        envFolder = "prod"
      }

      // Construct path to YAML file
      const projectRoot = path.resolve(__dirname, "..", "..")
      const yamlPath = path.join(projectRoot, "k8s", envFolder, `${deployment}.yaml`)

      logger.info({
        event: "YAML_UPDATE_ATTEMPT",
        deployment,
        namespace,
        replicas,
        yamlPath,
      })

      // Check if file exists
      if (!fs.existsSync(yamlPath)) {
        logger.warn({
          event: "YAML_FILE_NOT_FOUND",
          yamlPath,
        })
        return { updated: false, reason: "YAML file not found" }
      }

      // Read current YAML content
      let yamlContent = fs.readFileSync(yamlPath, "utf8")

      // Update replicas using regex
      // This matches "replicas: <number>" in the Deployment spec
      const replicasRegex = /(kind:\s*Deployment[\s\S]*?spec:\s*\n\s*replicas:\s*)(\d+)/
      const match = yamlContent.match(replicasRegex)

      if (!match) {
        logger.warn({
          event: "YAML_REPLICAS_FIELD_NOT_FOUND",
          yamlPath,
        })
        return { updated: false, reason: "Replicas field not found in YAML" }
      }

      const oldReplicas = match[2]
      yamlContent = yamlContent.replace(replicasRegex, `$1${replicas}`)

      // Write updated content
      fs.writeFileSync(yamlPath, yamlContent, "utf8")

      logger.info({
        event: "YAML_UPDATED_SUCCESS",
        deployment,
        namespace,
        yamlPath,
        oldReplicas: parseInt(oldReplicas),
        newReplicas: replicas,
      })

      return {
        updated: true,
        yamlPath,
        oldReplicas: parseInt(oldReplicas),
        newReplicas: replicas,
      }
    } catch (err) {
      logger.error({
        event: "YAML_UPDATE_FAILED",
        deployment,
        namespace,
        error: err.message,
      })
      return { updated: false, reason: err.message }
    }
  }

  /**
   * Scale deployment to exact replica count
   */
  async scaleDeployment(deployment, replicas, namespace) {
    const ns = namespace || process.env.K8S_NAMESPACE || "ecommerce-test"

    console.log(" scaleDeployment called with:", {
      deployment,
      replicas,
      ns,
    })

    if (!deployment) {
      return {
        deployment,
        previous_replicas: 0,
        required_replicas: replicas,
        status: "FAILED",
        error: "Deployment name is required",
      }
    }

    const previous = await this.getCurrentReplicas(deployment, ns)

    try {
      const cmd = `kubectl scale deployment ${deployment} -n ${ns} --replicas=${replicas}`
      await execAsync(cmd)

      logger.info({
        event: "SCALING_EXECUTED_K8S",
        deployment,
        namespace: ns,
        previous_replicas: previous,
        required_replicas: replicas,
        status: "SUCCESS",
      })

      // Update YAML manifest to persist the change
      const yamlUpdate = await this.updateYamlManifest(deployment, replicas, ns)

      return {
        deployment,
        previous_replicas: previous,
        required_replicas: replicas,
        status: "SUCCESS",
        yamlUpdate,
      }
    } catch (err) {
      logger.error({
        event: "SCALING_FAILED_K8S",
        deployment,
        namespace: ns,
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
   * Incremental scaling
   */
  async scaleDeploymentIncremental(deployment, additionalReplicas, namespace) {
    const ns = namespace || process.env.K8S_NAMESPACE || "ecommerce-test"

    console.log(" scaleDeploymentIncremental called with:", {
      deployment,
      additionalReplicas,
      ns,
    })

    if (!deployment) {
      return {
        deployment,
        previous_replicas: 0,
        required_replicas: additionalReplicas,
        status: "FAILED",
        error: "Deployment name is required",
      }
    }

    const current = await this.getCurrentReplicas(deployment, ns)
    const newTotal = current + additionalReplicas

    console.log(
      ` Incremental scaling: ${current} + ${additionalReplicas} = ${newTotal}`
    )

    try {
      const cmd = `kubectl scale deployment ${deployment} -n ${ns} --replicas=${newTotal}`
      await execAsync(cmd)

      logger.info({
        event: "SCALING_EXECUTED_K8S_INCREMENTAL",
        deployment,
        namespace: ns,
        previous_replicas: current,
        additional_replicas: additionalReplicas,
        required_replicas: newTotal,
        status: "SUCCESS",
      })

      // Update YAML manifest to persist the change
      const yamlUpdate = await this.updateYamlManifest(deployment, newTotal, ns)

      return {
        deployment,
        previous_replicas: current,
        additional_replicas: additionalReplicas,
        required_replicas: newTotal,
        status: "SUCCESS",
        yamlUpdate,
      }
    } catch (err) {
      logger.error({
        event: "SCALING_FAILED_K8S_INCREMENTAL",
        deployment,
        namespace: ns,
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