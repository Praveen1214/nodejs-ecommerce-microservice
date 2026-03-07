import mongoose from "mongoose";

const DeploymentHealthSchema = new mongoose.Schema({
    overallScore: { type: Number, required: true },
    deployment: { type: String }, // Deployment name
    namespace: { type: String }, // Kubernetes namespace
    replicas: { type: Number }, // Current replica count
    lastScaled: { type: Date }, // When deployment was scaled
    podStatus: [{
        id: String,
        name: String,
        ready: Boolean,
        liveness: Boolean,
        age: String,
        status: String,
        podIP: String, // Pod IP address
        node: String, // Node name where pod is running
        restarts: Number // Individual pod restart count
    }],
    restarts: [{
        service: String,
        count: Number,
        status: String,
        trend: String
    }],
    crashLoopBackOff: [{
        service: String,
        pod: String
    }],
    nodePressure: [{
        id: String,
        cpu: Number,
        memory: Number,
        disk: Number,
        status: String
    }],
    availability: [{
        time: String,
        value: Number
    }],
    serviceAvailabilityBadges: [{
        service: String,
        percentage: Number,
        status: String
    }],
    projects: [{
        name: String,
        services: [{
            serviceName: String,
            metrics: [{
                label: String,
                value: String,
                unit: String,
                status: String,
                icon: String,
                history: [Number]
            }]
        }]
    }],
    createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("DeploymentHealth", DeploymentHealthSchema);
