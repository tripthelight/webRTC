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

/** ROOMS: roomId -> Set<WebSocket> (최대 2명) */
const ROOMS = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  let roomId = null;

  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());

    if (msg.type === 'join') {
      roomId = msg.roomId;
      if (!ROOMS.has(roomId)) ROOMS.set(roomId, new Set());
      const room = ROOMS.get(roomId);

      if (room.size >= 2) {
        send(ws, { type: 'full' });
        return;
      }
      room.add(ws);

      // 역할 배정: 첫 번째 입장 = polite(true), 두 번째 입장 = polite(false; offerer)
      const polite = room.size === 1 ? true : false;
      send(ws, { type: 'role', polite });

      // 두 명이 되면 서로에게 시작 신호
      if (room.size === 2) {
        for (const peer of room) send(peer, { type: 'ready' });
      }
      return;
    }

    // 상대에게 그대로 릴레이(desc, candidate)
    if (msg.type === 'desc' || msg.type === 'candidate') {
      if (!roomId) return;
      const room = ROOMS.get(roomId);
      if (!room) return;
      for (const peer of room) {
        if (peer !== ws) send(peer, msg);
      }
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = ROOMS.get(roomId);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) ROOMS.delete(roomId);
  });
});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || '220.71.2.79';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
