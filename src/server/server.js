import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import http from 'http';
import {WebSocketServer} from 'ws';
import path from 'path';
import {fileURLToPath} from 'url';
import {json} from 'stream/consumers';
import { randomUUID } from 'crypto';
import { nanoid } from "nanoid";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({server});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || '220.71.2.152';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});

// ———————————————————————————————————————————————————

// ---------- 룸/피어 상태 ----------
/**
 * ROOMS 구조:
 * {
 *   [roomId]: {
 *     id: string,
 *     clients: Map<peerId, WebSocket>, // 현재 룸에 붙은 피어 소켓
 *     createdAt: number
 *   }
 * }
 */
const ROOMS = Object.create(null);

/**
 * 피어 상태 저장:
 * { ws -> { peerId, roomId } }
 * - 소켓 종료 시 역참조로 빠르게 방/피어 정리
 */
const PEERS = new WeakMap();

// ---------- 유틸 ----------
const now = () => Date.now();
const makeRoomId = () => `room-${Math.random().toString(36).slice(2, 10)}`;

/**
 * 현재 "1명만" 있는(=대기중) 방을 하나 찾는다.
 * - 없으면 null
 * - 단일 스레드 이벤트 루프이므로 간단 검색으로도 원자성 보장(동시성 안전)
 */
function findWaitingRoom() {
  for (const id in ROOMS) {
    const room = ROOMS[id];
    if (room && room.clients.size === 1) return room;
  }
  return null;
}

function createRoom() {
  const id = makeRoomId();
  ROOMS[id] = {
    id,
    clients: new Map(),
    createdAt: now(),
  };
  return ROOMS[id];
}

function deleteRoomIfEmpty(roomId) {
  const room = ROOMS[roomId];
  if (!room) return;
  if (room.clients.size === 0) {
    delete ROOMS[roomId]
  }
}

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(room, obj) {
  for (const [, sock] of room.clients) {
    safeSend(sock, obj);
  }
}

wss.on('connection', (ws, req) => {
  // 1) 피어 ID 생성
  const peerId = randomUUID();

  // 2) 입장할 방 고르기: 대기중(1명) 방이 있으면 그 방, 없으면 새 방
  let room = findWaitingRoom();
  if (!room) room = createRoom();

  // 3) 룸에 피어 등록
  room.clients.set(peerId, ws);
  PEERS.set(ws, { peerId, roomId: room.id });

  // 4) 역할(impolite/polite) 부여
  // - 룸 첫 번째 입장자: impolite (선제 오퍼 주체)
  // - 룸 두 번째 입장자: polite   (충돌 시 수용/대기)
  const role = (room.clients.size === 1) ? 'impolite' : 'polite';

  // 5) 자기 자신에게 현재 상태 알림
  safeSend(ws, {
    type: 'room-assigned',
    roomId: room.id,
    peerId,
    role, // Perfect Negotiation에서 사용할 관례적 역할
  });

  // 6) 룸이 2명이 되면 페어링 완료 통지(양쪽 모두에게)
  if (room.clients.size === 2) {
    const peers = Array.from(room.clients.keys());
    // 각 피어별 role 재명시(첫 입장자=impolite, 두 번째=polite)
    const [impolitePeerId, politePeerId] = peers; // 이 순서 보장: 먼저 들어온 순서대로 저장됨
    const rolesByPeer = {
      [impolitePeerId]: 'impolite',
      [politePeerId]: 'polite',
    };

    // 두 피어에게 "상대 ID, 내 역할"을 명시한 paired 이벤트 전송
    for (const [id, sock] of room.clients) {
      const partnerId = (id === impolitePeerId) ? politePeerId : impolitePeerId;
      safeSend(sock, {
        type: 'paired',
        roomId: room.id,
        you: { peerId: id, role: rolesByPeer[id] },
        partner: { peerId: partnerId, role: rolesByPeer[partnerId] },
        // 다음 단계(STEP 2)에서 이 시점에 WebRTC 즉시 시작(버튼 없이) 로직 연결
      });
    }
  }

  // 7) 클라이언트가 시그널 릴레이를 보낼 수도 있으므로(다음 단계 대비) 메시지 수신 준비
  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    const meta = PEERS.get(ws);
    if (!meta) return;
    const room = ROOMS[meta.roomId];
    if (!room) return;

    // (미리 정의) 시그널 릴레이: { type: 'signal', to: peerId, data: any }
    // - 다음 단계에서 RTCPeerConnection의 SDP/ICE를 여기에 실어 보냄
    if (msg?.type === 'signal' && msg?.to) {
      const target = room.clients.get(msg.to);
      if (target) {
        safeSend(target, {
          type: 'signal',
          from: meta.peerId,
          data: msg.data,
        });
      }
    }
  });

  ws.on('close', () => {
    const meta = PEERS.get(ws);
    if (!meta) return;
    const { peerId, roomId } = meta;
    const room = ROOMS[roomId];
    if (room) {
      room.clients.delete(peerId);
      // 남은 상대에게 "파트너 퇴장" 통지 -> 다음 연결 시도/정리 판단 근거
      broadcast(room, { type: 'partner-left', roomId, peerId });
      deleteRoomIfEmpty(roomId);
    }
    PEERS.delete(ws);
  });
});
