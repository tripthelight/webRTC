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

// 아주 단순한 WebSocket 시그널링 서버입니다.
// - 역할: room에 클라이언트를 넣고, 특정 상대에게 메시지(signal)를 "그대로 전달"만 합니다.
// - 의도: 서버의 일을 최소화(메시지 라우팅만)하고, WebRTC 복잡도는 전부 클라이언트에서 처리하도록 합니다.

// 메모리 상의 간단한 room 저장소
// ROOMS: Map<roomId, Map<peerId, ws>>
const ROOMS = new Map();

/** 안전하게 ws로 JSON 전송 */
function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch (e) { /* 무시 */ }
}

/** 같은 room의 다른 모든 피어에게 브로드캐스트 */
function broadcast(roomId, msg, exceptPeerId = null) {
  const room = ROOMS.get(roomId);
  if (!room) return;
  for (const [pid, client] of room.entries()) {
    if (client.readyState === 1 && pid !== exceptPeerId) {
      send(client, msg);
    }
  }
}

wss.on('connection', (ws) => {
  // 이 연결의 메타(소속 room, 본인 peerId)
  ws.meta = { roomId: null, peerId: null };

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // 클라이언트에서 오는 메시지는 크게 두 종류:
    // 1) {type:'join', roomId} : 방 참여
    // 2) {type:'signal', roomId, to, payload} : 상대에게 전달할 신호(offer/answer/ice 등)
    switch (data.type) {
      case 'join': {
        const roomId = String(data.roomId || 'default');
        const peerId = randomUUID();

        // room 준비
        if (!ROOMS.has(roomId)) ROOMS.set(roomId, new Map());
        const room = ROOMS.get(roomId);

        // 이 ws의 소속 정보 기록
        ws.meta.roomId = roomId;
        ws.meta.peerId = peerId;
        room.set(peerId, ws);

        // 현재 방 인원 수
        const count = room.size;

        // 본인에게 join 결과 통지
        // role: 'waiter'(첫 번째), 'caller'(두 번째) — 두 번째는 곧바로 offer를 시작하도록 유도
        const role = (count === 1) ? 'waiter' : 'caller';
        send(ws, { type: 'joined', roomId, peerId, role });

        // 이미 있던 사람들에게 "새 피어가 들어왔다" 알림 (디버깅용)
        broadcast(roomId, { type: 'peer-joined', roomId, peerId }, peerId);

        // "두 번째 입장자는 offer를 보내라" 조건 충족:
        // 방에 2명이 되면, 이제 막 들어온 두 번째 참가자에게 "start-offer"를 보냅니다.
        if (count === 2) {
          // 기존 대기자(첫 번째) 찾기
          const others = [...room.keys()].filter(id => id !== peerId);
          const targetPeerId = others[0];
          // 새로 들어온 사람(ws)에게 "상대방에게 offer 시작" 지시
          send(ws, { type: 'start-offer', roomId, targetPeerId });
        }

        break;
      }

      case 'signal': {
        const { roomId, to, payload } = data;
        const room = ROOMS.get(roomId);
        if (!room) return;

        const target = room.get(to);
        if (target && target.readyState === 1) {
          // 서버는 가공 없이 "그대로 전달"만 합니다.
          send(target, { type: 'signal', from: ws.meta.peerId, roomId, payload });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const { roomId, peerId } = ws.meta;
    if (!roomId || !peerId) return;

    const room = ROOMS.get(roomId);
    if (!room) return;

    room.delete(peerId);
    // 나간 사실을 같은 방에 알림(디버깅/표시용)
    broadcast(roomId, { type: 'peer-left', roomId, peerId });

    // 방이 비면 정리
    if (room.size === 0) ROOMS.delete(roomId);
  });
});
