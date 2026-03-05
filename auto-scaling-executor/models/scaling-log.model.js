import mongoose from "mongoose";

const ScalingLogSchema = new mongoose.Schema({
    deployment: { type: String, required: true },
    request_pods: { type: Number, required: true },
    scale_action: { type: String, required: true, enum: ["scale_up", "scale_down"] },
    previous_replicas: { type: Number },
    attempted_additional_replicas: { type: Number },
    additional_replicas: { type: Number },
    required_replicas: { type: Number },
    status: { type: String },
    message: { type: String },
    rollback_reason: { type: [String] },
    production_promotion: {
        promoted: { type: Boolean },
        deployment: { type: String },
        namespace: { type: String },
        replicas: { type: Number },
        previous_replicas: { type: Number },
        reason: { type: String }
    },
    validation: {
        score: { type: Number },
        latencyScore: { type: Number },
        errorScore: { type: Number },
        trafficScore: { type: Number },
        passed: { type: Boolean },
        rolledBack: { type: Boolean },
        threshold: { type: Number },
        hardSafetyPassed: { type: Boolean },
        reasons: { type: [String] },
        metricsEvaluation: [mongoose.Schema.Types.Mixed],
        standardsUsed: mongoose.Schema.Types.Mixed
    },
    timestamp: { type: Date, default: Date.now }
});

export default mongoose.model("ScalingLog", ScalingLogSchema);
