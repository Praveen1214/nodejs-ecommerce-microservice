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

const startServer = async () => {
  await connectDB();

  const server = http.createServer(app);
  initSocket(server);

  server.listen(6000, () => {
    console.log("🚀 Auto Scaling Executor running on port 6000");
  });
};

startServer();
