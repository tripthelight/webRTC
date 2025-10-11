import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import http from 'http';
import {WebSocketServer} from 'ws';
import path from 'path';
import {fileURLToPath} from 'url';
import {json} from 'stream/consumers';
import { randomUUID } from 'crypto';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({server});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || '220.71.2.177';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});

// 방 상태 메모리 (간단한 in-memory. 실제 배포에선 Redis 등으로 옮길 수 있음)
const ROOMS = new Map();
// ROOMS 구조 예시:
// ROOMS.set('room-1', {
//   clients: new Set([wsA, wsB]),
//   // 추가 메타 없고, 배정 순서로 polite / impolite(=caller) 결정
// });

function getOrCreateWaitingRoom() {
  // 아직 2명이 안 찬 방을 찾고, 없으면 새로 만듦
  for (const [roomId, info] of ROOMS.entries()) {
    if (info.clients.size < 2) return roomId;
  }
  // 새 방 생성
  const roomId = `room-${Math.random().toString(36).slice(2, 8)}`;
  ROOMS.set(roomId, { clients: new Set() });
  return roomId;
}

function getRoomOfClient(ws) {
  for (const [roomId, info] of ROOMS.entries()) {
    if (info.clients.has(ws)) return roomId;
  }
  return null;
}

function broadcastToRoom(roomId, payload, exceptWs = null) {
  const info = ROOMS.get(roomId);
  if (!info) return;
  for (const client of info.clients) {
    if (client !== exceptWs && client.readyState === 1 /* OPEN */) {
      client.send(JSON.stringify(payload));
    }
  }
}

wss.on('connection', (ws) => {
  // 이 연결의 상태
  ws.meta = { roomId: null, polite: null };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 1) 클라이언트가 방 참여 요청
    if (msg.type === 'join') {
      // 방 배정: 2인 미만인 방이 있으면 그 방, 아니면 새 방
      const roomId = getOrCreateWaitingRoom();
      const info = ROOMS.get(roomId);
      info.clients.add(ws);
      ws.meta.roomId = roomId;

      // 참가 순서로 polite/impolite 결정
      // - 첫 번째 입장자: polite:true (대기자)
      // - 두 번째 입장자: polite:false (입장자, 최초 offer 보낼 것)
      const isFirst = info.clients.size === 1;
      ws.meta.polite = isFirst ? true : false;

      // 본인에게 방/역할 정보를 알려준다
      ws.send(JSON.stringify({
        type: 'room-info',
        roomId,
        polite: ws.meta.polite,
      }));

      // 방이 2명이 되면 서로 준비 완료 알림
      if (info.clients.size === 2) {
        broadcastToRoom(roomId, { type: 'both-ready' });
      }
      return;
    }

    // 2) 같은 방의 상대에게 시그널 중계
    if (msg.type === 'signal') {
      const roomId = getRoomOfClient(ws);
      if (!roomId) return;
      // 같은 방의 상대에게만 전달 (브로드캐스트하되 자기 자신 제외)
      broadcastToRoom(roomId, { type: 'signal', data: msg.data }, ws);
      return;
    }
  });

  ws.on('close', () => {
    const roomId = getRoomOfClient(ws);
    if (!roomId) return;
    const info = ROOMS.get(roomId);
    info.clients.delete(ws);

    // 방이 비면 정리, 한 명 남으면 그대로 대기 상태 유지
    if (info.clients.size === 0) {
      ROOMS.delete(roomId);
    }
  });
});
