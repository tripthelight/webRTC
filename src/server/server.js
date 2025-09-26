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
// 역방향 메타: Map<ws, { roomName, clientId }>
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
      if (!roomName || !clientId) {
        send(ws, { type: 'error', reason: 'invalid_join' });
        return;
      }

      // 방 생성 or 조회
      if (!rooms.has(roomName)) rooms.set(roomName, new Set());
      const set = rooms.get(roomName);

      // 정원 2 체크
      if (set.size >= 2) {
        send(ws, { type: 'room-full', roomName });
        return;
      }

      // 방 등록 + 메타 저장
      set.add(ws);
      meta.set(ws, { roomName, clientId });

      // 역할 부여: 첫 입장자 impolite(false), 두 번째 polite(true)
      const polite = set.size === 1 ? false : true;

      // 본인에게 입장 확인 + 역할 정보
      send(ws, {
        type: 'joined',
        roomName,
        clientId,
        polite,
        peers: Array.from(set)
          .filter(c => c !== ws)
          .map(c => meta.get(c)?.clientId)
          .filter(Boolean)
      });

      // 다른 참가자들에게도 새 참가자 알림
      broadcastRoom(roomName, ws, {
        type: 'peer-join',
        roomName,
        clientId
      });

      return;
    }

    // 2) 같은 방으로 시그널 릴레이 (다음 단계에서 offer/answer/ice 등에 사용)
    if (msg.type === 'signal') {
      const m = meta.get(ws);
      if (!m) return;
      // target 지정이 있으면 특정 상대에게만 릴레이, 없으면 룸 내 나를 제외한 모두에게
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
      else {
        // 남은 참가자에게 퇴장 알림
        broadcastRoom(roomName, ws, {
          type: 'peer-leave',
          roomName,
          clientId
        });
      }
    }
  });
});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || '220.71.2.111';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
