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
const HOST = process.env.RTC_HOST || '220.71.2.79';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});

// roomId -> Set<ws>
const ROOMS = new Map();

function getPeers(roomId) {
  const set = ROOMS.get(roomId);
  return set ? [...set] : [];
}

function broadcastToOther(ws, roomId, payload) {
  // 같은 방의 '상대 1명'에게만 전달
  for (const peer of getPeers(roomId)) {
    if (peer !== ws && peer.readyState === peer.OPEN) {
      peer.send(JSON.stringify(payload));
    }
  }
}

wss.on('connection', (ws) => {
  // 각 소켓에 부가정보를 달아둡니다 (서버 상태 최소)
  ws.roomId = null;
  ws.clientId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // 모든 메시지는 { type, roomId, clientId, ... } 형태로 온다고 가정
    const { type, roomId, clientId } = msg;

    if (type === 'join') {
      ws.roomId = roomId;
      ws.clientId = clientId;

      if (!ROOMS.has(roomId)) ROOMS.set(roomId, new Set());
      const set = ROOMS.get(roomId);
      set.add(ws);

      const peers = getPeers(roomId);
      if (peers.length > 2) {
        // 2명 초과 시 즉시 내보내고 정리 (서버 과부하 방지)
        set.delete(ws);
        ws.send(JSON.stringify({ type: 'full' }));
        ws.close();
        return;
      }

      // 역할 부여: 첫 번째는 대기(offerer:false), 두 번째는 오퍼러(offerer:true)
      if (peers.length === 1) {
        ws.send(JSON.stringify({ type: 'role', polite: false, offerer: false }));
      } else if (peers.length === 2) {
        // 방의 기존 1명 찾기
        const [p1, p2] = peers;
        const newcomer = ws;
        const other = newcomer === p1 ? p2 : p1;

        // 두 번째(= newcomer)에게 offerer:true, polite:true (글레어 시 더 관대하게 수락)
        newcomer.send(JSON.stringify({ type: 'role', polite: true, offerer: true }));
        // 첫 번째는 대기 유지(offerer:false), polite:false
        other.send(JSON.stringify({ type: 'role', polite: false, offerer: false }));

        // "상대가 들어왔음" 신호 (선택적)
        newcomer.send(JSON.stringify({ type: 'peer-joined' }));
        other.send(JSON.stringify({ type: 'peer-joined' }));
      }

      return;
    }

    if (type === 'leave') {
      // 클라이언트 자발적 종료 알림
      const set = ROOMS.get(ws.roomId);
      if (set) {
        set.delete(ws);
        broadcastToOther(ws, ws.roomId, { type: 'peer-left' });
        if (set.size === 0) ROOMS.delete(ws.roomId);
      }
      return;
    }

    // 그 외 시그널 메시지(description/candidate 등)는 "상대 1명"에게 그대로 릴레이
    if (ws.roomId) {
      // 상대가 없으면 그냥 버림(버퍼링 안함 = 서버 작업 최소화)
      broadcastToOther(ws, ws.roomId, msg);
    }
  });

  ws.on('close', () => {
    // 연결 끊기면 방에서 제거
    const set = ROOMS.get(ws.roomId);
    if (set) {
      set.delete(ws);
      // 남은 상대에게 "상대 나감" 신호
      broadcastToOther(ws, ws.roomId, { type: 'peer-left' });
      if (set.size === 0) ROOMS.delete(ws.roomId);
    }
  });
});
