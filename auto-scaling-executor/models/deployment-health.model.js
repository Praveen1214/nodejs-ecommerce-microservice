import mongoose from "mongoose";

const DeploymentHealthSchema = new mongoose.Schema({
    overallScore: { type: Number, required: true },
    podStatus: [{
        id: String,
        name: String,
        ready: Boolean,
        liveness: Boolean,
        age: String,
        status: String
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
