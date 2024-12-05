import { WebSocketServer } from "ws";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";

// WebSocket 서버 생성
const WSS = new WebSocketServer({ port: 4000 });
const redis = new Redis();

// 각 Room을 관리하는 객체
const ROOMS = {};

// 연결된 클라이언트 처리
WSS.on("connection", (socket) => {
  /*
  let assignedRoom;

  // 방 할당 로직
  for (const [room, clients] of Object.entries(ROOMS)) {
    if (clients.length < 2) {
      assignedRoom = room;
      ROOMS[room].push(socket);
      break;
    }
  }

  if (!assignedRoom) {
    assignedRoom = `room-${uuidv4()}`;
    ROOMS[assignedRoom] = [socket];
  }

  socket.room = assignedRoom;
  */

  socket.on("message", (message) => {
    const msgData = JSON.parse(message);
    // const roomClients = ROOMS[socket.room];

    if (msgData.type === "entryOrder") {
      const recevedRoom = msgData.room;

      if (recevedRoom === "") {
        let roomFound = false;
        for (const [room, clients] of Object.entries(ROOMS)) {
          if (clients.length < 2) {
            ROOMS[room].push(socket);
            socket.room = room;
            roomFound = true;
            break;
          }
        }

        // 만약 모든 방에 WebSocket이 2개라면 새로운 방을 만들고 내 WebSocket을 추가
        if (!roomFound) {
          const newRoomName = `room-${uuidv4()}`;
          ROOMS[newRoomName] = [socket];
          socket.room = newRoomName;
        }

        const roomClients = ROOMS[socket.room];

        socket.send(
          JSON.stringify({
            type: "entryOrder",
            userLength: roomClients.length,
            room: socket.room,
          })
        );
      } else {
        const roomClients = ROOMS[recevedRoom];

        if (roomClients) {
          // 내가 원래있던 방에 WebSocket이 있으면

          ROOMS[recevedRoom].push(socket);
          socket.room = recevedRoom;

          socket.send(
            JSON.stringify({
              type: "entryOrder",
              userLength: roomClients.length,
              room: recevedRoom,
            })
          );
        } else {
          // 내가 원래있던 방에 WebSocket이 없으면
          //
          // 1) 내가 처음 들어왔는데, 상대방이 없는 상태에서 새로고침 -  yourName 없음
          // 2) 내가 게임중에 상대방이 나간 상태에서 내가 새로고침 - yourName 있음
          const yourName = msgData.yourName;
          if (yourName === "") {
            // 내가 처음 들어왔는데, 상대방이 없는 상태에서 새로고침
            const newRoomName = `room-${uuidv4()}`;
            ROOMS[newRoomName] = [socket];
            socket.room = newRoomName;

            const roomClients = ROOMS[socket.room];

            socket.send(
              JSON.stringify({
                type: "entryOrder",
                userLength: roomClients.length,
                room: socket.room,
              })
            );
          } else {
            // 내가 게임중에 상대방이 나간 상태에서 내가 새로고침
            socket.send(
              JSON.stringify({
                type: "otherLeaves",
              })
            );
          }
        }
      }
      // console.log("init ROOMS ::::: ", ROOMS);
    } else {
      const roomClients = ROOMS[socket.room];
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
  });

  // 클라이언트 연결 종료 시
  socket.on("close", () => {
    if (ROOMS[socket.room]) {
      ROOMS[socket.room] = ROOMS[socket.room].filter(
        (client) => client !== socket
      );
      if (ROOMS[socket.room].length === 0) {
        delete ROOMS[socket.room]; // 방이 비어 있으면 삭제
      }
    }

    // console.log("close ROOMS ::::: ", ROOMS);
  });
});

console.log(`WebSocket server is running on ws://localhost:4000`);
