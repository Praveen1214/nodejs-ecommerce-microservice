const express = require("express");
const httpProxy = require("http-proxy");
const http = require("http");

const proxy = httpProxy.createProxyServer();
const app = express();

// Health check endpoint
app.get("/health", async (req, res) => {
  const services = {
    "api-gateway": { status: "healthy", port: process.env.PORT || 3003 },
    auth: { status: "unknown", url: "http://auth:3000/health" },
    product: { status: "unknown", url: "http://product:3001/health" },
    order: { status: "unknown", url: "http://order:3002/health" },
  };

  // Check downstream services
  const checkService = (name, url) => {
    return new Promise((resolve) => {
      const req = http.get(url, { timeout: 2000 }, (response) => {
        services[name].status = response.statusCode === 200 ? "healthy" : "unhealthy";
        resolve();
      });
      req.on("error", () => {
        services[name].status = "unhealthy";
        resolve();
      });
      req.on("timeout", () => {
        services[name].status = "timeout";
        req.destroy();
        resolve();
      });
    });
  };

  await Promise.all([
    checkService("auth", services.auth.url),
    checkService("product", services.product.url),
    checkService("order", services.order.url),
  ]);

  const allHealthy = Object.values(services).every((s) => s.status === "healthy");
  
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    services,
  });
});

// Route requests to the auth service
app.use("/auth", (req, res) => {
  proxy.web(req, res, { target: "http://auth:3000" });
});

// Route requests to the product service
app.use("/products", (req, res) => {
  proxy.web(req, res, { target: "http://product:3001" });
});

// Route requests to the order service
app.use("/orders", (req, res) => {
  proxy.web(req, res, { target: "http://order:3002" });
});

// Start the server
const port = process.env.PORT || 3003;
app.listen(port, () => {
  console.log(`API Gateway listening on port ${port}`);
});
