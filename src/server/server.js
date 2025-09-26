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

app.use(express.static('public')); // public/index.html, bundle.js 서빙

// 아주 단순한 "룸 → 소켓 집합" 매핑
const ROOMS = new Map(); // roomName -> Set(ws)

function joinRoom(ws, roomName) {
  if (!ROOMS.has(roomName)) ROOMS.set(roomName, new Set());
  ROOMS.get(roomName).add(ws);
  ws._room = roomName;
}

function leaveRoom(ws) {
  const room = ws._room;
  if (!room || !ROOMS.has(room)) return;
  ROOMS.get(room).delete(ws);
  if (ROOMS.get(room).size === 0) ROOMS.delete(room);
  ws._room = null;
}

function broadcastToRoom(roomName, data, except) {
  const members = ROOMS.get(roomName);
  if (!members) return;
  for (const client of members) {
    if (client !== except && client.readyState === client.OPEN) {
      client.send(data);
    }
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    // 1) 입장
    if (msg.type === 'join' && typeof msg.room === 'string') {
      joinRoom(ws, msg.room);
      ws.send(JSON.stringify({ type: 'joined', room: msg.room }));
      // 현재 방의 다른 사람들에게 "누가 들어옴" 정도 신호
      broadcastToRoom(msg.room, JSON.stringify({ type: 'peer-joined' }), ws);
      return;
    }

    // 2) 시그널 릴레이(방 브로드캐스트 버전)
    //    - 2인 기준: "보내면 상대에게만 간다" 효과가 납니다(자기 자신 제외 브로드캐스트)
    if (ws._room && msg.type === 'signal') {
      broadcastToRoom(ws._room, JSON.stringify({ type: 'signal', payload: msg.payload }), ws);
      return;
    }
  });

  ws.on('close', () => {
    const room = ws._room;
    leaveRoom(ws);
    if (room) broadcastToRoom(room, JSON.stringify({ type: 'peer-left' }), ws);
  });
});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || '220.71.2.111';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
