// MUST BE FIRST
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import cors from "cors";
import { initSocket } from "./realtime/socket.js";
import connectDB from "./db/mongodb.js";

// IMPORTS MUST COME AFTER dotenv.config
import scaleRoutes from "./api/scale.controller.js";
import scaleMetricsRoutes from "./api/scale-with-metrics.controller.js";
import scalingLogsRoutes from "./api/scaling-logs.controller.js";
import alertsRoutes from "./api/alerts.controller.js";
import alertsSSERoutes from "./api/alerts-sse.controller.js";
import chaosRoutes from "./api/chaos.controller.js";
import deploymentHealthRoutes from "./api/deployment-health.controller.js";
import predictionRoutes from "./api/prediction.controller.js";
import deploymentHealthService from "./services/deployment-health.service.js";
import PredictionService from "./services/prediction.service.js";

console.log("EXECUTION_MODE =", process.env.EXECUTION_MODE);

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/v1", scaleRoutes);
app.use("/api/v1", scaleMetricsRoutes);
app.use("/api/v1", scalingLogsRoutes);
app.use("/api/v1", alertsRoutes);
app.use("/api/v1", alertsSSERoutes);
app.use("/api/v1", chaosRoutes);
app.use("/api/v1", deploymentHealthRoutes);
app.use("/api/v1", predictionRoutes);

const startServer = async () => {
  await connectDB();

  const server = http.createServer(app);
  initSocket(server);

  // Deployment health service disabled - only captures on-demand after scaling
  // deploymentHealthService.start();

  server.listen(6000, () => {
    console.log("🚀 Auto Scaling Executor running on port 6000");
    console.log("📊 Deployment health: Real-time streaming only (no DB storage)");
    console.log("🤖 ML Prediction endpoints: /api/v1/prediction/*");

    // Auto-start prediction controller if configured
    if (process.env.AUTO_START_PREDICTION === "true") {
      console.log("🔄 Auto-starting prediction controller...");
      PredictionService.startLoop({
        intervalSec: parseInt(process.env.PREDICTION_INTERVAL) || 60,
        maxSteps:    process.env.PREDICTION_MAX_STEPS ? parseInt(process.env.PREDICTION_MAX_STEPS) : null,
        dryRun:      process.env.PREDICTION_DRY_RUN === "true",
        startOffset: parseInt(process.env.PREDICTION_START_OFFSET) || 0,
        validate:    process.env.PREDICTION_VALIDATE === "true",
        serviceId:   process.env.PREDICTION_SERVICE_ID || "Order",
      }).catch((err) => console.error("❌ Prediction auto-start failed:", err.message));
    }
  });
};

startServer();
