# Auto-Scaling Executor

The **Auto-Scaling Executor** is the core execution engine responsible for dynamically scaling microservices in Kubernetes clusters. It provides intelligent scaling decisions with optional metrics validation, chaos testing, and automatic rollback capabilities.

## Overview

The executor operates as an Express.js service that:

- Listens on **port 6000** for scaling requests
- Executes scaling actions against Kubernetes deployments
- Validates scaling decisions using metrics and resilience scores
- Performs chaos engineering tests to ensure system stability
- Automatically rolls back failed scaling operations
- Supports both single and multi-service scaling operations

## Architecture

### Project Structure

```
auto-scaling-executor/
├── index.js                           # Application entry point
├── package.json                       # Dependencies management
├── api/                               # HTTP Controllers
│   ├── scale.controller.js           # Simple scaling endpoint
│   └── scale-with-metrics.controller.js  # Advanced scaling with validation
├── services/                          # Business logic
│   ├── scaling.service.js            # Core scaling orchestration
│   ├── k8s-executor.service.js       # Kubernetes operations
│   ├── metrics.service.js            # Metrics normalization & evaluation
│   ├── validation-orchestrator.service.js  # Validation & rollback logic
│   ├── chaos.service.js              # Chaos injection capabilities
│   └── local-scaler.service.js       # Local simulation mode
├── utils/                             # Utility functions
│   └── logger.js                     # Logging configuration
└── infra/                             # Infrastructure configs
    └── chaos/                        # Chaos Mesh templates
```

## Core Components

### 1. **Scaling Service** (`services/scaling.service.js`)

The main orchestrator that handles scaling logic:

- **Validates** input parameters (deployment name, pod count)
- **Calculates** required replicas based on scale action type
- **Routes** scaling operations based on execution mode
- **Manages** chaos injection and metric validation workflows

**Key Methods:**

- `scaleOneWithMetrics()` - Scale with metrics validation & optional chaos testing
- `scaleMultiple()` - Batch scale multiple deployments
- `calculatePods()` - Compute target replica count

### 2. **Kubernetes Executor** (`services/k8s-executor.service.js`)

Direct interface with Kubernetes API:

- Scales deployments to target replica count
- Retrieves current replica status
- Monitors pod readiness
- Applies and tracks scaling changes

### 3. **Metrics Service** (`services/metrics.service.js`)

Evaluates system health and stability:

**Supported Metrics:**

- Success Rate (healthy: 99%, warning: 97%)
- Error Rate (healthy: 0.1%, warning: 1%)
- P95 Latency (healthy: 500ms, warning: 800ms)
- Latency Regression (healthy: 0%, warning: 10%)
- CPU & Memory utilization
- Pod restart counts
- Traffic recovery metrics

**Key Methods:**

- `extractFromPayload()` - Normalize raw metrics
- `evaluateStability()` - Check hard safety constraints
- `calculateResilienceScore()` - Compute soft resilience metric (0-1)

### 4. **Validation Orchestrator** (`services/validation-orchestrator.service.js`)

Manages validation workflow with automatic rollback:

- Performs **hard validation** (must pass all stability checks)
- Calculates **soft resilience score** (must meet threshold)
- Optionally injects **chaos for testing**
- Automatically **rolls back** on validation failure
- Returns detailed validation reports

### 5. **Chaos Service** (`services/chaos.service.js`)

Chaos engineering integration (requires Chaos Mesh):

- **Injects pod failures** to test system resilience
- **Monitors** system behavior under failure conditions
- **Removes** chaos experiments after testing
- Validates that scaling improves system stability

## API Endpoints

### 1. Simple Scaling (No Validation)

```
POST /api/v1/scale-simple
```

**Request:**

```json
{
  "services": [
    {
      "deployment": "order-service",
      "request_pods": 5
    }
  ]
}
```

**Response:**

```json
{
  "mode": "K8S",
  "results": [
    {
      "deployment": "order-service",
      "previous_replicas": 3,
      "attempted_additional_replicas": 2,
      "additional_replicas": 2,
      "required_replicas": 5,
      "status": "SUCCESS",
      "message": "Scale executed without validation"
    }
  ]
}
```

---

### 2. Advanced Scaling with Metrics Validation

```
POST /api/v1/scale-with-metrics
```

**Single Service Request:**

```json
{
  "deployment": "order-service",
  "request_pods": 5,
  "metrics": {
    "successRate": 0.98,
    "errorRate": 0.005,
    "p95Latency": 650,
    "cpuPercent": 65,
    "memPercent": 72
  },
  "scale_action": "scale_up"
}
```

**Multi-Service Request:**

```json
{
  "services": [
    {
      "deployment": "order-service",
      "request_pods": 5,
      "metrics": {...},
      "scale_action": "scale_up"
    },
    {
      "deployment": "product-service",
      "request_pods": 3,
      "metrics": {...},
      "scale_action": "scale_down"
    }
  ]
}
```

**Response:**

```json
{
  "mode": "K8S",
  "results": [
    {
      "deployment": "order-service",
      "previous_replicas": 4,
      "attempted_additional_replicas": 1,
      "additional_replicas": 1,
      "required_replicas": 5,
      "status": "SUCCESS_VALIDATED",
      "message": "Scale kept – resilience validation passed",
      "validation": {
        "passed": true,
        "stability": {
          "isStable": true,
          "reasons": []
        },
        "resilience": {
          "score": 0.89,
          "threshold": 0.7,
          "passed": true
        },
        "chaosTest": {
          "executed": false
        },
        "rolledBack": false
      }
    }
  ]
}
```

---

## Environment Variables

Configure behavior through `.env` file:

```env
# Execution mode: "LOCAL" or "K8S"
EXECUTION_MODE=K8S

# Kubernetes namespace (if applicable)
NAMESPACE=default

# Resilience score threshold (0-1)
RESILIENCE_THRESHOLD=0.7

# Chaos injection delay (milliseconds)
CHAOS_WAIT_MS=10000

# Logging level: "debug", "info", "warn", "error"
LOG_LEVEL=info
```

## Scale Action Types

- **`scale_up`** - Increase replicas by `request_pods` amount
- **`scale_down`** - Decrease replicas by `request_pods` amount
- **`no_change`** - Return current state without scaling

## Scaling Decision Flow

```
┌─────────────────────────────────────┐
│   Scaling Request Received          │
└──────────────┬──────────────────────┘
               │
        ┌──────▼──────┐
        │  Validate   │
        │   Input     │
        └──────┬──────┘
               │
        ┌──────▼──────────────────┐
        │  Has metrics provided?  │
        └──────┬────────────┬─────┘
               │            │
              YES           NO
               │            │
        ┌──────▼──────┐    │
        │  1. Scale   │    │
        │ 2. Validate │    │
        │ 3. Chaos    │    │
        │ 4. Rollback │    │
        └──────┬──────┘    │
               │           │
        ┌──────┴────────────▼──┐
        │   Scale Direct       │
        │   (No Validation)    │
        └──────┬───────────────┘
               │
        ┌──────▼──────────────┐
        │  Return Result      │
        │  with Status        │
        └─────────────────────┘
```

## Validation & Rollback Logic

### Hard Validation (Safety Constraints)

Must pass all checks:

- ✅ Success rate >= critical threshold
- ✅ Error rate <= acceptable limit
- ✅ Latency within bounds
- ✅ Pod stability (restart counts)
- ✅ Resource utilization reasonable

### Soft Validation (Resilience Score)

- Calculates weighted resilience score (0-1)
- Compares against `RESILIENCE_THRESHOLD`
- Combines multiple metrics into single decision metric

### Automatic Rollback

If validation fails:

1.  Log failure details
2.  Rollback deployment to previous replica count
3.  Return failed status with reasons
4.  No automatic retry (caller decides)

## Chaos Testing

When chaos testing is enabled (`chaosTest: true`):

1. **Inject pod failure** for the deployment
2. **Wait** for system to stabilize (configurable delay)
3. **Verify** metrics remain acceptable
4. **Clean up** chaos experiment
5. **Report** chaos resilience results

This feature requires **Chaos Mesh** to be installed in the cluster.

## Setup & Installation

### Prerequisites

- Node.js 18+
- Kubernetes cluster access
- kubectl configured locally
- (Optional) Chaos Mesh for chaos testing

### Installation

```bash
# Navigate to directory
cd auto-scaling-executor

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings
```

### Running

```bash
# Development mode
npm start

# Or with environment variables
EXECUTION_MODE=K8S RESILIENCE_THRESHOLD=0.7 npm start
```

The service will start on `http://localhost:6000`

## Usage Examples

### Example 1: Simple Scale-Up

```bash
curl -X POST http://localhost:6000/api/v1/scale \
  -H "Content-Type: application/json" \
  -d '{
    "services": [
      {
        "deployment": "order-service",
        "request_pods": 3
      }
    ]
  }'
```

### Example 2: Scale with Metrics Validation

```bash
curl -X POST http://localhost:6000/api/v1/scale-with-metrics \
  -H "Content-Type: application/json" \
  -d '{
    "deployment": "product-service",
    "request_pods": 2,
    "metrics": {
      "successRate": 0.97,
      "errorRate": 0.008,
      "p95Latency": 700,
      "cpuPercent": 68,
      "memPercent": 75
    },
    "scale_action": "scale_up"
  }'
```

### Example 3: Chaos Testing

```bash
curl -X POST http://localhost:6000/api/v1/scale-with-metrics \
  -H "Content-Type: application/json" \
  -d '{
    "deployment": "critical-service",
    "request_pods": 2,
    "metrics": {...},
    "scale_action": "scale_up",
    "chaos_test": true
  }'
```

## Monitoring & Logging

The executor logs all operations using Winston logger:

- **INFO**: Scaling decisions, state changes
- **WARN**: Validation failures, rollbacks
- **ERROR**: Kubernetes API failures, configuration issues
- **DEBUG**: Detailed metrics calculations, decisions

View logs via stdout or redirect to file:

```bash
npm start > scaling-executor.log 2>&1
```

## Integration with AI-Based Scaler

The executor receives scaling recommendations from the AI prediction service:

1. ML service predicts optimal pod count
2. Provides confidence metrics (success rate, latency, etc.)
3. Sends request to `/api/v1/scale-with-metrics`
4. Executor validates & applies scaling
5. Returns result with validation details

## Troubleshooting

### Issue: Scaling Not Applying

**Solution**: Verify Kubernetes connectivity and deployment exists

```bash
kubectl get deployments
kubectl describe deployment order-service
```

### Issue: Validation Always Failing

**Solution**: Check metric thresholds in `MetricsService`

```javascript
// Adjust thresholds as needed
const THRESHOLDS = { ... }
```

### Issue: Chaos Injection Fails

**Solution**: Verify Chaos Mesh is installed

```bash
kubectl get namespace chaos-mesh
kubectl get chaosexperiments
```

## Performance Characteristics

- **Scaling latency**: 100-500ms (excluding pod startup)
- **Validation overhead**: 50-200ms per service
- **Chaos injection delay**: ~15 seconds (configurable)
- **Concurrent requests**: Scales horizontally with replicas

## Security Considerations

-  Input validation on all parameters
-  Kubernetes RBAC enforcement
-  No hardcoded credentials (use .env)
-  Automatic rollback prevents cascading failures
-  Ensure tight Kubernetes permissions for service account

## Future Enhancements

- [ ] Multi-zone scaling distribution
- [ ] Advanced ML-based metric prediction
- [ ] Custom metric providers (Prometheus, Datadog)
- [ ] Canary scaling strategies
- [ ] Cost optimization during scaling decisions

## Support & Contributing

For issues or contributions, please refer to the main project [CONTRIBUTING.md](../CONTRIBUTING.md)

## License

See [LICENSE.md](../LICENSE.md)
