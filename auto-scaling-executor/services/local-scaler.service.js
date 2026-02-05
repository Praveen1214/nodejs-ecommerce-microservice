import logger from "../utils/logger.js";

class LocalScaler {
  constructor() {
    this.services = {};
  }

  simulateScaling(deployment, replicas) {
    const previous = this.services[deployment]?.current ?? 0;

    this.services[deployment] = { current: replicas };

    // MANDATORY SCALING LOG
    logger.info({
      event: "SCALING_EXECUTED_LOCAL",
      deployment,
      previous_replicas: previous,
      required_replicas: replicas,
      status: "SUCCESS"
    });

    return {
      deployment,
      previous_replicas: previous,
      required_replicas: replicas,
      status: "SUCCESS",
      message: "Scaled locally (simulation only)"
    };
  }
}

export default new LocalScaler();
