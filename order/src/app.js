const express = require("express");
const mongoose = require("mongoose");
const Order = require("./models/order");
const amqp = require("amqplib");
const client = require("prom-client");

const config = require("./config");

const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || "http://product:3001";

class App {
  constructor() {
    this.app = express();

    this.initializeMetrics();   // 🔥 METRICS FIRST
    this.connectDB();
    this.setMiddlewares();
    this.setRoutes();
    this.setupOrderConsumer();
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

    // HTTP latency (dashboard expects "_milliseconds")
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

    // Orders created counter
    this.orderCreatedCounter = new client.Counter({
      name: "order_created_total",
      help: "Total number of orders created",
      labelNames: ["service_name"]
    });

    // RabbitMQ consumed counter
    this.rabbitConsumedCounter = new client.Counter({
      name: "rabbitmq_messages_consumed_total",
      help: "Total RabbitMQ messages consumed",
      labelNames: ["queue", "service_name"]
    });

    // RabbitMQ processing duration
    this.rabbitProcessingDuration = new client.Histogram({
      name: "rabbitmq_processing_duration_ms",
      help: "Time taken to process RabbitMQ message",
      labelNames: ["queue", "service_name"],
      buckets: [10, 50, 100, 200, 500, 1000, 2000]
    });

    this.register.registerMetric(this.httpRequestsTotal);
    this.register.registerMetric(this.httpRequestDurationMs);
    this.register.registerMetric(this.appQueueLength);
    this.register.registerMetric(this.httpErrorCounter);
    this.register.registerMetric(this.orderCreatedCounter);
    this.register.registerMetric(this.rabbitConsumedCounter);
    this.register.registerMetric(this.rabbitProcessingDuration);

    // HTTP Middleware
    this.app.use((req, res, next) => {
      this.appQueueLength.inc();
      const end = this.httpRequestDurationMs.startTimer({
        method: req.method,
        route: req.path,
        service_name: "order"
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
            service_name: "order"
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
    this.app.get("/health", (req, res) => {
      const dbStatus =
        mongoose.connection.readyState === 1
          ? "connected"
          : "disconnected";

      res.status(dbStatus === "connected" ? 200 : 503).json({
        service: "order",
        status: "healthy",
        timestamp: new Date().toISOString(),
        database: dbStatus,
      });
    });

    // HTTP order creation endpoint (called by product service)
    this.app.post("/api/orders/create", async (req, res) => {
      try {
        const { productIds, username, orderId } = req.body;

        // Fetch product details from product service (creates order → product edge)
        const productResponse = await fetch(`${PRODUCT_SERVICE_URL}/api/products/details`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: productIds }),
        });

        if (!productResponse.ok) {
          return res.status(502).json({ message: "Failed to fetch product details" });
        }

        const products = await productResponse.json();

        const newOrder = new Order({
          products,
          user: username,
          totalPrice: products.reduce((acc, p) => acc + (p.price || 0), 0),
        });

        await newOrder.save();
        this.orderCreatedCounter.inc({ service_name: "order" });

        res.status(201).json({
          orderId,
          user: newOrder.user,
          products: newOrder.products,
          totalPrice: newOrder.totalPrice,
          status: "completed",
        });
      } catch (error) {
        console.error("Order creation error:", error.message);
        res.status(500).json({ message: "Server error" });
      }
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
     RABBITMQ CONSUMER
  ---------------------------------------------------- */
  async setupOrderConsumer() {
    console.log("Connecting to RabbitMQ...");

    let connection = null;
    let channel = null;

    while (!connection) {
      try {
        const amqpServer = "amqp://rabbitmq:5672";
        connection = await amqp.connect(amqpServer);
        console.log("Connected to RabbitMQ");

        channel = await connection.createChannel();
        await channel.assertQueue("orders");

        channel.consume("orders", async (data) => {

          const processingTimer = this.rabbitProcessingDuration.startTimer({
            queue: "orders",
            service_name: "order"
          });

          this.rabbitConsumedCounter.inc({
            queue: "orders",
            service_name: "order"
          });

          try {
            const { products, username, orderId } = JSON.parse(data.content);

            const newOrder = new Order({
              products,
              user: username,
              totalPrice: products.reduce((acc, p) => acc + p.price, 0),
            });

            await newOrder.save();

            // increment order created metric
            this.orderCreatedCounter.inc({ service_name: "order" });

            channel.ack(data);

            const { user, products: savedProducts, totalPrice } = newOrder.toJSON();

            channel.sendToQueue(
              "products",
              Buffer.from(
                JSON.stringify({
                  orderId,
                  user,
                  products: savedProducts,
                  totalPrice,
                })
              )
            );

          } catch (err) {
            console.error("Order processing error:", err.message);
          } finally {
            processingTimer();  // stop timer
          }
        });

      } catch (err) {
        console.error("Failed to connect to RabbitMQ:", err.message);
        console.log("Retrying in 5 seconds...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  /* ---------------------------------------------------
     START SERVER
  ---------------------------------------------------- */
  start() {
    this.server = this.app.listen(config.port, () =>
      console.log(`Order service started on port ${config.port}`)
    );
  }

  async stop() {
    await mongoose.disconnect();
    this.server.close();
    console.log("Server stopped");
  }
}

module.exports = App;
