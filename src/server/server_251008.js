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

// ROOMS[roomId] = { A?: WebSocket, B?: WebSocket }
const ROOMS = Object.create(null);
const peerOf = (room, slot) => (slot === 'A' ? room.B : room.A);

wss.on('connection', (ws, req) => {
  // 1) roomId 추출 (없으면 'default')
  const roomId = new URL(req.url, 'http://x').searchParams.get('room') || 'default';
  const room = ROOMS[roomId] || (ROOMS[roomId] = { A: null, B: null });

  // 2) 빈 슬롯 배정: A -> B -> 가득이면 거절
  const slot = !room.A ? 'A' : (!room.B ? 'B' : null);
  if (!slot) { ws.send(JSON.stringify({ type: 'room-full', roomId })); return ws.close(); }
  room[slot] = ws; ws._roomId = roomId; ws._slot = slot;

  // 3) 내게 역할 알림 (B만 polite=true)
  ws.send(JSON.stringify({
    type: 'joined',
    roomId,
    slot,
    polite: slot === 'B',          // 역할 고정(충돌 억제용)
    otherReady: !!peerOf(room, slot) // ← 상대가 이미 있으면 true (내가 "두 번째" 입장자)
  }));

  // 4) 상대가 이미 있으면 "들어옴" 통지 (선택: 디버깅용)
  const other = peerOf(room, slot);
  if (other && other.readyState === other.OPEN) {
    other.send(JSON.stringify({ type: 'peer-joined', roomId, slot }));
  }

  // 5) 시그널 릴레이: {type:'signal', payload:...} 그대로 상대에게 전달
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m?.type !== 'signal') return;
    const peer = peerOf(ROOMS[ws._roomId] || {}, ws._slot);
    if (peer && peer.readyState === peer.OPEN) {
      peer.send(JSON.stringify({ type: 'signal', roomId: ws._roomId, from: ws._slot, payload: m.payload }));
    }
  });

  // 6) 연결 종료 시 정리 + 상대에게 "나감" 알림
  ws.on('close', () => {
    const r = ROOMS[ws._roomId]; if (!r) return;
    if (r[ws._slot] === ws) r[ws._slot] = null;
    const peer = peerOf(r, ws._slot);
    if (peer && peer.readyState === peer.OPEN) {
      peer.send(JSON.stringify({ type: 'peer-left', roomId: ws._roomId, slot: ws._slot }));
    }
    if (!r.A && !r.B) delete ROOMS[ws._roomId]; // 방 비면 정리
  });
});
