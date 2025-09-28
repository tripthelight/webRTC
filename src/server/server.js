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

// 방: Map<roomName, Set<ws>>
const rooms = new Map();
// 역방향 메타: Map<ws, { roomName, clientId, userId }>
const meta = new Map();

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj), { binary: false }); } catch {}
}
function broadcastRoom(roomName, exceptWs, obj) {
  const set = rooms.get(roomName);
  if (!set) return;
  for (const client of set) {
    if (client !== exceptWs && client.readyState === 1) {
      send(client, obj);
    }
  }
}

// ★ 같은 방 내 동일 userId 소켓 찾기
function findSocketByUserId(roomName, userId) {
  const set = rooms.get(roomName);
  if (!set) return null;
  for (const client of set) {
    const m = meta.get(client);
    if (m?.userId === userId) return client;
  }
  return null;
}

wss.on('connection', (ws) => {
  console.log('[server] client connected');

  // 클라이언트가 보낸 메시지를 그대로 되돌려주는 "에코"
  ws.on('message', (data, isBinary) => {
    const text = data.toString();
    let msg;
    try { msg = JSON.parse(text) } catch { return; };


    // 1) 방 입장
    if (msg.type === 'join') {
      const roomName = String(msg.roomName || '').trim();
      const clientId = String(msg.clientId || '').trim();
      const userId   = String(msg.userId || '').trim(); // ★ 추가
      if (!roomName || !clientId || !userId) {
        send(ws, { type: 'error', reason: 'invalid_join' });
        return;
      }

      if (!rooms.has(roomName)) rooms.set(roomName, new Set());
      const set = rooms.get(roomName);

      // ★ takeover: 같은 userId가 이미 있으면 그 소켓을 교체
      const sameUserSocket = findSocketByUserId(roomName, userId);
      if (sameUserSocket) {
        // 기존 소켓 정리 및 교체 알림
        const oldMeta = meta.get(sameUserSocket);
        set.delete(sameUserSocket);
        meta.delete(sameUserSocket);
        try { sameUserSocket.close(); } catch {}
        // 남들에게 알림(기존 clientId가 바뀐다고 알려주고 싶다면 'peer-replace' 사용)
        broadcastRoom(roomName, ws, {
          type: 'peer-replace',
          roomName,
          oldClientId: oldMeta?.clientId,
          newClientId: clientId,
          userId
        });
      } else if (set.size >= 2) {
        // 정원 2 체크(★ 동일 userId는 위에서 이미 처리하므로 여기선 순수 인원 초과만)
        send(ws, { type: 'room-full', roomName });
        return;
      }

      // 등록
      set.add(ws);
      meta.set(ws, { roomName, clientId, userId });

      const polite = set.size === 1 ? false : true;

      send(ws, {
        type: 'joined',
        roomName,
        clientId,
        userId,
        polite,
        peers: Array.from(set)
          .filter(c => c !== ws)
          .map(c => meta.get(c)?.clientId)
          .filter(Boolean)
      });

      broadcastRoom(roomName, ws, {
        type: 'peer-join',
        roomName,
        clientId,
        userId
      });
      return;
    }

    if (msg.type === 'bye') {
      // ★ 즉시 퇴장 처리
      const m = meta.get(ws);
      if (!m) return;
      const { roomName, clientId } = m;
      const set = rooms.get(roomName);
      if (set) {
        set.delete(ws);
        meta.delete(ws);
        if (set.size === 0) rooms.delete(roomName);
        else broadcastRoom(roomName, ws, { type: 'peer-leave', roomName, clientId });
      }
      return;
    }

    // 2) 같은 방으로 시그널 릴레이 (다음 단계에서 offer/answer/ice 등에 사용)
    if (msg.type === 'signal') {
      const m = meta.get(ws);
      if (!m) return;
      if (msg.to) {
        const set = rooms.get(m.roomName);
        for (const client of set || []) {
          if (client !== ws && meta.get(client)?.clientId === msg.to && client.readyState === 1) {
            send(client, { ...msg, from: m.clientId });
          }
        }
      } else {
        broadcastRoom(m.roomName, ws, { ...msg, from: m.clientId });
      }
      return;
    }
  });

  ws.on('close', () => {
    const m = meta.get(ws);
    if (!m) return;
    const { roomName, clientId } = m;
    meta.delete(ws);
    const set = rooms.get(roomName);
    if (set) {
      set.delete(ws);
      if (set.size === 0) rooms.delete(roomName);
      else broadcastRoom(roomName, ws, { type: 'peer-leave', roomName, clientId });
    }
  });
});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || '220.71.2.78';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
