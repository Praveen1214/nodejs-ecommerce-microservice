import mongoose from "mongoose";

const connectDB = async () => {
    try {
        const uri = process.env.MONGODB_URI;
        if (!uri) {
            throw new Error("MONGODB_URI is not defined in environment variables");
        }

        console.log("⏳ Connecting to MongoDB...");
        await mongoose.connect(uri);
        console.log("🟢 MongoDB Connected Successfully to:", uri.split('@')[1].split('/')[0]); // Log host only for security
    } catch (error) {
        console.error("🔴 MongoDB Connection Error:", error.message);
    }
};

export default connectDB;
