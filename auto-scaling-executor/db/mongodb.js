import mongoose from "mongoose";

const connectDB = async () => {
    try {
        const uri = process.env.MONGODB_URI || "mongodb+srv://anjana2:anjana@cluster0.rg6ebmf.mongodb.net/scaling-logs";
        await mongoose.connect(uri);
        console.log("🟢 MongoDB Connected Successfully");
    } catch (error) {
        console.error("🔴 MongoDB Connection Error:", error.message);
        // Don't exit process, allow app to run even if DB fails (resilience)
    }
};

export default connectDB;
