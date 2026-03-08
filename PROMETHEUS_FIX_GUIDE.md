# Prometheus Scraping Fix - Deployment Guide

## Issues Fixed

### 1. Port Configuration Issues

- **Auth Service**: Port was hardcoded to 3000, now reads from `PORT` environment variable
- **Order Service**: Port was hardcoded to 3002, now reads from `PORT` environment variable
- **Product Service**: Already configured correctly
- **API Gateway**: Already configured correctly

### 2. Missing Health Probes

Added **liveness** and **readiness** probes to all services in both test and prod environments:

- Liveness probe: Checks if the service is healthy (restarts if unhealthy)
- Readiness probe: Checks if the service is ready to receive traffic (critical for Prometheus)

Without readiness probes, Kubernetes doesn't know when pods are ready, causing Prometheus scraping to fail.

## Files Modified

### Application Code

1. `auth/src/config/index.js` - Added port configuration
2. `auth/src/app.js` - Updated to use port from config
3. `order/src/config.js` - Updated to read PORT from environment

### Kubernetes Deployments (Test Environment)

4. `k8s/test/auth.yaml` - Added health probes
5. `k8s/test/product.yaml` - Added health probes
6. `k8s/test/order.yaml` - Added health probes
7. `k8s/test/api-gateway.yaml` - Added health probes

### Kubernetes Deployments (Production Environment)

8. `k8s/prod/auth.yaml` - Added health probes
9. `k8s/prod/product.yaml` - Added health probes
10. `k8s/prod/order.yaml` - Added health probes
11. `k8s/prod/api-gateway.yaml` - Added health probes

## Deployment Steps

### Step 1: Rebuild Docker Images

Since we modified the application code, you need to rebuild the Docker images:

```bash
# Build auth service
docker build -t praveen1214/auth-service:latest ./auth

# Build order service
docker build -t praveen1214/order-service:latest ./order

# Build product service (optional, no changes but for consistency)
docker build -t praveen1214/product-service:latest ./product

# Build api-gateway (optional, no changes but for consistency)
docker build -t praveen1214/api-gateway-service:latest ./api-gateway
```

### Step 2: Push Images to Docker Hub

```bash
docker push praveen1214/auth-service:latest
docker push praveen1214/order-service:latest
docker push praveen1214/product-service:latest
docker push praveen1214/api-gateway-service:latest
```

### Step 3: Apply Updated Kubernetes Manifests

```bash
# Apply test environment
kubectl apply -f k8s/test/auth.yaml
kubectl apply -f k8s/test/product.yaml
kubectl apply -f k8s/test/order.yaml
kubectl apply -f k8s/test/api-gateway.yaml

# Or apply all at once
kubectl apply -f k8s/test/
```

### Step 4: Wait for Pods to be Ready

Monitor the pods to ensure they become ready:

```bash
# Watch pod status
kubectl get pods -n ecommerce-test -w

# Check readiness status
kubectl get pods -n ecommerce-test -o wide

# All pods should show:
# READY: 1/1
# STATUS: Running
```

### Step 5: Verify Health Endpoints

Test that the health endpoints are working:

```bash
# Port-forward to test each service
kubectl port-forward -n ecommerce-test svc/auth 3000:3000
kubectl port-forward -n ecommerce-test svc/product 3001:3001
kubectl port-forward -n ecommerce-test svc/order 3002:3002
kubectl port-forward -n ecommerce-test svc/api-gateway 3003:3003

# In another terminal, test endpoints:
curl http://localhost:3000/health
curl http://localhost:3000/metrics

curl http://localhost:3001/health
curl http://localhost:3001/metrics

curl http://localhost:3002/health
curl http://localhost:3002/metrics

curl http://localhost:3003/health
curl http://localhost:3003/metrics
```

All should return:

- `/health` - Status 200 with service health info
- `/metrics` - Status 200 with Prometheus metrics

### Step 6: Verify Prometheus Scraping

1. Access Prometheus UI (port-forward if needed):

   ```bash
   kubectl port-forward -n monitoring svc/prometheus-operated 9090:9090
   ```

2. Open browser: `http://localhost:9090`

3. Go to **Status > Targets**

4. Look for your services in the list. They should now show:
   - **State**: UP (green)
   - **up** metric should be **1** instead of **0**

5. Test a query in Prometheus:
   ```promql
   up{namespace="ecommerce-test"}
   ```
   All services should return `1`

### Step 7: Verify Metrics Collection

Run these queries in Prometheus to verify metrics are being collected:

```promql
# Check if services are up
up{namespace="ecommerce-test"}

# HTTP request duration
http_request_duration_ms_count{namespace="ecommerce-test"}

# HTTP errors
http_error_total{namespace="ecommerce-test"}

# Node.js metrics
nodejs_heap_size_used_bytes{namespace="ecommerce-test"}
```

## Troubleshooting

### If pods are not ready:

```bash
# Check pod logs
kubectl logs -n ecommerce-test <pod-name>

# Check pod events
kubectl describe pod -n ecommerce-test <pod-name>

# Common issues:
# - MongoDB connection failed (check MONGODB_*_URI secrets)
# - RabbitMQ connection failed (check RABBITMQ_URL secret)
```

### If Prometheus still shows up=0:

1. **Check ServiceMonitor labels**:

   ```bash
   kubectl get servicemonitor -n monitoring -o yaml
   ```

   Ensure they have `release: prometheus` label

2. **Check Service labels**:

   ```bash
   kubectl get svc -n ecommerce-test --show-labels
   ```

   Ensure services have correct `app` and `environment` labels

3. **Check Prometheus config**:

   ```bash
   kubectl logs -n monitoring prometheus-kube-prometheus-stack-0
   ```

   Look for scrape config errors

4. **Test metrics endpoint directly from Prometheus pod**:
   ```bash
   kubectl exec -n monitoring prometheus-kube-prometheus-stack-0 -- wget -O- http://auth.ecommerce-test.svc.cluster.local:3000/metrics
   ```

## Expected Results

After deployment, you should see in Prometheus:

```
up{container="api-gateway", endpoint="http", instance="...", job="api-gateway", namespace="ecommerce-test", ...}  1
up{container="product", endpoint="http", instance="...", job="product", namespace="ecommerce-test", ...}  1
up{container="auth", endpoint="http", instance="...", job="auth", namespace="ecommerce-test", ...}  1
up{container="order", endpoint="http", instance="...", job="order", namespace="ecommerce-test", ...}  1
```

All services should show **1** (up) instead of **0** (down).

## Health Probe Configuration

The added probes:

### Readiness Probe

- **Path**: `/health`
- **Initial Delay**: 10 seconds (gives app time to start)
- **Period**: 5 seconds (checks every 5 seconds)
- **Timeout**: 3 seconds
- **Failure Threshold**: 3 attempts
- **Purpose**: Tells Kubernetes when pod is ready for traffic (including Prometheus scraping)

### Liveness Probe

- **Path**: `/health`
- **Initial Delay**: 30 seconds (gives MongoDB time to connect)
- **Period**: 10 seconds
- **Timeout**: 5 seconds
- **Failure Threshold**: 3 attempts
- **Purpose**: Restarts pod if it becomes unhealthy

## Next Steps

After successful deployment:

1. ✅ Verify all pods are ready: `kubectl get pods -n ecommerce-test`
2. ✅ Check Prometheus targets show UP
3. ✅ Verify metrics are being collected
4. ✅ Create Grafana dashboards to visualize metrics
5. ✅ Set up alerts based on metrics

---

**Note**: If you're using a CI/CD pipeline, update the image tags in the deployment YAMLs to match your versioning scheme.
