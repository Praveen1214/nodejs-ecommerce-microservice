# Observability Setup (Node/Pod/App/Istio) for ecommerce-test

## Namespaces
- ecommerce-test (apps)
- monitoring (kube-prometheus-stack)
- istio-system (Istio control plane)

## 1) Create monitoring namespace
kubectl apply -f k8s/observability/00-monitoring-ns.yaml

## 2) Install kube-prometheus-stack
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install prometheus prometheus-community/kube-prometheus-stack -n monitoring -f k8s/observability/01-kube-prom-stack-values.yaml

## 3) Fix app services (IMPORTANT)

prom-client install
example :-
cd auth
npm install prom-client

auth/index.js

import express from "express";
import client from "prom-client";

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------
   1) Create Registry
------------------------------------------ */
const register = new client.Registry();

/* ------------------------------------------
   2) Default Node.js metrics
------------------------------------------ */
client.collectDefaultMetrics({
  register,
  prefix: "nodejs_"
});

/* ------------------------------------------
   3) Custom HTTP Histogram
------------------------------------------ */
const httpRequestDurationMs = new client.Histogram({
  name: "http_request_duration_ms",
  help: "Duration of HTTP requests in ms",
  labelNames: ["method", "route", "status_code", "service_name"],
  buckets: [10, 25, 50, 100, 200, 500, 1000, 2000, 5000]
});

register.registerMetric(httpRequestDurationMs);

/* ------------------------------------------
   4) Middleware to measure requests
------------------------------------------ */
app.use((req, res, next) => {
  const end = httpRequestDurationMs.startTimer({
    method: req.method,
    route: req.path,
    service_name: "auth"  // IMPORTANT
  });

  res.on("finish", () => {
    end({ status_code: res.statusCode });
  });

  next();
});

/* ------------------------------------------
   5) Sample route
------------------------------------------ */
app.get("/", (req, res) => {
  res.send("Auth service running");
});

/* ------------------------------------------
   6) Metrics endpoint
------------------------------------------ */
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

/* ------------------------------------------ */
app.listen(PORT, () => {
  console.log(`Auth service running on port ${PORT}`);
});


Ensure each Service has a named port: name: http
Then apply:
kubectl apply -f k8s/test/auth.yaml
kubectl apply -f k8s/test/product.yaml
kubectl apply -f k8s/test/order.yaml
kubectl apply -f k8s/test/api-gateway.yaml

## 4) Apply ServiceMonitors for apps
kubectl apply -f k8s/observability/02-app-servicemonitors.yaml

## 5) Install Istio and enable injection
istioctl install --set profile=demo -y
kubectl label ns ecommerce-test istio-injection=enabled --overwrite
kubectl rollout restart deploy -n ecommerce-test

## 6) Apply ServiceMonitors for Istio
kubectl apply -f k8s/observability/03-istio-servicemonitors.yaml

## 7) Access Prometheus & verify
kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9090:9090
Open: http://localhost:9090/targets

PromQL:
- up{namespace="ecommerce-test"}
- istio_requests_total{destination_workload_namespace="ecommerce-test"}
