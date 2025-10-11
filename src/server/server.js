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

// 아주 얇은 WebSocket 시그널링 서버
// - 방(room)마다 최대 2명만 허용
// - 두 사람이 들어오면 "누가 initiator(처음 offer 보낼 사람)인지"와 "polite 여부"를 각자에게 알려줍니다
// - 재접속(F5) 시 같은 clientId로 다시 join하면 기존 엔트리를 교체(최소 작업)합니다.

// 2) 방 상태: Map<roomName, Map<clientId, { ws, firstJoinAt, lastSeenAt }>>
const rooms = new Map();

// 유틸: 안전 전송(예외 무시)
const send = (ws, obj) => {
  try { ws.send(JSON.stringify(obj)); } catch {}
};

// 방 가져오기(없으면 생성)
function getOrCreateRoom(roomName) {
  if (!rooms.has(roomName)) rooms.set(roomName, new Map());
  return rooms.get(roomName);
}

// 현재 방의 구성원으로 역할 계산
// - 먼저 들어온 사람(slot 1) = 대기
// - 나중에 들어온 사람(slot 2) = initiator (첫 offer 보낼 사람), polite = true
function computeRoles(roomMap) {
  const list = [...roomMap.entries()].map(([clientId, info]) => ({ clientId, ...info }));
  // 최초 입장 시간 기준 정렬(오래된=먼저 입장)
  list.sort((a, b) => a.firstJoinAt - b.firstJoinAt);

  return list.map((ent, idx) => {
    const slot = idx + 1;                 // 1 또는 2
    const initiator = slot === 2;         // "두 번째 입장자"가 offer 시작 주체
    const polite = slot === 2;            // Perfect Negotiation에서 충돌 시 더 '양보'하는 쪽
    return { clientId: ent.clientId, slot, initiator, polite };
  });
}

// 두 클라이언트에게 각자 역할 통지
function notifyRoles(roomName) {
  const room = rooms.get(roomName);
  if (!room) return;
  const roles = computeRoles(room);
  roles.forEach((role) => {
    const you = room.get(role.clientId);
    if (!you) return;
    const peer = roles.find(r => r.clientId !== role.clientId) || null;
    send(you.ws, { type: 'roles', room: roomName, you: role, peer });
  });
}

// WebSocket 연결 핸들링
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 1) 방 입장 (재접속 포함)
    if (msg.type === 'join') {
      const { room: roomName, clientId } = msg;
      if (!roomName || !clientId) return;

      const room = getOrCreateRoom(roomName);
      const now = Date.now();
      const exist = room.get(clientId);

      if (exist) {
        // 같은 clientId가 재접속(F5)한 경우: ws만 갈아끼움. (타이머/작업 없음 = 최소비용)
        exist.ws = ws;
        exist.lastSeenAt = now;
      } else {
        if (room.size >= 2) {
          // 2명 초과 금지
          send(ws, { type: 'room-full', room: roomName });
          return;
        }
        room.set(clientId, { ws, firstJoinAt: now, lastSeenAt: now });
      }

      // 소켓에 메타 저장(종료 시 정리용)
      ws._roomName = roomName;
      ws._clientId = clientId;

      // 현재 인원 기준으로 역할 재통지
      notifyRoles(roomName);
    }

    // 2) 시그널 릴레이 (다음 단계에서 사용할 예정: offer/answer/candidate 전달)
    if (msg.type === 'signal') {
      const roomName = ws._roomName;
      const room = roomName && rooms.get(roomName);
      if (!room) return;

      // 같은 방의 "상대"에게 그대로 전달
      for (const [peerId, info] of room) {
        if (peerId !== ws._clientId) {
          send(info.ws, { type: 'signal', from: ws._clientId, data: msg.data });
        }
      }
    }
  });

  // 연결 종료 시 정리(최소 작업)
  ws.on('close', () => {
    const roomName = ws._roomName;
    const clientId = ws._clientId;
    if (!roomName || !clientId) return;

    const room = rooms.get(roomName);
    if (!room) return;

    const record = room.get(clientId);
    // 같은 ws일 때만 제거(중복 close 방지)
    if (record && record.ws === ws) {
      room.delete(clientId);
      if (room.size === 0) rooms.delete(roomName);
      else notifyRoles(roomName); // 남은 1명에게 "상대가 나갔다"는 사실이 roles 업데이트로 전달됨
    }
  });
});
