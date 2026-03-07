# Real-Time Deployment Health (No Database Storage)

## Overview

Deployment health data is now captured and streamed in **real-time via SSE** after scaling operations **WITHOUT storing to database**. This provides instant visibility without accumulating data in MongoDB.

## How It Works

```
POST /api/v1/scale-with-metrics
    ↓
Scale Deployment
    ↓
Capture Pod Health (kubectl)
    ↓
Stream via SSE Event
    ↓
Frontend Receives Data
    ↓
(NO DATABASE WRITE)
```

## Quick Test

### Terminal 1: Connect to SSE (Listen for Real-Time Updates)

```bash
curl -N http://localhost:6000/api/v1/events/deployment-health
```

**Expected Output:**
```
data: {"status":"connected","message":"Real-time deployment health stream active","timestamp":"2026-03-07T..."}

# Wait here - you'll see health data appear when scaling happens
```

### Terminal 2: Trigger Scaling

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

### Terminal 1 Result: See Real-Time Health Data

Immediately after scaling, Terminal 1 will display:

```json
data: {
  "overallScore": 100,
  "deployment": "product",
  "namespace": "ecommerce-test",
  "lastScaled": "2026-03-07T10:30:00.000Z",
  "capturedAt": "2026-03-07T10:30:00.000Z",
  "podStatus": [
    {
      "id": "pod-uuid-123",
      "name": "product-6d7c9d8c6f-x2k9p",
      "ready": true,
      "liveness": true,
      "age": "2m",
      "status": "Healthy"
    },
    {
      "id": "pod-uuid-456",
      "name": "product-6d7c9d8c6f-l8t5q",
      "ready": true,
      "liveness": true,
      "age": "2m",
      "status": "Healthy"
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
  "crashLoopBackOff": [],
  "nodePressure": [
    {
      "id": "node1",
      "cpu": 15,
      "memory": 25,
      "disk": 10,
      "status": "Normal"
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
              "label": "Memory Usage",
              "value": "128",
              "unit": "MB",
              "status": "Healthy",
              "icon": "mdi:memory",
              "history": [118, 123, 128, 126]
            },
            {
              "label": "CPU Load",
              "value": "10",
              "unit": "%",
              "status": "Healthy",
              "icon": "mdi:cpu-64-bit",
              "history": [8, 11, 10, 9]
            }
          ]
        }
      ]
    }
  ]
}
```

## Frontend Integration

### React Example

```jsx
import React, { useEffect, useState } from 'react';

function RealtimeHealthDashboard() {
  const [healthData, setHealthData] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const eventSource = new EventSource('http://localhost:6000/api/v1/events/deployment-health');

    eventSource.onopen = () => {
      console.log('✅ SSE Connected');
      setConnected(true);
    };

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      // Skip connection confirmation message
      if (data.status === 'connected') {
        console.log(data.message);
        return;
      }

      // Update with real health data
      setHealthData(data);
      console.log('📊 Health data received:', data);
    };

    eventSource.onerror = (error) => {
      console.error('❌ SSE Error:', error);
      setConnected(false);
    };

    return () => {
      eventSource.close();
    };
  }, []);

  if (!connected) {
    return <div>Connecting to health stream...</div>;
  }

  if (!healthData) {
    return <div>Waiting for deployment health data...</div>;
  }

  return (
    <div className="dashboard">
      <h2>Deployment Health - {healthData.deployment}</h2>
      <div className="score">Overall Score: {healthData.overallScore}%</div>
      
      <table>
        <thead>
          <tr>
            <th>Pod Name</th>
            <th>Status</th>
            <th>Ready</th>
            <th>Age</th>
          </tr>
        </thead>
        <tbody>
          {healthData.podStatus.map((pod) => (
            <tr key={pod.id}>
              <td>{pod.name}</td>
              <td>
                <span className={pod.status.toLowerCase()}>
                  {pod.status}
                </span>
              </td>
              <td>{pod.ready ? '✅' : '❌'}</td>
              <td>{pod.age}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="availability-badges">
        {healthData.serviceAvailabilityBadges.map((badge) => (
          <div key={badge.service} className={`badge ${badge.status.toLowerCase()}`}>
            <span className="service-name">{badge.service}</span>
            <span className="percentage">{badge.percentage}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default RealtimeHealthDashboard;
```

### Vue.js Example

```vue
<template>
  <div class="health-dashboard">
    <div v-if="!connected" class="loading">
      Connecting to health stream...
    </div>

    <div v-else-if="!healthData" class="waiting">
      ⏳ Waiting for deployment health data...
    </div>

    <div v-else class="health-content">
      <h2>{{ healthData.deployment }} - Health Score: {{ healthData.overallScore }}%</h2>
      
      <div class="pods-table">
        <h3>Pod Status</h3>
        <table>
          <thead>
            <tr>
              <th>Pod Name</th>
              <th>Status</th>
              <th>Ready</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pod in healthData.podStatus" :key="pod.id">
              <td>{{ pod.name }}</td>
              <td :class="pod.status.toLowerCase()">{{ pod.status }}</td>
              <td>{{ pod.ready ? '✅' : '❌' }}</td>
              <td>{{ pod.age }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="service-badges">
        <div 
          v-for="badge in healthData.serviceAvailabilityBadges" 
          :key="badge.service"
          :class="['badge', badge.status.toLowerCase()]"
        >
          <span>{{ badge.service }}</span>
          <span>{{ badge.percentage }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      healthData: null,
      connected: false,
      eventSource: null
    };
  },
  mounted() {
    this.connectSSE();
  },
  beforeUnmount() {
    if (this.eventSource) {
      this.eventSource.close();
    }
  },
  methods: {
    connectSSE() {
      this.eventSource = new EventSource('http://localhost:6000/api/v1/events/deployment-health');
      
      this.eventSource.onopen = () => {
        console.log('✅ SSE Connected');
        this.connected = true;
      };
      
      this.eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        // Skip connection message
        if (data.status === 'connected') {
          console.log(data.message);
          return;
        }
        
        // Update health data
        this.healthData = data;
        console.log('📊 Health data received:', data);
      };
      
      this.eventSource.onerror = (error) => {
        console.error('❌ SSE Error:', error);
        this.connected = false;
      };
    }
  }
};
</script>

<style scoped>
.badge.healthy { background: #4caf50; color: white; }
.badge.warning { background: #ff9800; color: white; }
.badge.critical { background: #f44336; color: white; }
</style>
```

## Multi-Service Scaling Test

You can also test with multiple services:

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
      }
    ]
  }'
```

The SSE stream will receive health data for **each deployment separately** as they are scaled.

## Benefits

✅ **No Database Overhead** - No MongoDB writes, reads, or storage
✅ **Real-Time Streaming** - Instant updates via SSE
✅ **Zero Data Accumulation** - Clean, no cleanup needed
✅ **Live Dashboard** - Perfect for observability displays
✅ **Lightweight** - Minimal resource usage
✅ **Research Demo Ready** - Show live pod health during scaling

## Verify Data is NOT Stored

Check MongoDB - no records should be created:

```bash
# Connect to MongoDB
mongo autoscaler

# Query deployment health collection
db.deploymenthealths.find().count()
# Expected: 0 (or only old records if you had them before)

# Verify no new records are being created
db.deploymenthealths.find().pretty()
```

## Server Logs

Check the auto-scaling-executor logs:

```bash
tail -f logs/auto-scaler.log | grep "DEPLOYMENT_HEALTH_STREAMED"
```

You should see:
```
DEPLOYMENT_HEALTH_STREAMED deployment=product namespace=ecommerce-test score=100 podsCount=5
```

## Troubleshooting

### SSE Not Receiving Data

1. Verify SSE connection: Terminal should say "SSE Client connected"
2. Check scaling is actually happening: `kubectl get pods -n ecommerce-test -w`
3. Verify kubectl access: `kubectl get pods -n ecommerce-test`
4. Check logs: Look for "DEPLOYMENT_HEALTH_STREAMED" events

### Pod Data Empty

1. Check pod labels match deployment name: `kubectl get pods -n ecommerce-test --show-labels`
2. Verify namespace is correct: `echo $K8S_NAMESPACE`
3. Check if pods exist: `kubectl get pods -n ecommerce-test -l app=product`

## Architecture Notes

- **captureDeploymentHealthRealtime()** - Captures pod health WITHOUT DB save
- **eventEmitter.emit("health:result", data)** - Broadcasts to all SSE clients
- **No MongoDB operations** - Pure streaming
- **Automatic cleanup** - Data exists only in memory during stream

Perfect for real-time observability dashboards! 🚀
