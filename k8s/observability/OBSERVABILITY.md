## CONFIGURATIONS

# Target Architecture

Layers :

Node level → Node Exporter (kube-prometheus-stack)
Pod/Container level → cAdvisor/Kubelet metrics (kube-prometheus-stack → kubelet scrape)
App level → prom-client metrics /metrics endpoints (Auth/Product/Order/API Gateway)
Service Mesh level → Istio + Envoy telemetry → Prometheus metrics (istio_requests_total, istio_request_duration_milliseconds, retries, tls errors…)
Graph Centralities → Istio telemetry (source_workload → destination_workload) edges extract per window graph build DC/BC/CC/EC compute

# Folder Structure

k8s/
base/
test/
observability/
00-monitoring-ns.yaml
01-prom-values.yaml
02-servicemonitors.yaml
03-istio-install-steps.txt
04-istio-telemetry-notes.txt

# Step-by-step Deployment

1. _Step 1 — Existing app deploy_
   kubectl get pods -n ecommerce-test

2. _Step 2 — Monitoring Namespace_

File: k8s/observability/00-monitoring-ns.yaml

apiVersion: v1
kind: Namespace
metadata:
name: monitoring
labels:
app: observability

Apply:

Example -
kubectl apply -f k8s/base/namespace-test.yaml
kubectl apply -f k8s/test/secrets.yaml
kubectl apply -f k8s/test/rabbitmq.yaml
kubectl apply -f k8s/test/auth.yaml
kubectl apply -f k8s/test/product.yaml
kubectl apply -f k8s/test/order.yaml
kubectl apply -f k8s/test/api-gateway.yaml

kubectl apply -f k8s/observability/00-monitoring-ns.yaml

3. _Step 3 — kube-prometheus-stack install (Node Exporter + Kubelet/cAdvisor + Prometheus + Grafana)_

**3.1 Helm add/update**
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

**3.2 Values file (scrape interval + ServiceMonitor enable)**

File: k8s/observability/01-prom-values.yaml

prometheus:
prometheusSpec:
scrapeInterval: 15s
evaluationInterval: 15s
serviceMonitorSelectorNilUsesHelmValues: false
podMonitorSelectorNilUsesHelmValues: false

grafana:
enabled: true
adminPassword: admin
service:
type: ClusterIP

Install:
helm install prom prometheus-community/kube-prometheus-stack `  -n monitoring`
-f k8s/observability/01-prom-values.yaml

Wait:
kubectl get pods -n monitoring -w

4. _Step 4 — Istio install + sidecar injection enable (Mesh metrics + Graph edges)_

Command:
istioctl install --set profile=demo -y

injection enable:
kubectl label namespace ecommerce-test istio-injection=enabled --overwrite

Deployments restart:

Example -
kubectl rollout restart deploy/auth -n ecommerce-test
kubectl rollout restart deploy/product -n ecommerce-test
kubectl rollout restart deploy/order -n ecommerce-test
kubectl rollout restart deploy/api-gateway -n ecommerce-test

Check pods have 2 containers (app + istio-proxy):

kubectl get pods -n ecommerce-test
kubectl describe pod <pod-name> -n ecommerce-test | findstr -i "Containers"

5. _Step 5 — App-level metrics (/metrics) enable (Prometheus client)_

**5.1 Node service sample (Auth/Product/Order/API Gateway index.js)**

import client from "prom-client";
import express from "express";

const app = express();

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDurationMs = new client.Histogram({
name: "http_request_duration_ms",
help: "Duration of HTTP requests in ms",
labelNames: ["method", "route", "status_code", "service_name"],
buckets: [10, 25, 50, 100, 200, 500, 1000, 2000, 5000],
});
register.registerMetric(httpRequestDurationMs);

app.use((req, res, next) => {
const end = httpRequestDurationMs.startTimer({
method: req.method,
route: req.path,
service_name: "auth", // service එක අනුව වෙනස් කරන්න
});
res.on("finish", () => end({ status_code: res.statusCode }));
next();
});

app.get("/metrics", async (req, res) => {
res.set("Content-Type", register.contentType);
res.end(await register.metrics());
});

**5.2 Docker image rebuild + push**

6. _Step 6 — Prometheus ServiceMonitors create (App + Istio metrics scrape)_

**6.1 App ServiceMonitors**

File: k8s/observability/02-servicemonitors.yaml

apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
name: sm-auth
namespace: monitoring
spec:
namespaceSelector:
matchNames: - ecommerce-test
selector:
matchLabels:
app: auth
environment: test
endpoints: - port: "3000" # IMPORTANT: service port name දාන්න ඕන
path: /metrics
interval: 15s

---

apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
name: sm-product
namespace: monitoring
spec:
namespaceSelector:
matchNames: - ecommerce-test
selector:
matchLabels:
app: product
environment: test
endpoints: - port: "3001"
path: /metrics
interval: 15s

---

apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
name: sm-order
namespace: monitoring
spec:
namespaceSelector:
matchNames: - ecommerce-test
selector:
matchLabels:
app: order
environment: test
endpoints: - port: "3002"
path: /metrics
interval: 15s

---

apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
name: sm-api-gateway
namespace: monitoring
spec:
namespaceSelector:
matchNames: - ecommerce-test
selector:
matchLabels:
app: api-gateway
environment: test
endpoints: - port: "80"
path: /metrics
interval: 15s

## Important fix (because your Services don't have port names)

For ServiceMonitor, endpoints.port is the "service port name".
So add name: to the ports of auth/product/order services.

For example: k8s/test/auth.yaml service:

ports:

- name: http
  port: 3000
  targetPort: 3000

**6.2 Apply ServiceMonitors**
kubectl apply -f k8s/observability/02-servicemonitors.yaml

7. _Step 7 — Grafana + Prometheus access (verify metrics exist)_
   **Prometheus UI**

kubectl port-forward -n monitoring svc/prom-kube-prometheus-stack-prometheus 9090:9090

Browser:

http://localhost:9090

Grafana UI:

kubectl port-forward -n monitoring svc/prom-grafana 3000:80

8. _PromQL Queries_

1) Node level

**node_cpu_usage_percent**

100 \* (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[1m])))

**node_memory_usage_percent**

100 \* (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))

**node_memory_usage_mb**

(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / 1024 / 1024

**node_network_rx_kbps**

sum by (instance) (rate(node_network_receive_bytes_total[1m])) / 1024

**node_network_tx_kbps**

sum by (instance) (rate(node_network_transmit_bytes_total[1m])) / 1024

**disk read/write iops**

sum by (instance) (rate(node_disk_reads_completed_total[1m]))
sum by (instance) (rate(node_disk_writes_completed_total[1m]))

2. Pod/Container level (cAdvisor / kubelet metrics)

**current_pod_count**

count by (namespace, pod) (kube_pod_info{namespace="ecommerce-test"})

**pod_cpu_usage_percent_avg**

avg by (pod, namespace) (
rate(container_cpu_usage_seconds_total{namespace="ecommerce-test"}[1m])
) \* 100

**pod_memory_usage_mb_avg**

avg by (pod, namespace) (
container_memory_working_set_bytes{namespace="ecommerce-test"}
) / 1024 / 1024

**pod_restart_count**

sum by (pod, namespace) (kube_pod_container_status_restarts_total{namespace="ecommerce-test"})

2. Pod/Container level (cAdvisor / kubelet metrics)

**current_pod_count**

count by (namespace, pod) (kube_pod_info{namespace="ecommerce-test"})

**pod_cpu_usage_percent_avg**

avg by (pod, namespace) (
rate(container_cpu_usage_seconds_total{namespace="ecommerce-test"}[1m])
) \* 100

**pod_memory_usage_mb_avg**

avg by (pod, namespace) (
container_memory_working_set_bytes{namespace="ecommerce-test"}
) / 1024 / 1024

**pod_restart_count**

sum by (pod, namespace) (kube_pod_container_status_restarts_total{namespace="ecommerce-test"})

3. Istio mesh level (Graph edges + request metrics)

**request_rate_rps (service)**

sum by (destination_workload, destination_workload_namespace) (
rate(istio_requests_total{destination_workload_namespace="ecommerce-test"}[1m])
)

**error_rate_percent**

100 \* (
sum by (destination_workload) (rate(istio_requests_total{response_code=~"5..",destination_workload_namespace="ecommerce-test"}[1m]))
/
sum by (destination_workload) (rate(istio_requests_total{destination_workload_namespace="ecommerce-test"}[1m]))
)

**http_4xx_rate_percent / http_5xx_rate_percent**

100 \* sum by (destination_workload) (rate(istio_requests_total{response_code=~"4..",destination_workload_namespace="ecommerce-test"}[1m]))
/
sum by (destination_workload) (rate(istio_requests_total{destination_workload_namespace="ecommerce-test"}[1m]))

100 \* sum by (destination_workload) (rate(istio_requests_total{response_code=~"5..",destination_workload_namespace="ecommerce-test"}[1m]))
/
sum by (destination_workload) (rate(istio_requests_total{destination_workload_namespace="ecommerce-test"}[1m]))

**latency_p50 / p95 / p99 (ms)**
Istio histogram depends on version. query pattern:

histogram_quantile(0.50, sum by (le, destination_workload) (rate(istio_request_duration_milliseconds_bucket{destination_workload_namespace="ecommerce-test"}[1m])))
histogram_quantile(0.95, sum by (le, destination_workload) (rate(istio_request_duration_milliseconds_bucket{destination_workload_namespace="ecommerce-test"}[1m])))
histogram_quantile(0.99, sum by (le, destination_workload) (rate(istio_request_duration_milliseconds_bucket{destination_workload_namespace="ecommerce-test"}[1m])))

9. _Re-deploy full flow_

**App deploy (already)**

**Monitoring stack:**

kubectl apply -f k8s/observability/00-monitoring-ns.yaml
helm install prom prometheus-community/kube-prometheus-stack -n monitoring -f k8s/observability/01-prom-values.yaml

**Istio:**

istioctl install --set profile=demo -y
kubectl label ns ecommerce-test istio-injection=enabled --overwrite
kubectl rollout restart deploy -n ecommerce-test

**Add port names to services + apply**

**Add /metrics in apps + rebuild images + update manifests + apply**

**Apply ServiceMonitors:**

kubectl apply -f k8s/observability/02-servicemonitors.yaml

Verify Prometheus targets:

http://localhost:9090/targets (port-forward after)
