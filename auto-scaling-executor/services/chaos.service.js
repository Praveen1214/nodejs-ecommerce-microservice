// auto-scaling-executor/services/chaos.service.js

import { KubeConfig, CustomObjectsApi } from "@kubernetes/client-node";
import logger from "../utils/logger.js";
import { chaosInjectionsTotal } from "./prometheus-metrics.service.js";

const CHAOS_GROUP = "chaos-mesh.org";
const CHAOS_VERSION = "v1alpha1";
const CHAOS_PLURAL = "podchaos";

class ChaosService {
  constructor() {
    try {
      const kc = new KubeConfig();
      if (process.env.KUBERNETES_SERVICE_HOST) {
        kc.loadFromCluster();
      } else {
        kc.loadFromDefault();
      }
      this.customApi = kc.makeApiClient(CustomObjectsApi);
      this.ns = process.env.K8S_NAMESPACE || "default";
      logger.info({ event: "CHAOS_K8S_INIT_SUCCESS", namespace: this.ns });
    } catch (err) {
      logger.warn({
        event: "CHAOS_K8S_INIT_FAILED",
        error: err.message,
        hint: "Chaos Mesh operations will fail until K8s API is available",
      });
      this.customApi = null;
    }
  }

  /**
   * Apply PodChaos for given deployment using K8s API
   * Requires Chaos Mesh CRDs installed in the cluster
   */
  async injectPodFailure(deployment) {
    if (!this.customApi) {
      const msg = "K8s CustomObjects API not initialized";
      logger.warn({ event: "CHAOS_SKIP", reason: msg });
      chaosInjectionsTotal.inc({ deployment, status: "failed" });
      return { success: false, error: msg };
    }

    const name = `pod-failure-${deployment}`;
    const body = {
      apiVersion: `${CHAOS_GROUP}/${CHAOS_VERSION}`,
      kind: "PodChaos",
      metadata: { name, namespace: this.ns },
      spec: {
        action: "pod-kill",
        mode: "one",
        selector: {
          namespaces: [this.ns],
          labelSelectors: { app: deployment },
        },
        duration: "20s",
      },
    };

    try {
      // Delete existing chaos resource if present (idempotent)
      await this._deleteSilent(name);

      await this.customApi.createNamespacedCustomObject({
        group: CHAOS_GROUP,
        version: CHAOS_VERSION,
        namespace: this.ns,
        plural: CHAOS_PLURAL,
        body,
      });

      logger.info({ event: "CHAOS_INJECTED", deployment, name });
      chaosInjectionsTotal.inc({ deployment, status: "success" });
      return { success: true };
    } catch (err) {
      const msg = err.body?.message || err.message;
      logger.error({ event: "CHAOS_INJECT_FAILED", deployment, error: msg });
      chaosInjectionsTotal.inc({ deployment, status: "failed" });
      return { success: false, error: msg };
    }
  }

  /**
   * Delete PodChaos for given deployment
   */
  async deleteChaos(deployment) {
    const name = `pod-failure-${deployment}`;
    await this._deleteSilent(name);
  }

  /** Delete a PodChaos custom resource, ignoring 404 */
  async _deleteSilent(name) {
    if (!this.customApi) return;
    try {
      await this.customApi.deleteNamespacedCustomObject({
        group: CHAOS_GROUP,
        version: CHAOS_VERSION,
        namespace: this.ns,
        plural: CHAOS_PLURAL,
        name,
      });
      logger.info({ event: "CHAOS_DELETED", name });
    } catch (err) {
      if (err.statusCode !== 404 && err.response?.statusCode !== 404) {
        logger.warn({ event: "CHAOS_DELETE_FAILED", name, error: err.message });
      }
    }
  }
}

export default new ChaosService();
