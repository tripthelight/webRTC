import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;

app.use(express.static("../client"));

// 클라이언트 연결 처리
io.on("connection", (socket) => {
  socket.on("message", (msg) => {
    console.log("Message from client:", msg);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
