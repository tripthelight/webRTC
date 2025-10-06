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
const HOST = process.env.RTC_HOST || '220.71.2.152';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});

// --- 추가: 방 상태(A/B 두 칸) ---
const rooms = new Map(); // roomId -> { A?: ws, B?: ws }

function safeSend(ws, data) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}

// 새 클라이언트가 붙으면 "connection" 이벤트 발생
wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAdress; // 접속한 클라이언트 IP
  console.log("연결됨:", ip);

  // --- 추가: 이 소켓이 어느 방/어느 칸에 앉았는지 저장 ---
  ws.meta = { roomId: null, slot: null };

  // --- 추가: 클라이언트가 보낸 메시지 처리 (join만) ---
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'join') return;

    const { roomId } = msg;
    if (!roomId) return;

    let room = rooms.get(roomId);
    if (!room) { room = {}; rooms.set(roomId, room); }

    // A가 비었으면 A에 앉히고 "대기 중"이라고만 알려줌
    if (!room.A) {
      room.A = ws;
      ws.meta = { roomId, slot: 'A' };
      safeSend(ws, { type: 'joined', slot: 'A', waiting: true });
      return;
    }

    // B가 비었으면 B에 앉힘 (이 시점엔 아직 역할/SDP 없음)
    if (!room.B) {
      room.B = ws;
      ws.meta = { roomId, slot: 'B' };
      safeSend(ws, { type: 'joined', slot: 'B', waiting: false });

      // === [추가 ①] 두 명이 모였으니, 역할(role)만 양쪽에 통지 ===
      // 규칙(세션 동안만 유효):
      //  - A: polite=true,  isStarter=false  (대기: offer 안 만듦)
      //  - B: polite=false, isStarter=true   (시작: offer 만들 주체)
      const a = room.A;
      const b = room.B;
      safeSend(a, {
        type: 'role',
        you:  { slot: 'A', polite: true,  isStarter: false },
        peer: { slot: 'B', polite: false, isStarter: true  }
      });
      safeSend(b, {
        type: 'role',
        you:  { slot: 'B', polite: false, isStarter: true  },
        peer: { slot: 'A', polite: true,  isStarter: false }
      });
      // === [추가 ①] 끝 ===

      return;
    }

    // 둘 다 차면 거절
    safeSend(ws, { type: 'full' });
  });

  // 브라우저 탭이 닫히거나 새로고침하면 close 발생
  ws.on('close', () => {
    console.log('🚪 종료됨:', ip);
    // --- 추가: 자리를 비워 줌(깨끗하게) ---
    const { roomId, slot } = ws.meta || {};
    const room = roomId && rooms.get(roomId);
    if (!room) return;
    if (slot === 'A' && room.A === ws) room.A = undefined;
    if (slot === 'B' && room.B === ws) room.B = undefined;
    if (!room.A && !room.B) rooms.delete(roomId);
  });
});
