const express = require("express");
const httpProxy = require("http-proxy");
const http = require("http");
const client = require("prom-client");

const proxy = httpProxy.createProxyServer();
const app = express();

/* ---------------------------------------------------
   METRICS SETUP
---------------------------------------------------- */

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: "nodejs_" });

// HTTP requests counter (dashboard expects this name)
const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["status"],
});

// HTTP latency (dashboard expects "_milliseconds")
const httpRequestDurationMs = new client.Histogram({
  name: "http_request_duration_milliseconds",
  help: "HTTP request duration in milliseconds",
  labelNames: ["method", "route", "status_code", "service_name"],
  buckets: [10, 25, 50, 100, 200, 500, 1000, 2000],
});

// Active requests gauge (dashboard expects this)
const appQueueLength = new client.Gauge({
  name: "app_queue_length",
  help: "Number of requests currently being processed",
});

// HTTP errors
const httpErrorCounter = new client.Counter({
  name: "http_error_total",
  help: "Total HTTP errors",
  labelNames: ["route", "status_code", "service_name"],
});

// Proxy request counter
const proxyRequestCounter = new client.Counter({
  name: "gateway_proxy_requests_total",
  help: "Total proxied requests",
  labelNames: ["target_service"],
});

// Downstream latency
const downstreamLatency = new client.Histogram({
  name: "gateway_downstream_latency_ms",
  help: "Downstream service latency",
  labelNames: ["target_service"],
  buckets: [10, 50, 100, 200, 500, 1000, 2000],
});

register.registerMetric(httpRequestsTotal);
register.registerMetric(httpRequestDurationMs);
register.registerMetric(appQueueLength);
register.registerMetric(httpErrorCounter);
register.registerMetric(proxyRequestCounter);
register.registerMetric(downstreamLatency);

// HTTP Middleware
app.use((req, res, next) => {
  appQueueLength.inc();
  const end = httpRequestDurationMs.startTimer({
    method: req.method,
    route: req.path,
    service_name: "api-gateway",
  });

  res.on("finish", () => {
    appQueueLength.dec();
    const status = res.statusCode.toString();
    end({ status_code: status });
    httpRequestsTotal.inc({ status });

    if (res.statusCode >= 400) {
      httpErrorCounter.inc({
        route: req.path,
        status_code: status,
        service_name: "api-gateway",
      });
    }
  });

  next();
});

// Metrics endpoint
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

/* ---------------------------------------------------
   HEALTH CHECK
---------------------------------------------------- */

app.get("/health", async (req, res) => {
  const services = {
    "api-gateway": { status: "healthy", port: process.env.PORT || 3003 },
    auth: { status: "unknown", url: "http://auth:3000/health" },
    product: { status: "unknown", url: "http://product:3001/health" },
    order: { status: "unknown", url: "http://order:3002/health" },
  };

  const checkService = (name, url) => {
    return new Promise((resolve) => {
      const timer = downstreamLatency.startTimer({ target_service: name });

      const req = http.get(url, { timeout: 2000 }, (response) => {
        services[name].status =
          response.statusCode === 200 ? "healthy" : "unhealthy";
        timer();
        resolve();
      });

      req.on("error", () => {
        services[name].status = "unhealthy";
        timer();
        resolve();
      });

      req.on("timeout", () => {
        services[name].status = "timeout";
        req.destroy();
        timer();
        resolve();
      });
    });
  };

  await Promise.all([
    checkService("auth", services.auth.url),
    checkService("product", services.product.url),
    checkService("order", services.order.url),
  ]);

  const allHealthy = Object.values(services).every(
    (s) => s.status === "healthy"
  );

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    services,
  });
});

/* ---------------------------------------------------
   PROXY ROUTES
---------------------------------------------------- */

app.use("/auth", (req, res) => {
  proxyRequestCounter.inc({ target_service: "product" });
  req.url = "/auth" + req.url;
  proxy.web(req, res, { target: "http://product:3001" });
});

app.use("/products", (req, res) => {
  proxyRequestCounter.inc({ target_service: "product" });
  proxy.web(req, res, { target: "http://product:3001" });
});

app.use("/orders", (req, res) => {
  proxyRequestCounter.inc({ target_service: "product" });
  req.url = "/orders" + req.url;
  proxy.web(req, res, { target: "http://product:3001" });
});

/* ---------------------------------------------------
   START SERVER
---------------------------------------------------- */

const port = process.env.PORT || 3003;
app.listen(port, () => {
  console.log(`API Gateway listening on port ${port}`);
});
