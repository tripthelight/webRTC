import dotenv from 'dotenv';
dotenv.config();


import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** 메모리 방 구조: 방마다 최대 2명만 유지 */
const ROOMS = new Map(); // roomName -> { order: string[], peers: Map<peerId, ws> }

app.use(express.static(path.join(__dirname, '../client')));

wss.on('connection', (ws) => {
  ws.id = randomUUID();
  ws.room = null;

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // 1) 방 참가
    if (msg.type === 'join') {
      const roomName = String(msg.room || '').trim();
      if (!roomName) return;

      // 방 초기화
      if (!ROOMS.has(roomName)) {
        ROOMS.set(roomName, { order: [], peers: new Map() });
      }
      const room = ROOMS.get(roomName);

      // 2명 초과 방어: 2명이 이미 있으면 가장 오래된 사람을 제거(강제퇴장)
      if (room.order.length >= 2) {
        const kickId = room.order.shift(); // 오래된 맨 앞
        const kickWs = room.peers.get(kickId);
        if (kickWs && kickWs.readyState === kickWs.OPEN) {
          try { kickWs.send(JSON.stringify({ type: 'kicked' })); } catch {}
          try { kickWs.close(4000, 'room full, replaced'); } catch {}
        }
        room.peers.delete(kickId);
      }

      // 현재 소켓 등록
      room.order.push(ws.id);
      room.peers.set(ws.id, ws);
      ws.room = roomName;

      // polite 규칙: 방에서 '먼저 들어온 순서대로' impolite(false), polite(true)
      const index = room.order.indexOf(ws.id);
      const polite = index === 1; // 두 번째 입장자가 polite

      // 상대 id (있을 수 있음)
      const otherId = room.order.find((id) => id !== ws.id);
      const payload = {
        type: 'joined',
        you: ws.id,
        polite,
        room: roomName,
        peer: otherId || null,
      };
      try { ws.send(JSON.stringify(payload)); } catch {}

      // 상대에게도 "peer-joined" 알림
      if (otherId) {
        const otherWs = room.peers.get(otherId);
        if (otherWs && otherWs.readyState === otherWs.OPEN) {
          try {
            otherWs.send(JSON.stringify({
              type: 'peer-joined',
              peer: ws.id,
            }));
          } catch {}
        }
      }
      return;
    }

    // 2) 시그널 릴레이 (description/candidate/bye 등)
    if (msg.type === 'signal' && ws.room) {
      const room = ROOMS.get(ws.room);
      if (!room) return;

      const toId = msg.to;
      if (!toId) return;
      const toWs = room.peers.get(toId);
      if (!toWs || toWs.readyState !== toWs.OPEN) return;

      // 그대로 상대에게 릴레이 (from 포함)
      try {
        toWs.send(JSON.stringify({
          type: 'signal',
          from: ws.id,
          signal: msg.signal,
        }));
      } catch {}
      return;
    }

    // 3) 떠남(옵션)
    if (msg.type === 'leave' && ws.room) {
      // 클라이언트가 능동적으로 나간 경우
      cleanup(ws);
      return;
    }
  });

  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));
});

function cleanup(ws) {
  if (!ws.room) return;
  const room = ROOMS.get(ws.room);
  if (!room) return;

  // 방에서 제거
  room.peers.delete(ws.id);
  room.order = room.order.filter((id) => id !== ws.id);

  // 상대에게 떠났음을 알림
  const otherId = room.order[0];
  if (otherId) {
    const otherWs = room.peers.get(otherId);
    if (otherWs && otherWs.readyState === otherWs.OPEN) {
      try { otherWs.send(JSON.stringify({ type: 'peer-left', peer: ws.id })); } catch {}
    }
  }

  // 방이 비면 정리
  if (room.order.length === 0) ROOMS.delete(ws.room);
  ws.room = null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('listening http://localhost:' + PORT);
});