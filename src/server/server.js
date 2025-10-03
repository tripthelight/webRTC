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

/** rooms = { [roomName]: { a?: {ws, clientId}, b?: {ws, clientId} } } */
const rooms = Object.create(null);

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function partnerOf(room, slot) {
  return slot === 'a' ? room.b : room.a;
}

function occupySlot(room, ws, clientId) {
  // clientId가 기존 슬롯과 일치하면 교체(새로고침 대비, 서버 작업 최소화)
  if (room.a?.clientId === clientId) { room.a = { ws, clientId }; return 'a'; }
  if (room.b?.clientId === clientId) { room.b = { ws, clientId }; return 'b'; }
  // 빈 슬롯에 배치
  if (!room.a) { room.a = { ws, clientId }; return 'a'; }
  if (!room.b) { room.b = { ws, clientId }; return 'b'; }
  return null; // 가득참
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 1) 방 참가
    if (msg.type === 'join') {
      const { room: roomName, clientId } = msg;
      if (!roomName || !clientId) return;

      rooms[roomName] ||= {};
      const room = rooms[roomName];
      const slot = occupySlot(room, ws, clientId);
      if (!slot) { send(ws, { type: 'room-full' }); return; }

      ws._room = roomName;
      ws._slot = slot;
      ws._clientId = clientId;

      // 역할 통지: a=impolite(첫 접속), b=polite(두 번째 접속)
      send(ws, { type: 'role', slot, polite: slot === 'b' });

      // 둘 다 존재하면 서로 준비 완료 알림
      if (room.a?.ws && room.b?.ws) {
        send(room.a.ws, { type: 'partner-ready' });
        send(room.b.ws, { type: 'partner-ready' });
      }
      return;
    }

    // 2) 시그널 중계 (서버는 최소한으로 전달만)
    if (msg.type === 'signal') {
      const room = rooms[ws._room];
      if (!room) return;
      const partner = partnerOf(room, ws._slot);
      if (!partner?.ws) return;
      send(partner.ws, { type: 'signal', payload: msg.payload });
      return;
    }
  });

  ws.on('close', () => {
    const roomName = ws._room;
    if (!roomName) return;
    const room = rooms[roomName];
    if (!room) return;

    if (room.a?.ws === ws) room.a = undefined;
    if (room.b?.ws === ws) room.b = undefined;

    // 파트너에게 파트너 이탈 통지
    const partner = partnerOf(room, ws._slot);
    if (partner?.ws) send(partner.ws, { type: 'partner-left' });

    // 방 비면 정리
    if (!room.a && !room.b) delete rooms[roomName];
  });
});
