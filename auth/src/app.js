const express = require("express");
const mongoose = require("mongoose");
const client = require("prom-client");
const jwt = require("jsonwebtoken");

const config = require("./config");
const authMiddleware = require("./middlewares/authMiddleware");
const AuthController = require("./controllers/authController");

class App {
  constructor() {
    this.app = express();
    this.authController = new AuthController();

    this.initializeMetrics();   // 🔥 NEW
    this.connectDB();
    this.setMiddlewares();
    this.setRoutes();
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
     METRICS SETUP
  ---------------------------------------------------- */
  initializeMetrics() {
    this.register = new client.Registry();

    // Default Node.js metrics
    client.collectDefaultMetrics({
      register: this.register,
      prefix: "nodejs_"
    });

    // HTTP requests counter (dashboard expects this name with "status" label)
    this.httpRequestsTotal = new client.Counter({
      name: "http_requests_total",
      help: "Total HTTP requests",
      labelNames: ["status"]
    });

    // HTTP Request Duration Histogram (dashboard expects "_milliseconds")
    this.httpRequestDurationMs = new client.Histogram({
      name: "http_request_duration_milliseconds",
      help: "HTTP request duration in milliseconds",
      labelNames: ["method", "route", "status_code", "service_name"],
      buckets: [10, 25, 50, 100, 200, 500, 1000, 2000, 5000]
    });

    // Active requests gauge (dashboard expects this)
    this.appQueueLength = new client.Gauge({
      name: "app_queue_length",
      help: "Number of requests currently being processed"
    });

    // HTTP Error Counter
    this.httpErrorCounter = new client.Counter({
      name: "http_error_total",
      help: "Total number of HTTP errors",
      labelNames: ["route", "status_code", "service_name"]
    });

    this.register.registerMetric(this.httpRequestsTotal);
    this.register.registerMetric(this.httpRequestDurationMs);
    this.register.registerMetric(this.appQueueLength);
    this.register.registerMetric(this.httpErrorCounter);

    // 🔥 Metrics Middleware
    this.app.use((req, res, next) => {
      this.appQueueLength.inc();
      const end = this.httpRequestDurationMs.startTimer({
        method: req.method,
        route: req.path,
        service_name: "auth"
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
            service_name: "auth"
          });
        }
      });

      next();
    });

    // 🔥 Metrics endpoint
    this.app.get("/metrics", async (req, res) => {
      res.set("Content-Type", this.register.contentType);
      res.end(await this.register.metrics());
    });
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
        service: "auth",
        status: "healthy",
        timestamp: new Date().toISOString(),
        database: dbStatus,
      });
    });

    this.app.post("/login", (req, res) =>
      this.authController.login(req, res)
    );

    this.app.post("/register", (req, res) =>
      this.authController.register(req, res)
    );

    // Token verification endpoint for inter-service auth
    this.app.post("/verify", (req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ valid: false, message: "No token" });
      }
      const token = authHeader.split(" ")[1];
      try {
        const decoded = jwt.verify(token, config.jwtSecret);
        res.json({ valid: true, user: decoded });
      } catch (err) {
        res.status(401).json({ valid: false, message: "Invalid token" });
      }
    });

    this.app.get(
      "/dashboard",
      authMiddleware,
      (req, res) =>
        res.json({ message: "Welcome to dashboard" })
    );
  }

  /* ---------------------------------------------------
     SERVER START
  ---------------------------------------------------- */
  start() {
    this.server = this.app.listen(config.port, () =>
      console.log(`Auth service started on port ${config.port}`)
    );
  }

  async stop() {
    await mongoose.disconnect();
    this.server.close();
    console.log("Server stopped");
  }
}

module.exports = App;
