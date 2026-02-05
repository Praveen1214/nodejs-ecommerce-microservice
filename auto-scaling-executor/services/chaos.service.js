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
   */
  async injectPodFailure(deployment) {
    try {
      const templatePath = path.join(
        process.cwd(),
        "infra",
        "chaos",
        "pod-failure-template.yaml"
      );

      let yaml = fs.readFileSync(templatePath, "utf8");
      yaml = yaml.replace(/{{DEPLOYMENT}}/g, deployment);

      const tempFile = path.join(
        process.cwd(),
        `chaos-${deployment}-pod-failure.yaml`
      );
      fs.writeFileSync(tempFile, yaml);

      const cmd = `kubectl apply -f "${tempFile}"`;
      
      await execAsync(cmd);

      console.log(`⚡ Chaos injected for deployment: ${deployment}`);
      return { success: true };
    } catch (err) {
      console.error("Chaos injection failed:", err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Delete PodChaos for given deployment (if exists)
   */
  async deleteChaos(deployment) {
    try {
      const cmd = `kubectl delete podchaos pod-failure-${deployment} -n default --ignore-not-found`;
      await execAsync(cmd);
      console.log(`🧹 Chaos cleared for deployment: ${deployment}`);
    } catch (err) {
      console.error("Chaos cleanup failed:", err.message);
    }
  }
}

export default new ChaosService();
