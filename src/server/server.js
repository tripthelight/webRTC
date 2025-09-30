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

const rooms = new Map(); // roomId -> Set of client objects

function send(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).slice(2);
  ws.roomId = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'join') {
      const { roomId } = msg;
      ws.roomId = roomId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const set = rooms.get(roomId);

      set.add(ws);
      if (set.size === 1) {
        // 방의 첫 참가자 = impolite
        ws.role = 'impolite';
        send(ws, 'role', { role: 'impolite' });
      } else if (set.size === 2) {
        // 기존 참가자 = impolite, 새 참가자 = polite
        const others = [...set].filter(p => p !== ws);
        const first = others[0];
        first.role = 'impolite';
        send(first, 'role', { role: 'impolite' });
        ws.role = 'polite';
        send(ws, 'role', { role: 'polite' });
        // 서로에게 입장 알림
        send(first, 'peer-joined', { peerId: ws.id });
        send(ws, 'peer-joined',   { peerId: first.id });
      } else {
        // 2인 게임이라면 초과 인원은 거절하거나 무시 처리(선택)
      }

      return;
    }

    if (msg.type === 'signal') {
      const set = rooms.get(ws.roomId);
      if (!set) return;
      for (const peer of set) {
        if (peer !== ws) {
          send(peer, 'signal', { payload: msg.payload });
        }
      }
      return;
    }
  });

  ws.on('close', () => {
    const set = rooms.get(ws.roomId);
    if (!set) return;
    set.delete(ws);
    // 나간 사실을 상대에게 알림
    for (const peer of set) {
      send(peer, 'peer-left', { peerId: ws.id });
    }
    // 한 명만 남았다면, 남은 사람을 impolite로 재지정
    if (set.size === 1) {
      const [only] = [...set];
      only.role = 'impolite';
      send(only, 'role', { role: 'impolite' });
    }
    if (set.size === 0) rooms.delete(ws.roomId);
  });
});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || '220.71.2.167';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
