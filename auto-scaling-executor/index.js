// MUST BE FIRST — "dotenv/config" auto-calls dotenv.config() during
// module evaluation, BEFORE other imports' constructors run.
// (Regular `dotenv.config()` runs too late with ESM hoisting.)
import "dotenv/config";

import express from "express";
import scaleRoutes from "./api/scale.controller.js";
import scaleMetricsRoutes from "./api/scale-with-metrics.controller.js";
import { registerCollectorRoutes } from "./api/collector.controller.js";
import FeatureCollector from "./services/feature-collector.service.js";
import { register as promRegister } from "./services/prometheus-metrics.service.js";

console.log("EXECUTION_MODE =", process.env.EXECUTION_MODE);

const app = express();
app.use(express.json());

app.use("/api/v1", scaleRoutes);
app.use("/api/v1", scaleMetricsRoutes);

// Feature Collector control endpoints
registerCollectorRoutes(app);

// Prometheus metrics endpoint — scraped by Prometheus every 15s
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", promRegister.contentType);
  res.end(await promRegister.metrics());
});

app.listen(6000, () => {
  console.log("Auto Scaling Executor running on port 6000");

  // Auto-start the feature collector if configured
  if (process.env.AUTO_COLLECT === "true") {
    console.log("AUTO_COLLECT=true → Starting Feature Collector automatically...");
    FeatureCollector.start();
  } else {
    console.log("Feature Collector ready. Start it via POST /api/v1/collector/start");
  }
});
