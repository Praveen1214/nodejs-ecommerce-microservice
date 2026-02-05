// MUST BE FIRST
import dotenv from "dotenv";
dotenv.config();

import express from "express";

// IMPORTS MUST COME AFTER dotenv.config
import scaleRoutes from "./api/scale.controller.js";
import scaleMetricsRoutes from "./api/scale-with-metrics.controller.js";

console.log("EXECUTION_MODE =", process.env.EXECUTION_MODE);

const app = express();
app.use(express.json());

app.use("/api/v1", scaleRoutes);
app.use("/api/v1", scaleMetricsRoutes);

app.listen(6000, () => {
  console.log("Auto Scaling Executor running on port 6000");
});
