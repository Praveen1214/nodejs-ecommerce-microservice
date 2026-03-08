# Deployment Health - Enhanced Pod Details with Database Storage

## Overview

When you call `POST /api/v1/scale-with-metrics`, the system now:
1. ✅ Scales the deployment
2. ✅ Captures detailed pod health data
3. ✅ **Stores it in MongoDB** (deploymentHealth collection)
4. ✅ Streams it via SSE for real-time display

## Pod Data Captured

Each pod includes:
- **Name** - Full pod name (e.g., product-6d7c9d8c6f-x2k9p)
- **Status** - Running, Pending, Failed, etc.
- **Ready** - Boolean indicating if pod is ready
- **Restart Count** - Number of times pod has restarted
- **Age** - How long pod has been running (e.g., "2m", "5h")
- **Pod IP** - Internal IP address
- **Node** - Which Kubernetes node is hosting the pod

## Quick Test

### Step 1: Start Server

```bash
cd auto-scaling-executor
npm start
```

### Step 2: Connect to SSE (Terminal 1)

```bash
curl -N http://localhost:6000/api/v1/events/deployment-health
```

**Initial Response** (latest data from DB):
```json
data: {
  "_id": "...",
  "overallScore": 100,
  "deployment": "product",
  "namespace": "ecommerce-test",
  "replicas": 3,
  "lastScaled": "2026-03-07T10:30:00.000Z",
  "podStatus": [
    {
      "name": "product-6d7c9d8c6f-x2k9p",
      "status": "Running",
      "ready": true,
      "restarts": 0,
      "age": "2m",
      "podIP": "10.1.1.20",
      "node": "kind-control-plane"
    }
  ],
  "serviceAvailabilityBadges": [
    {
      "service": "Product",
      "percentage": 100,
      "status": "Healthy"
    }
  ]
}
```

### Step 3: Trigger Scaling (Terminal 2)

```bash
curl -X POST http://localhost:6000/api/v1/scale-with-metrics \
  -H "Content-Type: application/json" \
  -d '{
    "deployment": "product",
    "request_pods": 2,
    "scale_action": "scale_up",
    "metrics": {
      "cpu_usage": 75
    }
  }'
```

### Step 4: See Real-Time Update in Terminal 1

Terminal 1 will immediately receive new pod health data:

```json
data: {
  "_id": "...",
  "overallScore": 100,
  "deployment": "product",
  "namespace": "ecommerce-test",
  "replicas": 5,
  "lastScaled": "2026-03-07T10:35:00.000Z",
  "podStatus": [
    {
      "id": "pod-uuid-1",
      "name": "product-6d7c9d8c6f-x2k9p",
      "status": "Running",
      "ready": true,
      "restarts": 0,
      "age": "7m",
      "podIP": "10.1.1.20",
      "node": "kind-control-plane"
    },
    {
      "id": "pod-uuid-2",
      "name": "product-6d7c9d8c6f-l8t5q",
      "status": "Running",
      "ready": true,
      "restarts": 0,
      "age": "7m",
      "podIP": "10.1.1.21",
      "node": "kind-control-plane"
    },
    {
      "id": "pod-uuid-3",
      "name": "product-6d7c9d8c6f-z1p7r",
      "status": "Running",
      "ready": true,
      "restarts": 0,
      "age": "7m",
      "podIP": "10.1.1.22",
      "node": "kind-control-plane"
    },
    {
      "id": "pod-uuid-4",
      "name": "product-6d7c9d8c6f-m4n8k",
      "status": "Running",
      "ready": true,
      "restarts": 0,
      "age": "10s",
      "podIP": "10.1.1.23",
      "node": "kind-control-plane"
    },
    {
      "id": "pod-uuid-5",
      "name": "product-6d7c9d8c6f-p9q2w",
      "status": "Running",
      "ready": true,
      "restarts": 0,
      "age": "10s",
      "podIP": "10.1.1.24",
      "node": "kind-control-plane"
    }
  ],
  "restarts": [
    {
      "service": "product",
      "count": 0,
      "status": "Healthy",
      "trend": "stable"
    }
  ],
  "serviceAvailabilityBadges": [
    {
      "service": "Product",
      "percentage": 100,
      "status": "Healthy"
    }
  ],
  "projects": [
    {
      "name": "Online Bookstore",
      "services": [
        {
          "serviceName": "Product Service",
          "metrics": [
            {
              "label": "Total Pods",
              "value": "5",
              "unit": "pods",
              "status": "Healthy",
              "icon": "mdi:kubernetes"
            },
            {
              "label": "Ready Pods",
              "value": "5",
              "unit": "pods",
              "status": "Healthy",
              "icon": "mdi:check-circle"
            },
            {
              "label": "Total Restarts",
              "value": "0",
              "unit": "count",
              "status": "Healthy",
              "icon": "mdi:refresh"
            }
          ]
        }
      ]
    }
  ]
}
```

## REST API Endpoint

You can also query the latest health data via REST:

```bash
# Get latest health for all deployments
curl http://localhost:6000/api/v1/deployment-health/latest

# Get latest health for specific deployment
curl http://localhost:6000/api/v1/deployment-health/latest?deployment=product

# Get latest health for specific namespace
curl http://localhost:6000/api/v1/deployment-health/latest?namespace=ecommerce-test
```

## Verify Database Storage

Check MongoDB to confirm data is stored:

```bash
# Connect to MongoDB
mongo autoscaler

# Query deployment health collection
db.deploymenthealths.find().pretty()

# Count records
db.deploymenthealths.find().count()

# Get latest record
db.deploymenthealths.find().sort({createdAt: -1}).limit(1).pretty()
```

**Expected Output:**
```javascript
{
  "_id": ObjectId("..."),
  "overallScore": 100,
  "deployment": "product",
  "namespace": "ecommerce-test",
  "replicas": 5,
  "lastScaled": ISODate("2026-03-07T10:35:00.000Z"),
  "podStatus": [
    {
      "name": "product-6d7c9d8c6f-x2k9p",
      "status": "Running",
      "ready": true,
      "restarts": 0,
      "age": "7m",
      "podIP": "10.1.1.20",
      "node": "kind-control-plane"
    }
    // ... more pods
  ],
  "createdAt": ISODate("2026-03-07T10:35:00.000Z")
}
```

## Dashboard Display Example

### Pod Health Table

| Pod Name | Status | Ready | Restarts | Age | Pod IP | Node |
|----------|--------|-------|----------|-----|--------|------|
| product-x2k9p | Running | ✅ | 0 | 7m | 10.1.1.20 | node1 |
| product-l8t5q | Running | ✅ | 0 | 7m | 10.1.1.21 | node1 |
| product-z1p7r | Running | ✅ | 0 | 7m | 10.1.1.22 | node1 |
| product-m4n8k | Running | ✅ | 0 | 10s | 10.1.1.23 | node1 |
| product-p9q2w | Running | ✅ | 0 | 10s | 10.1.1.24 | node1 |

### Deployment Overview

```
┌─────────────────────────────────────┐
│ Product Deployment                  │
│                                     │
│ Namespace: ecommerce-test           │
│ Replicas: 5 / 5 (100%)             │
│ Last Scaled: 2026-03-07 10:35:00   │
│                                     │
│ Overall Health Score: 100%          │
│ Status: ✅ Healthy                  │
└─────────────────────────────────────┘
```

### Service Metrics

```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ Total Pods          │  │ Ready Pods          │  │ Total Restarts      │
│      5              │  │      5              │  │      0              │
│  ✅ Healthy         │  │  ✅ Healthy         │  │  ✅ Healthy         │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

## Frontend Integration

### React Component

```jsx
import React, { useEffect, useState } from 'react';

function PodHealthDashboard() {
  const [healthData, setHealthData] = useState(null);

  useEffect(() => {
    const eventSource = new EventSource('http://localhost:6000/api/v1/events/deployment-health');

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (!data.status) {
        setHealthData(data);
      }
    };

    return () => eventSource.close();
  }, []);

  if (!healthData) return <div>Loading...</div>;

  return (
    <div className="dashboard">
      <h2>{healthData.deployment} - Health Score: {healthData.overallScore}%</h2>
      
      <div className="overview">
        <p>Namespace: {healthData.namespace}</p>
        <p>Replicas: {healthData.replicas}</p>
        <p>Last Scaled: {new Date(healthData.lastScaled).toLocaleString()}</p>
      </div>

      <h3>Pod Status</h3>
      <table>
        <thead>
          <tr>
            <th>Pod Name</th>
            <th>Status</th>
            <th>Ready</th>
            <th>Restarts</th>
            <th>Age</th>
            <th>Pod IP</th>
            <th>Node</th>
          </tr>
        </thead>
        <tbody>
          {healthData.podStatus.map((pod) => (
            <tr key={pod.id}>
              <td>{pod.name}</td>
              <td className={pod.status.toLowerCase()}>{pod.status}</td>
              <td>{pod.ready ? '✅' : '❌'}</td>
              <td className={pod.restarts > 0 ? 'warning' : ''}>{pod.restarts}</td>
              <td>{pod.age}</td>
              <td>{pod.podIP}</td>
              <td>{pod.node}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Service Availability</h3>
      {healthData.serviceAvailabilityBadges.map((badge) => (
        <div key={badge.service} className={`badge ${badge.status.toLowerCase()}`}>
          <span>{badge.service}</span>
          <span>{badge.percentage}%</span>
        </div>
      ))}
    </div>
  );
}

export default PodHealthDashboard;
```

## Multi-Service Test

Test with multiple deployments:

```bash
curl -X POST http://localhost:6000/api/v1/scale-with-metrics \
  -H "Content-Type: application/json" \
  -d '{
    "services": [
      {
        "deployment": "product",
        "request_pods": 2,
        "scale_action": "scale_up",
        "metrics": { "cpu_usage": 75 }
      },
      {
        "deployment": "order",
        "request_pods": 1,
        "scale_action": "scale_up",
        "metrics": { "cpu_usage": 70 }
      },
      {
        "deployment": "auth",
        "request_pods": 1,
        "scale_action": "scale_up",
        "metrics": { "cpu_usage": 65 }
      }
    ]
  }'
```

You'll receive separate health data for each deployment via SSE.

## Benefits

✅ **Database Storage** - All health data persisted in MongoDB  
✅ **Real-Time Streaming** - SSE delivers instant updates  
✅ **Detailed Pod Info** - IP, node, restarts, age, etc.  
✅ **Historical Access** - Query past health snapshots  
✅ **Multi-Deployment** - Track health for all services  
✅ **Research Ready** - Perfect for observability demos  

## Troubleshooting

### No Data After Scaling

```bash
# Check if pods exist
kubectl get pods -n ecommerce-test

# Check if deployment exists
kubectl get deployment product -n ecommerce-test

# Check pod labels
kubectl get pods -n ecommerce-test --show-labels
```

### Database Not Storing

```bash
# Check MongoDB connection
mongo autoscaler --eval "db.serverStatus().ok"

# Check server logs
tail -f logs/auto-scaler.log | grep "DEPLOYMENT_HEALTH_STORED"
```

### SSE Not Updating

1. Ensure SSE connection is active
2. Verify scaling actually happened
3. Check server logs for errors
4. Restart the server

Perfect for your research demonstration! 🚀
