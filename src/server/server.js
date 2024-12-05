import { WebSocketServer } from "ws";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";

// WebSocket 서버 생성
const WSS = new WebSocketServer({ port: 4000 });
const redis = new Redis();

// 각 Room을 관리하는 객체
const ROOMS = {};

// ===============================================================
// 사용자 WebSocket 추가
async function addWebSocketToRoom(roomName, websocket) {
  // WebSocket ID를 Set에 추가
  await redis.sadd(`ROOMS:${roomName}`, websocket);
}

// 방의 WebSocket 세션들 가져오기
async function getWebSocketsInRoom(roomName) {
  return await redis.smembers(`ROOMS:${roomName}`); // 해당 방에 연결된 모든 WebSocket ID 반환
}

// WebSocket 세션 제거 (사용자가 나갈 때)
async function removeWebSocketFromRoom(roomName, websocket) {
  await redis.srem(`ROOMS:${roomName}`, websocket); // WebSocket ID를 Set에서 제거
}

// 방 삭제 (방에 WebSocket이 없을 경우)
async function removeRoomIfEmpty(roomName) {
  const sockets = await redis.smembers(`ROOMS:${roomName}`);
  if (sockets.length === 0) {
    await redis.del(`ROOMS:${roomName}`); // WebSocket이 없으면 방 삭제
  }
}

// 테스트
async function redisInit() {
  // WebSocket을 고유한 ID로 추가
  await addWebSocketToRoom("roomName-randomName1", "ws1");
  await addWebSocketToRoom("roomName-randomName1", "ws2");

  // 방에 연결된 WebSocket 세션들 확인
  const sockets = await getWebSocketsInRoom("roomName-randomName1");
  console.log("WebSockets in roomName-randomName1:", sockets); // ['ws1', 'ws2']

  // WebSocket 세션 하나 제거 후 확인
  // await removeWebSocketFromRoom("roomName-randomName1", "ws1");
  // const socketsAfterRemoval = await getWebSocketsInRoom("roomName-randomName1");
  // console.log("WebSockets after removal:", socketsAfterRemoval); // ['ws2']
}
// redisInit();
// ===============================================================

// 연결된 클라이언트 처리
WSS.on("connection", async (socket) => {
  socket.on("message", async (message) => {
    const msgData = JSON.parse(message);

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
          await addWebSocketToRoom(newRoomName, socket);
          socket.room = newRoomName;
        }

        const roomClients = ROOMS[socket.room];
        console.log("roomClients ::::::::::::::: ", roomClients);
        const roomClientsRedis = await getWebSocketsInRoom(socket.room);

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
  });
});

console.log(`WebSocket server is running on ws://localhost:4000`);
