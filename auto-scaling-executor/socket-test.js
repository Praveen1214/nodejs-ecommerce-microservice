import { io } from "socket.io-client";

const socket = io("http://localhost:6000");

socket.on("connect", () => {
  console.log("Connected:", socket.id);
});

socket.on("scaling:scaled", (data) => {
  console.log("🟢 SCALED EVENT:", data);
});

socket.on("scaling:rolled_back", (data) => {
  console.log("🔴 ROLLBACK EVENT:", data);
});