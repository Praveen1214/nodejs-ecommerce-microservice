// Load environment variables FIRST before any other imports
import dotenv from "dotenv";
dotenv.config();

// Export config values for easy access
export const config = {
  EXECUTION_MODE: process.env.EXECUTION_MODE || "LOCAL",
  K8S_NAMESPACE: process.env.K8S_NAMESPACE || "ecommerce-test",
  TEST_NAMESPACE: process.env.TEST_NAMESPACE || "ecommerce-test",
  PROD_NAMESPACE: process.env.PROD_NAMESPACE || "ecommerce-prod",
  KUBECONFIG: process.env.KUBECONFIG,
  RESILIENCE_THRESHOLD: Number(process.env.RESILIENCE_THRESHOLD || 0.7),
  CHAOS_WAIT_MS: Number(process.env.CHAOS_WAIT_MS || 10000),
  UPDATE_YAML_ON_SCALE: process.env.UPDATE_YAML_ON_SCALE === "true",
  ENABLE_CHAOS: process.env.ENABLE_CHAOS === "true",
  AUTO_PROMOTE_TO_PROD: process.env.AUTO_PROMOTE_TO_PROD === "true",
};

console.log("🔧 Config loaded:", {
  AUTO_PROMOTE_TO_PROD: config.AUTO_PROMOTE_TO_PROD,
  K8S_NAMESPACE: config.K8S_NAMESPACE,
  EXECUTION_MODE: config.EXECUTION_MODE,
});
