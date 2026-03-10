// auto-scaling-executor/services/chaos.service.js

import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);

class ChaosService {
  /**
   * Apply PodChaos for given deployment
   * Requires:
   *  - Chaos Mesh installed in the cluster
   *  - infra/chaos/pod-failure-template.yaml present
   * 
   * Returns: { success, startTime, affectedPods, experimentName }
   */
  async injectPodFailure(deployment, namespace) {
    // Check if chaos is enabled
    if (process.env.ENABLE_CHAOS !== "true") {
      console.log("⏭️  Chaos testing disabled (ENABLE_CHAOS=false)");
      return { success: false, skipped: true };
    }

    const ns = namespace || process.env.K8S_NAMESPACE || "ecommerce-test";
    const startTime = new Date();
    const experimentName = `pod-failure-${deployment}`;

    try {
      const templatePath = path.join(
        process.cwd(),
        "infra",
        "chaos",
        "pod-failure-template.yaml"
      );

      let yaml = fs.readFileSync(templatePath, "utf8");
      yaml = yaml.replace(/{{DEPLOYMENT}}/g, deployment);
      yaml = yaml.replace(/{{NAMESPACE}}/g, ns);

      const tempFile = path.join(
        process.cwd(),
        `chaos-${deployment}-pod-failure.yaml`
      );
      fs.writeFileSync(tempFile, yaml);

      const cmd = `kubectl apply -f "${tempFile}"`;
      
      await execAsync(cmd);

      // Get affected pods count
      const affectedPods = await this.getAffectedPodsCount(deployment, ns);

      console.log(`⚡ Chaos injected for deployment: ${deployment}, affected pods: ${affectedPods}`);
      return { 
        success: true, 
        startTime, 
        affectedPods,
        experimentName 
      };
    } catch (err) {
      console.error("Chaos injection failed:", err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Get count of pods affected by chaos
   */
  async getAffectedPodsCount(deployment, namespace) {
    try {
      const cmd = `kubectl get pods -n ${namespace} -l app=${deployment} --no-headers -o name`;
      const { stdout } = await execAsync(cmd);
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      return lines.length;
    } catch (err) {
      console.error("Failed to get affected pods count:", err.message);
      return 0;
    }
  }

  /**
   * Get restart count for pods in deployment
   */
  async getRestartCount(deployment, namespace) {
    try {
      const cmd = `kubectl get pods -n ${namespace} -l app=${deployment} -o jsonpath='{range .items[*]}{.status.containerStatuses[*].restartCount}{" "}{end}'`;
      const { stdout } = await execAsync(cmd);
      
      const restarts = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
      const totalRestarts = restarts.reduce((sum, count) => sum + count, 0);
      
      return totalRestarts;
    } catch (err) {
      console.error("Failed to get restart count:", err.message);
      return 0;
    }
  }

  /**
   * Delete PodChaos for given deployment (if exists)
   * Returns: { endTime, restartCount }
   */
  async deleteChaos(deployment, namespace) {
    const ns = namespace || process.env.K8S_NAMESPACE || "ecommerce-test";
    const endTime = new Date();
    
    try {
      // Get restart count before cleaning up
      const restartCount = await this.getRestartCount(deployment, ns);
      
      const cmd = `kubectl delete podchaos pod-failure-${deployment} -n ${ns} --ignore-not-found`;
      await execAsync(cmd);
      console.log(`🧹 Chaos cleared for deployment: ${deployment}, restarts: ${restartCount}`);
      
      return { endTime, restartCount };
    } catch (err) {
      console.error("Chaos cleanup failed:", err.message);
      return { endTime, restartCount: 0 };
    }
  }
}

export default new ChaosService();
