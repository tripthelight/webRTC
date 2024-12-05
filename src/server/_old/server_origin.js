import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";

// WebSocket 서버 생성
const WSS = new WebSocketServer({ port: 4000 });

// 각 Room을 관리하는 객체
const rooms = {};

// 연결된 클라이언트 처리
WSS.on("connection", (socket) => {
  let assignedRoom;

  // 방 할당 로직
  for (const [room, clients] of Object.entries(rooms)) {
    if (clients.length < 2) {
      assignedRoom = room;
      rooms[room].push(socket);
      break;
    }
  }

  if (!assignedRoom) {
    assignedRoom = `room-${uuidv4()}`;
    rooms[assignedRoom] = [socket];
  }

  socket.room = assignedRoom;

  socket.on("message", (message) => {
    const msgData = JSON.parse(message);
    const roomClients = rooms[socket.room];

    if (msgData.type === "entryOrder") {
      socket.send(
        JSON.stringify({
          type: "entryOrder",
          length: roomClients.length,
          room: socket.room,
        })
      );
    } else {
      // Offer 처리
      if (msgData.type === "offer") {
        roomClients.forEach((client) => {
          if (client !== socket) {
            client.send(JSON.stringify({ type: "offer", data: msgData.data }));
          }
        });
      }

      // Answer 처리
      if (msgData.type === "answer") {
        roomClients.forEach((client) => {
          if (client !== socket) {
            client.send(JSON.stringify({ type: "answer", data: msgData.data }));
          }
        });
      }

      // Candidate 처리
      if (msgData.type === "candidate") {
        roomClients.forEach((client) => {
          if (client !== socket) {
            client.send(
              JSON.stringify({ type: "candidate", data: msgData.data })
            );
          }
        });
      }
    }

    // console.log("message socket.room :::::::::::::::: ", socket.room);
  });

  // 클라이언트 연결 종료 시
  socket.on("close", () => {
    rooms[socket.room] = rooms[socket.room].filter(
      (client) => client !== socket
    );
    if (rooms[socket.room].length === 0) {
      delete rooms[socket.room]; // 방이 비어 있으면 삭제
    }
    // console.log("close socket.room :::::::::::::::: ", socket.room);
  });
});

console.log(`WebSocket server is running on ws://localhost:4000`);
