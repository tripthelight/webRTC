import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;
let users = [];

app.use(express.static("../client"));

// 클라이언트 연결 처리
io.on("connection", (socket) => {
  socket.on("create or join", (userId) => {
    if (users.length === 0) {
      users.push(userId);
      socket.emit("create", { type: "create", userId });
    } else if (users.length === 1) {
      users.push(userId);
      socket.emit("join", { type: "join", userId });
    } else {
      socket.emit("full", { type: "full", userId });
    }
  });

  socket.on("message", (message) => {
    console.log("Received message:", message);
    // 받은 메시지를 연결된 다른 클라이언트에게 전달
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message); // 메시지를 다른 클라이언트에게 전송
      }
    });
  });

  socket.on("disconnect", () => {
    users.pop();
    console.log("User disconnected : ", users);
  });
});

server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
