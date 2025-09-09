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

// 정적 파일 서빙 (클라이언트)
app.use(express.static(path.join(__dirname, 'public')));

// ---- 메모리 내 룸/멤버 저장소 ----
// ROOMS: Map<roomName, { members: Map<clientId, ws> }>
const ROOMS = new Map();

// 유틸: 문자 ID 정렬
const sortIds = (ids) => ids.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// 역할 계산(결정론적): 작은 clientId = impolite = dataChannel owner, 큰 clientId = polite
export function computeRole(roomName, clientId) {
  const room = ROOMS.get(roomName);
  const ids = room ? sortIds([...room.members.keys()]) : [clientId];

  // 상대가 있는 경우만 2명으로 가정(2인 룸)
  const peerId = ids.find((id) => id !== clientId) || null;

  // 2명 기준으로 역할 판정
  let impoliteId = null;
  let politeId = null;
  if (ids.length >= 2) {
    impoliteId = ids[0];
    politeId = ids[1];
  } else {
    // 상대가 없을 때: 일단 자신이 impolite(상대 들어와도 규칙은 고정식이니 나중에 재계산됨)
    impoliteId = clientId;
  }

  return {
    polite: clientId === politeId,
    dcOwner: clientId === impoliteId,
    peerClientId: peerId
  };
}

// HTTP 역할 API (리로드해도 같은 규칙으로 결정)
app.get('/api/rooms/:room/role', (req, res) => {
  const roomName = req.params.room;
  const clientId = req.query.clientId;
  if (!roomName || !clientId) return res.status(400).json({ error: 'roomName and clientId required' });
  try {
    const role = computeRole(roomName, clientId);
    res.json(role);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- WebSocket 시그널링 ----
const wss = new WebSocketServer({ server, path: '/ws' });

// 룸 내 모든 멤버에게 현재 멤버 리스트 브로드캐스트
function broadcastRoomMembers(roomName) {
  const room = ROOMS.get(roomName);
  if (!room) return;
  const members = [...room.members.keys()];
  const payload = JSON.stringify({ type: 'room:members', members });
  for (const ws of room.members.values()) {
    safeSend(ws, payload);
  }
}

// 안전 전송
function safeSend(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(data);
}

wss.on('connection', (ws) => {
  let roomName = null;
  let clientId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // 최초 등록
    if (msg.type === 'hello') {
      roomName = String(msg.roomName || '');
      clientId = String(msg.clientId || '');
      if (!roomName || !clientId) return;

      // 룸 확보
      if (!ROOMS.has(roomName)) ROOMS.set(roomName, { members: new Map() });
      const room = ROOMS.get(roomName);

      // 기존 연결 정리(중복 로그인/리로드 대비)
      if (room.members.has(clientId)) {
        try { room.members.get(clientId)?.close(); } catch {}
        room.members.delete(clientId);
      }
      room.members.set(clientId, ws);

      // 본인에게 ack, 현재 멤버 목록 통지
      safeSend(ws, JSON.stringify({ type: 'hello:ack', roomName, clientId }));

      // 모두에게 멤버정보 브로드캐스트 (클라가 이걸 보고 역할 재조회)
      broadcastRoomMembers(roomName);
      return;
    }

    // 시그널 릴레이
    if (msg.type === 'signal') {
      const { to, payload } = msg;
      if (!roomName || !clientId || !to) return;
      const room = ROOMS.get(roomName);
      const peerWs = room?.members.get(String(to));
      if (peerWs) {
        safeSend(peerWs, JSON.stringify({
          type: 'signal',
          from: clientId,
          payload // { kind: 'sdp'|'ice', data: ... }
        }));
      }
      return;
    }
  });

  ws.on('close', () => {
    if (roomName && clientId) {
      const room = ROOMS.get(roomName);
      if (room) {
        room.members.delete(clientId);
        if (room.members.size === 0) {
          ROOMS.delete(roomName);
        } else {
          broadcastRoomMembers(roomName);
        }
      }
    }
  });
});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || "59.186.79.36";
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
