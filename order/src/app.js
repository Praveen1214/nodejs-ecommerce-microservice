const express = require("express");
const mongoose = require("mongoose");
const Order = require("./models/order");
const amqp = require("amqplib");
const client = require("prom-client");

const config = require("./config");

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

    // HTTP latency
    this.httpRequestDurationMs = new client.Histogram({
      name: "http_request_duration_ms",
      help: "HTTP request duration in ms",
      labelNames: ["method", "route", "status_code", "service_name"],
      buckets: [10, 25, 50, 100, 200, 500, 1000, 2000]
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

    this.register.registerMetric(this.httpRequestDurationMs);
    this.register.registerMetric(this.httpErrorCounter);
    this.register.registerMetric(this.orderCreatedCounter);
    this.register.registerMetric(this.rabbitConsumedCounter);
    this.register.registerMetric(this.rabbitProcessingDuration);

    // HTTP Middleware
    this.app.use((req, res, next) => {
      const end = this.httpRequestDurationMs.startTimer({
        method: req.method,
        route: req.path,
        service_name: "order"
      });

      res.on("finish", () => {
        end({ status_code: res.statusCode });

        if (res.statusCode >= 400) {
          this.httpErrorCounter.inc({
            route: req.path,
            status_code: res.statusCode,
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
