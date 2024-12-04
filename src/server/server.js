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
    const roomClients = rooms[socket.room];

    if (message.toString() === "userLength") {
      socket.send(
        JSON.stringify({ type: "userLength", length: roomClients.length })
      );
    } else {
      const msgData = JSON.parse(message);

      // Offer 처리
      if (msgData.offer) {
        roomClients.forEach((client) => {
          if (client !== socket) {
            client.send(JSON.stringify({ offer: msgData.offer }));
          }
        });
      }

      // Answer 처리
      if (msgData.answer) {
        roomClients.forEach((client) => {
          if (client !== socket) {
            client.send(JSON.stringify({ answer: msgData.answer }));
          }
        });
      }

      // Candidate 처리
      if (msgData.candidate) {
        roomClients.forEach((client) => {
          if (client !== socket) {
            client.send(JSON.stringify({ candidate: msgData.candidate }));
          }
        });
      }
    }
  });

  // 클라이언트 연결 종료 시
  socket.on("close", () => {
    rooms[socket.room] = rooms[socket.room].filter(
      (client) => client !== socket
    );
    if (rooms[socket.room].length === 0) {
      delete rooms[socket.room]; // 방이 비어 있으면 삭제
    }
  });
});

console.log(`WebSocket server is running on ws://localhost:4000`);
