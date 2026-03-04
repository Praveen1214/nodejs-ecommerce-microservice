import fetch from "node-fetch";

const API_URL = "http://localhost:6000/api/v1/chaos/experiment-result";

const mockChaosResult = {
    service: "product-service",
    faultType: "cpu-stress",
    latencyBefore: 120,
    latencyDuring: 450,
    latencyAfter: 140,
    errorRateDuring: 0.05,
    recoveryTimeSeconds: 8,
    resilienceScore: 0.82,
    result: "PASS",
    namespace: "ecommerce-test",
    durationSeconds: 30,
    availabilityDuringChaos: 0.98,
    startTime: new Date(Date.now() - 30000).toISOString(),
    endTime: new Date().toISOString()
};

async function testChaosAPI() {
    console.log("🚀 Sending mock chaos experiment result...");
    try {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(mockChaosResult)
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

testChaosAPI();
