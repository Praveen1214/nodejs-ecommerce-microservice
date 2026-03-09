import mongoose from "mongoose";

const SOURCE_PATTERN = /^[a-z0-9_]{1,64}$/;

const ScalingLogSchema = new mongoose.Schema({
    deployment: { type: String, required: true },
    request_pods: { type: Number, required: true, default: 0 },
    scale_action: { type: String, required: true, enum: ["scale_up", "scale_down", "no_change"] },
    previous_replicas: { type: Number },
    attempted_additional_replicas: { type: Number },
    additional_replicas: { type: Number },
    required_replicas: { type: Number },
    status: { type: String },
    message: { type: String },
    source: {
        type: String,
        default: "manual",
        set: (value) => {
            if (typeof value !== "string") return "manual";
            const normalized = value.trim().toLowerCase();
            return normalized || "manual";
        },
        validate: {
            validator: (value) => SOURCE_PATTERN.test(value || "manual"),
            message: (props) => `source: \`${props.value}\` is not a valid source format.`,
        }
    },
    pipeline_event: {
        type: String,
        enum: [
            "prediction_received",
            "prediction_processed",
            "validation_triggered",
            "validation_skipped",
            "scale_executed",
            "no_change",
        ]
    },
    pipeline_details: mongoose.Schema.Types.Mixed,
    prediction_metadata: {
        current_pods: { type: Number },
        predicted_pods: { type: Number },
        ml_latency_ms: { type: Number },
        window_end_utc: { type: String },
        step: { type: Number },
        confidence: { type: Number },
    },
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
