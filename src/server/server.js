import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import http from 'http';
import {WebSocketServer} from 'ws';
import path from 'path';
import {fileURLToPath} from 'url';
import {json} from 'stream/consumers';
import { randomUUID } from 'crypto';
import { nanoid } from "nanoid";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({server});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || '211.118.157.199';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});

// ———————————————————————————————————————————————————

const ROOM_TTL_MS = 15_000; // 15초 안에 돌아오면 같은 room 재활용
const TOMBSTONES = new Map(); // roomId -> { roomId, expiredAt, lastSeenAt }

const ROOMS = Object.create(null);
const PEERS = new WeakMap();

const now = () => Date.now();
const makeRoomId = () => `room-${Math.random().toString(36).slice(2, 10)}`;

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  };
};
function findWaitingRoom() {
  for (const id in ROOMS) {
    const room = ROOMS[id];
    if (room && !room.lockAfterLeave && room.clients.size === 1) {
      return room;
    }
  };
  return null;
};
function createRoom() {
  const id = makeRoomId();
  ROOMS[id] = {
    id,
    clients: new Map(),
    createdAt: now(),
  };
  return ROOMS[id];
};
function broadcast(room, obj) {
  for (const [, sock] of room.clients) {
    safeSend(sock, obj);
  };
};
function deleteRoomIfEmpty(roomId) {
  const room = ROOMS[roomId];
  if (!room) return;
  if (room.clients.size === 0) {
    delete ROOMS[roomId];
  }
};
function attachToRoom(ws, meta, room) {
  room.clients.set(meta.peerId, ws);
  meta.roomId = room.id;

  // 역할 부여
  const role = (room.clients.size === 1) ? 'impolite' : 'polite';
  safeSend(ws, { type: 'room-assigned', roomId: room.id, peerId: meta.peerId, role });

  if (room.clients.size === 2) {
    const peers = Array.from(room.clients.keys());
    const [impolitePeerId, politePeerId] = peers; // 먼저 들어온 순
    for (const [id, sock] of room.clients) {
      const partnerId = (id === impolitePeerId) ? politePeerId : impolitePeerId;
      const role = (id === impolitePeerId) ? 'impolite' : 'polite';
      safeSend(sock, {
        type: 'paired',
        roomId: room.id,
        you: { peerId: id, role },
        partner: { peerId: partnerId, role: (role === 'impolite' ? 'polite' : 'impolite') },
      });
    };
    if (room.lockAfterLeave) {
      delete room["lockAfterLeave"];
    };
  }
}
function createRoomWithId(roomId) {
  ROOMS[roomId] = {
    id: roomId,
    clients: new Map(),
    createdAt: now(),
  };
  return ROOMS[roomId];
};
function handleJoin(ws, meta, msg) {
  // msg: { type:'join', roomHint?: string }
  const requested = typeof msg.roomHint === 'string' ? msg.roomHint : null;

  // 1) roomHint가 있고, 그 방이 현재 살아있다면 그 방으로
  // 두 peer가 나가지 않은 상태에서 한 peer가 새로고침하면 새로고침 한 peer는 여기를 탐
  if (requested && ROOMS[requested] && ROOMS[requested].clients.size < 2) {
    attachToRoom(ws, meta, ROOMS[requested]);
    return;
  }

  // 2) roomHint가 무덤에 있고(아직 TTL 안 지남) → 방 부활
  if (requested && TOMBSTONES.has(requested)) {
    const tomb = TOMBSTONES.get(requested);
    if (tomb.expiredAt > now()) {
      // 1) 한 peer가 처음 진입한 후 상대방을 기다리던 중 새로고침하면 여기 탐
      // - 이 후 단계 진행

      // 2) 두 peer가 연결되었다가 한 peer가 나간 후 나머지 peer가 새로고침하면 새로고침 한 peer가 여기 탐
      // - 나간것이 확인되면 남아있는 peer에게 partner-left 전송
      console.log("두 peer가 연결되었다가 한 peer가 나간 후 나머지 peer가 새로고침하면 새로고침 한 peer가 여기 탐");

      // 3) 두 peer가 모두 있는 상태에서 두 peer가 모두 새로고침 난타하면 여기를 탐
      // - 이 후 단계 진행
      console.log("두 peer가 모두 있는 상태에서 두 peer가 모두 새로고침 난타하면 여기를 탐");

      // 부활
      TOMBSTONES.delete(requested);
      const revivedRoom = createRoomWithId(requested);
      attachToRoom(ws, meta, revivedRoom);
      return;
    } else {
      TOMBSTONES.delete(requested); // 만료됐으면 버림
    }
  }

  // 3) roomHint가 없거나, 사용할 수 없다면 "일반 매칭"
  let room = findWaitingRoom();
  if (!room) room = createRoom();
  attachToRoom(ws, meta, room);
}

function cbConnection(ws) {
  const peerId = randomUUID();

  // "바로 배정"하지 않고, 클라의 'join' 메시지를 기다립니다.
  PEERS.set(ws, { peerId, roomId: null });

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    const meta = PEERS.get(ws);
    if (!meta) return;

    if (msg?.type === 'join') { // ★ 클라가 요청한 room 합류
      if (msg?.roomHint) {
        // sessionStorage에 roomId 있음
        // 새로고침 한 peer는 여기를 탐
        const room = ROOMS[msg.roomHint];
        if (room) {
          // 둘 중에 한 명은 남아있었던 상태
        } else {
          // 둘 중에 한 명 이상 나간 상태
          // 서로 새로고침 난타해도 여기 탈듯..
        }
      } else {
        // sessionStorage에 roomId 없음 : null
        // 아예 처음 연결 시도
      }

      handleJoin(ws, meta, msg);
      return;
    }

    if (msg?.type === 'signal' && msg?.to) {
      const room = ROOMS[meta.roomId];
      if (!room) return;
      const target = room.clients.get(msg.to);
      if (target) {
        safeSend(target, { type: 'signal', from: meta.peerId, data: msg.data });
      }
      return;
    }
  });

  ws.on('close', () => {
    const meta = PEERS.get(ws);
    if (!meta) return;
    const { peerId, roomId } = meta;
    const room = ROOMS[roomId];
    if (room) {
      room.clients.delete(peerId);
      broadcast(room, { type: 'partner-left', roomId, peerId });

      room.lockAfterLeave = true;

      if (room.clients.size === 0) {
        // 즉시 삭제 대신, 무덤에 15초간 보관
        TOMBSTONES.set(roomId, { roomId, expiredAt: now() + ROOM_TTL_MS, lastSeenAt: now() });
        delete ROOMS[roomId];
      }
    }
    PEERS.delete(ws);
  });
};

wss.on("connection",  cbConnection);
