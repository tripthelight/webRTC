import { WebSocketServer } from "ws";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";

// WebSocket 서버 생성
const WSS = new WebSocketServer({ port: 4000 });
const redis = new Redis();

// WebSocket 인스턴스를 메모리에서 찾는 예시 함수 (실제로 구현해야 함)
function getRealWebSocket(socketId) {
  // 예시: socketId를 사용하여 WebSocket 인스턴스를 찾는 방법 구현
  // 실제로는 WebSocket 서버의 상태나 메모리에서 WebSocket을 추적해야 함
  const client = Array.from(WSS.clients).find(
    (client) => client.socketId === socketId
  );
  return client || null;

  /*
  for (let client of wss.clients) {
    if (client.socketId === socketId) {
      return client;
    }
  }
  return null; // 클라이언트를 찾지 못한 경우
  */
}

/**
 * 상대방 WebSocket을 찾아서, msgData.type에 msgData.data를 전송
 * @param {Object} msgData msgData.type: offer | answer | candidate
 * @param {Object} socket
 */
async function offerAnserCandidateDataProcess(msgData, socket) {
  const { type, data } = msgData;
  if (!type || !data) return;

  // Redis에서 해당 room에 연결된 모든 클라이언트 정보 가져오기
  const roomClientsSockets = await redis.hgetall(socket.room);

  for (const key in roomClientsSockets) {
    const clientSocketId = JSON.parse(roomClientsSockets[key]).socketId;
    const clientSocketData = await redis.hget(socket.room, clientSocketId);
    const clientSocket = JSON.parse(clientSocketData); // WebSocket 메타정보에서 데이터를 가져옴

    // 나 자신을 제외한 다른 클라이언트에게 메시지 보내기
    if (clientSocket.socketId !== socket.socketId) {
      const realSocket = getRealWebSocket(clientSocket.socketId); // 메모리나 다른 방식으로 WebSocket 인스턴스 찾기
      if (realSocket) {
        realSocket.send(JSON.stringify({ type, data }));
      }
    }
  }
}

// 연결된 클라이언트 처리
WSS.on("connection", async (socket) => {
  // 새로 입장했을 때, socket에 고유한 socketId 부여
  if (!socket.socketId) {
    socket.socketId = `socketId-${uuidv4()}`;
  }

  socket.on("message", async (message) => {
    const msgData = JSON.parse(message);

    if (msgData.type === "entryOrder") {
      const recevedRoom = msgData.room;

      if (recevedRoom === "") {
        // Redis에서 모든 방을 조회하고, 1명 이하가 있는 방을 찾는다
        const allRooms = await redis.keys("*"); // 모든 방 이름을 가져옴
        let roomFound = false;

        for (const room of allRooms) {
          const sockets = await redis.hgetall(room); // 해당 방에 연결된 클라이언트 정보 가져오기
          if (Object.keys(sockets).length < 2) {
            socket.room = room; // 방에 1명이 있다면 그 방으로 입장
            await redis.hset(
              room,
              socket.socketId,
              JSON.stringify({ socketId: socket.socketId, socket })
            );
            roomFound = true;
            break; // 방을 찾으면 루프 종료
          }
        }

        // 만약 모든 방에 WebSocket이 2개라면 새로운 방을 만들고 내 WebSocket을 추가
        if (!roomFound) {
          const newRoomName = `room-${uuidv4()}`;
          socket.room = newRoomName;

          await redis.hset(
            newRoomName,
            socket.socketId,
            JSON.stringify({ socketId: socket.socketId, socket })
          );
        }

        const roomClientsSockets = await redis.hgetall(socket.room);
        // console.log("sockets :::::::::::::::::: ", sockets);
        // console.log("sockets.length ::::::::::: ", Object.keys(roomClientsSockets).length);

        socket.send(
          JSON.stringify({
            type: "entryOrder",
            userLength: Object.keys(roomClientsSockets).length,
            room: socket.room,
          })
        );
      } else {
        // Redis에서 해당 room이 존재하는지 확인
        /**
         * recevedRoom이 Redis에 있는지 확인
         * 있으면 1, 없으면 0을 return
         */
        const roomExists = await redis.exists(recevedRoom);

        if (roomExists) {
          // 내가 원래있던 방에 WebSocket이 있으면

          socket.room = recevedRoom;
          const socketId = `socketId-${uuidv4()}`;
          socket.socketId = socketId;
          await redis.hset(
            recevedRoom,
            socket.socketId,
            JSON.stringify({ socketId: socket.socketId, socket })
          );

          const roomClientsSockets = await redis.hgetall(socket.room);

          socket.send(
            JSON.stringify({
              type: "entryOrder",
              userLength: Object.keys(roomClientsSockets).length,
              room: socket.room,
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
            socket.room = newRoomName;

            await redis.hset(
              newRoomName,
              socket.socketId,
              JSON.stringify({ socketId: socket.socketId, socket })
            );

            const roomClientsSockets = await redis.hgetall(socket.room);

            socket.send(
              JSON.stringify({
                type: "entryOrder",
                userLength: Object.keys(roomClientsSockets).length,
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
      await offerAnserCandidateDataProcess(msgData, socket);
    }
  });

  // 클라이언트 연결 종료 시
  socket.on("close", async () => {
    const roomExists = await redis.exists(socket.room);
    if (roomExists) {
      // 클라이언트가 연결을 종료하면, 해당 room에서 WebSocket 연결 제거
      await redis.hdel(socket.room, socket.socketId);

      // 방에 연결된 클라이언트가 없으면 방 삭제
      const sockets = await redis.hgetall(socket.room);
      if (Object.keys(sockets).length === 0) {
        await redis.del(socket.room); // 방 삭제
      }
    }
  });
});

console.log(`WebSocket server is running on ws://localhost:4000`);
