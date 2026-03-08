import mongoose from "mongoose";

const ChaosExperimentSchema = new mongoose.Schema({
    experimentId: { type: String, required: true, unique: true },
    experimentName: { type: String },
    service: { type: String, required: true },
    namespace: { type: String, required: true },
    faultType: { type: String, required: true }, // e.g., "cpu-stress", "pod-kill", "network-delay"

    startTime: { type: Date },
    endTime: { type: Date },
    durationSeconds: { type: Number },

    latencyBefore: { type: Number },
    latencyDuring: { type: Number },
    latencyAfter: { type: Number },

    errorRateBefore: { type: Number },
    errorRateDuring: { type: Number },
    errorRateAfter: { type: Number },

    recoveryTimeSeconds: { type: Number },
    availabilityDuringChaos: { type: Number },
    resilienceScore: { type: Number },
    
    affectedPodsCount: { type: Number },
    restartCount: { type: Number },

    result: { type: String, enum: ["PASS", "FAIL"], required: true },
    createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("ChaosExperiment", ChaosExperimentSchema);
