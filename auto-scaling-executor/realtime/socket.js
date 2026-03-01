import { Server } from "socket.io"
import logger from "../utils/logger.js"

let io

export function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  })

  io.on("connection", (socket) => {
    logger.info({ event: "🟢 SOCKET_CONNECTED", socket_id: socket.id })

    socket.on("disconnect", () => {
      logger.info({ event: "⚪ SOCKET_DISCONNECTED", socket_id: socket.id })
    })
  })

  // Notify at startup that Socket.IO is initialized and ready
  logger.info({ event: "🟢 SOCKET_INIT", message: "Socket.IO initialized and ready" })
  console.log("🟢 Socket.IO initialized and ready")
}

export function getIO() {
  if (!io) throw new Error("Socket not initialized")
  return io
}
