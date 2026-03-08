const express = require("express");
const mongoose = require("mongoose");
const client = require("prom-client");

const config = require("./config");
const MessageBroker = require("./utils/messageBroker");
const productsRouter = require("./routes/productRoutes");
require("dotenv").config();

class App {
  constructor() {
    this.app = express();

    this.initializeMetrics();   // 🔥 Add metrics first
    this.connectDB();
    this.setMiddlewares();
    this.setRoutes();
    this.setupMessageBroker();
  }

  /* ---------------------------------------------------
     METRICS SETUP
  ---------------------------------------------------- */
  initializeMetrics() {
    this.register = new client.Registry();

    // Default Node.js metrics
    client.collectDefaultMetrics({
      register: this.register,
      prefix: "nodejs_"
    });

    // HTTP requests counter (dashboard expects this name)
    this.httpRequestsTotal = new client.Counter({
      name: "http_requests_total",
      help: "Total HTTP requests",
      labelNames: ["status"]
    });

    // HTTP latency histogram (dashboard expects "_milliseconds")
    this.httpRequestDurationMs = new client.Histogram({
      name: "http_request_duration_milliseconds",
      help: "HTTP request duration in milliseconds",
      labelNames: ["method", "route", "status_code", "service_name"],
      buckets: [10, 25, 50, 100, 200, 500, 1000, 2000]
    });

    // Active requests gauge (dashboard expects this)
    this.appQueueLength = new client.Gauge({
      name: "app_queue_length",
      help: "Number of requests currently being processed"
    });

    // HTTP error counter
    this.httpErrorCounter = new client.Counter({
      name: "http_error_total",
      help: "Total HTTP errors",
      labelNames: ["route", "status_code", "service_name"]
    });

    // Business metrics
    this.productCreatedCounter = new client.Counter({
      name: "product_created_total",
      help: "Total products created",
      labelNames: ["service_name"]
    });

    this.productUpdatedCounter = new client.Counter({
      name: "product_updated_total",
      help: "Total products updated",
      labelNames: ["service_name"]
    });

    // RabbitMQ publish counter
    this.rabbitPublishedCounter = new client.Counter({
      name: "rabbitmq_messages_published_total",
      help: "Total RabbitMQ messages published",
      labelNames: ["exchange", "service_name"]
    });

    // RabbitMQ processing latency
    this.rabbitProcessingDuration = new client.Histogram({
      name: "rabbitmq_processing_duration_ms",
      help: "Time taken to process RabbitMQ message",
      labelNames: ["queue", "service_name"],
      buckets: [10, 50, 100, 200, 500, 1000]
    });

    // Register metrics
    this.register.registerMetric(this.httpRequestsTotal);
    this.register.registerMetric(this.httpRequestDurationMs);
    this.register.registerMetric(this.appQueueLength);
    this.register.registerMetric(this.httpErrorCounter);
    this.register.registerMetric(this.productCreatedCounter);
    this.register.registerMetric(this.productUpdatedCounter);
    this.register.registerMetric(this.rabbitPublishedCounter);
    this.register.registerMetric(this.rabbitProcessingDuration);

    // Middleware to track HTTP
    this.app.use((req, res, next) => {
      this.appQueueLength.inc();
      const end = this.httpRequestDurationMs.startTimer({
        method: req.method,
        route: req.path,
        service_name: "product"
      });

      res.on("finish", () => {
        this.appQueueLength.dec();
        const status = res.statusCode.toString();
        end({ status_code: status });
        this.httpRequestsTotal.inc({ status });

        if (res.statusCode >= 400) {
          this.httpErrorCounter.inc({
            route: req.path,
            status_code: status,
            service_name: "product"
          });
        }
      });

      next();
    });

    // Metrics endpoint
    this.app.get("/metrics", async (req, res) => {
      res.set("Content-Type", this.register.contentType);
      res.end(await this.register.metrics());
    });
  }

  /* ---------------------------------------------------
     DATABASE
  ---------------------------------------------------- */
  async connectDB() {
    await mongoose.connect(config.mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("MongoDB connected");
  }

  async disconnectDB() {
    await mongoose.disconnect();
    console.log("MongoDB disconnected");
  }

  /* ---------------------------------------------------
     MIDDLEWARES
  ---------------------------------------------------- */
  setMiddlewares() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: false }));
  }

  /* ---------------------------------------------------
     ROUTES
  ---------------------------------------------------- */
  setRoutes() {

    // Health check
    this.app.get("/health", (req, res) => {
      const dbStatus =
        mongoose.connection.readyState === 1
          ? "connected"
          : "disconnected";

      res.status(dbStatus === "connected" ? 200 : 503).json({
        service: "product",
        status: "healthy",
        timestamp: new Date().toISOString(),
        database: dbStatus,
      });
    });

    // Forward auth requests to auth service (gateway → product → auth)
    this.app.use("/auth", async (req, res) => {
      try {
        const AUTH_URL = process.env.AUTH_SERVICE_URL || "http://auth:3000";
        const options = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
        };
        if (req.headers.authorization) {
          options.headers["Authorization"] = req.headers.authorization;
        }
        if (["POST", "PUT", "PATCH"].includes(req.method)) {
          options.body = JSON.stringify(req.body);
        }
        const response = await fetch(`${AUTH_URL}${req.url}`, options);
        const data = await response.json();
        res.status(response.status).json(data);
      } catch (error) {
        console.error("Auth forwarding error:", error.message);
        res.status(502).json({ message: "Auth service unavailable" });
      }
    });

    // Forward order requests to order service (gateway → product → order)
    this.app.use("/orders", async (req, res) => {
      try {
        const ORDER_URL = process.env.ORDER_SERVICE_URL || "http://order:3002";
        const options = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
        };
        if (req.headers.authorization) {
          options.headers["Authorization"] = req.headers.authorization;
        }
        if (["POST", "PUT", "PATCH"].includes(req.method)) {
          options.body = JSON.stringify(req.body);
        }
        const response = await fetch(`${ORDER_URL}${req.url}`, options);
        const data = await response.json();
        res.status(response.status).json(data);
      } catch (error) {
        console.error("Order forwarding error:", error.message);
        res.status(502).json({ message: "Order service unavailable" });
      }
    });

    // Wrap router to capture business metrics
    this.app.use("/api/products", (req, res, next) => {
      if (req.method === "POST") {
        this.productCreatedCounter.inc({ service_name: "product" });
      }

      if (req.method === "PUT" || req.method === "PATCH") {
        this.productUpdatedCounter.inc({ service_name: "product" });
      }

      next();
    }, productsRouter);
  }

  /* ---------------------------------------------------
     MESSAGE BROKER
  ---------------------------------------------------- */
  setupMessageBroker() {
    const startTimer = this.rabbitProcessingDuration.startTimer({
      queue: config.queueName,
      service_name: "product"
    });

    MessageBroker.connect();

    // increment publish counter example
    this.rabbitPublishedCounter.inc({
      exchange: config.exchangeName,
      service_name: "product"
    });

    startTimer();
  }

  /* ---------------------------------------------------
     START SERVER
  ---------------------------------------------------- */
  start() {
    this.server = this.app.listen(config.port, () =>
      console.log(`Product service started on port ${config.port}`)
    );
  }

  async stop() {
    await mongoose.disconnect();
    this.server.close();
    console.log("Server stopped");
  }
}

module.exports = App;
