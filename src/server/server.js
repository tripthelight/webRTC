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
const HOST = process.env.RTC_HOST || '220.71.2.120';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});

const ROOMS = new Map(); // roomId -> Set<ws>

function getRoom(roomId) {
  if (!ROOMS.has(roomId)) ROOMS.set(roomId, new Set());
  return ROOMS.get(roomId);
}

function broadcastToRoom(roomId, from, data) {
  const room = getRoom(roomId);
  for (const client of room) {
    if (client !== from && client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  }
}

wss.on('connection', (ws) => {
  ws.id = randomUUID();
  ws.roomId = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const room = getRoom(msg.roomId);
      if (room.size >= 2) {
        ws.send(JSON.stringify({ type: 'room_full' }));
        return;
      }
      ws.roomId = msg.roomId;
      room.add(ws);

      // 역할 배정: 먼저 들어온 1명 = impolite(false), 두 번째 = polite(true)
      const peers = Array.from(room);
      const roles = peers.map((peer, idx) => ({
        id: peer.id,
        polite: (idx === 1) // 두 번째 입장자만 polite: true
      }));

      // 각자에게 본인 역할 통지
      for (const peer of peers) {
        const me = roles.find(r => r.id === peer.id);
        peer.send(JSON.stringify({
          type: 'role',
          polite: me.polite,
          peers: roles
        }));
      }

      // 2명 찼음을 상대에게 알림(간단한 상태 알림용)
      broadcastToRoom(ws.roomId, null, { type: 'peer_count', count: room.size });
      return;
    }

    // 단순 릴레이 (sdp/ice 교환)
    if (ws.roomId && (msg.type === 'signal')) {
      broadcastToRoom(ws.roomId, ws, { type: 'signal', from: ws.id, payload: msg.payload });
    }

    if (msg.type === 'leaving') {
      if (ws.roomId) {
        const room = getRoom(ws.roomId);
        room.delete(ws);
        broadcastToRoom(ws.roomId, null, { type: 'peer_left', id: ws.id, count: room.size });
        if (room.size === 0) ROOMS.delete(ws.roomId);
      }
      try { ws.close(); } catch {}
      return;
    }
  });

  ws.on('close', () => {
    if (ws.roomId) {
      const room = getRoom(ws.roomId);
      room.delete(ws);
      broadcastToRoom(ws.roomId, null, { type: 'peer_left', id: ws.id, count: room.size });
      if (room.size === 0) ROOMS.delete(ws.roomId);
    }
  });
});
