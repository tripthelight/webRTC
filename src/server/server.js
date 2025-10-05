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
const HOST = process.env.RTC_HOST || '220.71.2.152';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});

const ROOMS = new Map(); // roomId -> { a: WebSocket|null, b: WebSocket|null }

function getRoom(roomId) {
  if (!ROOMS.has(roomId)) ROOMS.set(roomId, { a: null, b: null });
  return ROOMS.get(roomId);
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// 하트비트 유틸
function heartbeat() { this.isAlive = true; };

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf); } catch { return; }

    if (msg.type === 'join') {
      const { roomId } = msg;
      ws._roomId = roomId;
      const room = getRoom(roomId);

      // 슬롯 채우기 (a 먼저, 그다음 b). 죽은 소켓은 정리.
      if (!room.a || room.a.readyState !== WebSocket.OPEN) {
        if (room.a && room.a !== ws) { try { room.a.close(); } catch {} }
        room.a = ws;
      } else if (!room.b || room.b.readyState !== WebSocket.OPEN) {
        if (room.b && room.b !== ws) { try { room.b.close(); } catch {} }
        room.b = ws;
      } else {
        // 이미 2명 찼으면 가장 오래된 a를 새로 교체 (2인 전용 단순화)
        try { room.a.close(); } catch {}
        room.a = ws; room.b = null;
      }

      // 역할 통지: a=polite(대기), b=impolite(offer 시작)
      const a = room.a, b = room.b;
      send(a, { type: 'role', isPolite: true,  shouldOffer: false, peerReady: !!b });
      send(b, { type: 'role', isPolite: false, shouldOffer: true,  peerReady: !!a });

    } else if (msg.type === 'signal') {
      const room = ROOMS.get(ws._roomId);
      if (!room) return;
      const peer = (room.a === ws) ? room.b : room.a;
      send(peer, { type: 'signal', payload: msg.payload });
    }
  });

  ws.on('close', () => {
    const room = ROOMS.get(ws._roomId);
    if (!room) return;
    if (room.a === ws) room.a = null;
    if (room.b === ws) room.b = null;
    const other = room.a || room.b;
    if (other) send(other, { type: 'peer-left' });
    if (!room.a && !room.b) ROOMS.delete(ws._roomId);
  });
});

// [추가] 주기적으로 ping → pong 안 오는 소켓 정리
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 15000);

wss.on('close', () => clearInterval(interval));
