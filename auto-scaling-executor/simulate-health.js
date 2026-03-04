import fetch from "node-fetch";

const API_URL = "http://localhost:6000/api/v1/deployment-health/report";

const mockHealthData = {
    overallScore: 92,
    podStatus: [
        { id: "p1", name: "product-service-v1-84db", ready: true, liveness: true, age: "14d", status: "Healthy" },
        { id: "p2", name: "order-service-v2-92bc", ready: true, liveness: true, age: "2d", status: "Healthy" },
        { id: "p3", name: "auth-service-v1-77ad", ready: false, liveness: true, age: "1h", status: "Warning" }
    ],
    restarts: [
        { service: "auth-service", count: 3, status: "Warning", trend: "up" },
        { service: "product-service", count: 0, status: "Healthy", trend: "stable" }
    ],
    crashLoopBackOff: [
        { service: "inventory-db", pod: "inv-db-0" }
    ],
    nodePressure: [
        { id: "gke-cluster-node-1", cpu: 45, memory: 62, disk: 28, status: "Normal" },
        { id: "gke-cluster-node-2", cpu: 82, memory: 75, disk: 40, status: "Warning" }
    ],
    availability: [
        { time: "10:00", value: 99.9 },
        { time: "10:05", value: 99.8 },
        { time: "10:10", value: 98.5 },
        { time: "10:15", value: 99.9 }
    ],
    serviceAvailabilityBadges: [
        { service: "Product", percentage: 99.9, status: "Healthy" },
        { service: "Order", percentage: 99.5, status: "Healthy" },
        { service: "Auth", percentage: 96.2, status: "Warning" }
    ],
    projects: [
        {
            name: "Online Bookstore",
            services: [
                {
                    serviceName: "Product Service",
                    metrics: [
                        { label: "Memory Usage", value: "256", unit: "MB", status: "Healthy", icon: "mdi:memory", history: [210, 230, 256, 240] },
                        { label: "CPU Load", value: "12", unit: "%", status: "Healthy", icon: "mdi:cpu-64-bit", history: [10, 15, 12, 11] }
                    ]
                }
            ]
        }
    ]
};

async function simulateHealth() {
    console.log("🚀 Sending mock deployment health report...");
    try {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(mockHealthData)
        });

        if (response.ok) {
            const data = await response.json();
            console.log("✅ Success:", data);
        } else {
            console.error("❌ Failed:", response.status, await response.text());
        }
    } catch (error) {
        console.error("❌ Error:", error.message);
    }
}

simulateHealth();
