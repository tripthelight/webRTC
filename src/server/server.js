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

/**
 * 설계 요점
 * - 방은 항상 최대 2명.
 * - 첫 번째 입장자는 impolite, 두 번째 입장자는 polite 로 역할 고정.
 * - 2명이 차면 방은 "locked"처럼 취급되고, 다음 접속자는 새 방으로.
 * - 서버는 SDP/ICE를 저장하지 않고, 오직 상대방에게 relay만 수행 -> 서버 작업 최소화.
 * - 동시성:
 *    - 한 tick 안에서 다수 접속이 와도 Map/Set 기반 원자적 갱신으로 정합성 유지.
 *    - 소켓 종료 시 확실히 방에서 제거하고, 필요하면 방 자체를 정리(cleanup).
 */

// 방 상태: roomId -> Set<WebSocket>
const ROOMS = new Map();
// 소켓 메타: ws -> { roomId, peerId, role: 'polite'|'impolite' }
const META = new WeakMap();

// 대기 중(1명만 있는) 방 큐처럼 사용: 가장 먼저 만든 미완성 방의 id 보관
let waitingRoomId = null;

/** 안전 송신 유틸 (닫힌 소켓 예외 방지) */
function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/** 방에 있는 "상대방"을 찾아서 반환 (없으면 null) */
function getPeer(ws) {
  const meta = META.get(ws);
  if (!meta) return null;
  const { roomId } = meta;
  const set = ROOMS.get(roomId);
  if (!set) return null;
  for (const other of set) {
    if (other !== ws && other.readyState === other.OPEN) return other;
  }
  return null;
}

/** 방 정리: 빈 방이면 삭제, 한 명만 남으면 waitingRoomId로 승격 */
function cleanupRoom(roomId) {
  const set = ROOMS.get(roomId);
  if (!set) return;
  // 살아있는 소켓만 남기기
  for (const ws of [...set]) {
    if (ws.readyState !== ws.OPEN) set.delete(ws);
  }
  if (set.size === 0) {
    ROOMS.delete(roomId);
    if (waitingRoomId === roomId) waitingRoomId = null;
  } else if (set.size === 1) {
    // 1명만 남은 방은 다음 입장자를 기다리는 대기방으로 지정
    waitingRoomId = roomId;
  } else if (set.size >= 2) {
    // 꽉 찬 방은 대기방 자격 제거
    if (waitingRoomId === roomId) waitingRoomId = null;
  }
}

/** 새 소켓을 방에 배정하고 역할을 부여 */
function assignRoom(ws) {
  // 1) 기존 대기방이 있으면 그 방에 투입, 아니면 새 방 생성
  let roomId = waitingRoomId;
  if (!roomId || !ROOMS.has(roomId) || ROOMS.get(roomId).size >= 2) {
    roomId = nanoid(8);
    ROOMS.set(roomId, new Set());
    waitingRoomId = roomId;
  }
  const set = ROOMS.get(roomId);

  // 2) peerId/role 결정: 먼저 들어오면 impolite, 두 번째는 polite
  const peerId = nanoid(10);
  const role = set.size === 0 ? 'impolite' : 'polite';

  set.add(ws);
  META.set(ws, { roomId, peerId, role });

  // 3) 본인에게 조인 정보 통지
  safeSend(ws, { type: 'joined', roomId, peerId, role });

  // 4) 방 상태에 따라 ready 여부 전파
  if (set.size === 2) {
    // 2명 찼으니 더 이상 대기방이 아님
    waitingRoomId = null;

    // 양쪽에게 ready 방송
    for (const sock of set) {
      // 상대 peerId 알려주기 (클라에서 디버깅 편의)
      const peer = [...set].find(s => s !== sock);
      const peerMeta = META.get(peer);
      safeSend(sock, { type: 'ready', roomId, peerId: peerMeta?.peerId ?? null });
    }
  }
}

/** 상대에게 전달(relay) 가능한 타입만 허용 (보안/최적화) */
const RELAY_TYPES = new Set([
  'signal', // 이후 단계에서 SDP/ICE를 담아 전달할 때 사용 (이번 단계에서는 쓰지 않음)
]);

wss.on('connection', (ws) => {
  // 접속 즉시 방 배정
  assignRoom(ws);

  ws.on('message', (data) => {
    // 이번 단계에서는 프로토콜 최소화: JSON 파싱 + 허용 타입만 상대에게 중계
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return; // 잘못된 페이로드는 무시 (서버 작업 최소화)
    }

    // 허용 타입만 relay
    if (RELAY_TYPES.has(msg.type)) {
      const peer = getPeer(ws);
      if (peer) {
        // 원본 발신자 메타 최소 포함 (서버는 내용 알 필요 없음)
        const from = META.get(ws);
        safeSend(peer, { ...msg, from: { peerId: from?.peerId, role: from?.role } });
      }
    }
  });

  ws.on('close', () => {
    // 방에서 제거하고 정리
    const meta = META.get(ws);
    if (meta) {
      const set = ROOMS.get(meta.roomId);
      if (set) set.delete(ws);
      META.delete(ws);
      cleanupRoom(meta.roomId);
      // 남아있는 상대에게 "peer-left" 알림 (다음 단계에서 재협상 트리거에 활용 예정)
      const survivor = (ROOMS.get(meta.roomId) ?? new Set()).values().next().value;
      if (survivor) {
        safeSend(survivor, { type: 'peer-left', roomId: meta.roomId });
      }
    }
  });

  ws.on('error', () => {
    // 에러는 close와 동일하게 취급 (서버 잡무 최소화)
    ws.close();
  });
});
