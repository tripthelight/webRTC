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

// --- NEW: 방 상태를 관리할 메모리 저장소(아주 단순한 버전)
const ROOMS = new Map(); // roomName -> Set<WebSocket>

function getRoom(roomName) {
  if (!ROOMS.has(roomName)) ROOMS.set(roomName, new Set());
  return ROOMS.get(roomName);
}

wss.on("connection", (ws) => {
  console.log("[server] WS connected");
  ws.send(JSON.stringify({ type: "welcome", ts: Date.now() }));

  // --- NEW: 이 소켓이 어떤 방에 소속됐는지 추적
  ws._roomName = null;

  ws.on("message", (data) => {
    const text = data.toString();
    let msg;
    try { msg = JSON.parse(text); } catch {
      ws.send(JSON.stringify({ type: "error", reason: "invalid-json" }));
      return;
    }

    // --- NEW: join 메시지 처리
    if (msg.type === "join") {
      const roomName = String(msg.room || "room1")
      const room = getRoom(roomName) // ROOMS에서 찾음

      // 아직 방에 안들어와 있었다면 등록
      if (ws._roomName && ws._roomName !== roomName) {
        // 다른 방에 있던 소켓이 다시 조인 요청한 경우 이전 방에서 제거
        const prev = getRoom(ws._roomName);
        prev.delete(ws);
      }

      // 방 정원 체크(2명까지만)
      if (room.size >= 2) {
        ws.send(JSON.stringify({ type: "room-full", room: roomName }));
        return;
      }

      room.add(ws);
      ws._roomName = roomName;

      // 역할 결정: 방 인원이 1명이면 impolite, 2명이면 polite
      const role = (room.size === 1) ? "impolite" : "polite";
      ws._role = role;

      ws.send(JSON.stringify({
        type: "role",
        room: roomName,
        role,
        peers: room.size
      }));

      // (선택) 같은 방의 다른 사람에게도 현재 인원수를 알림
      for (const peer of room) {
        if (peer !== ws && peer.readyState === peer.OPEN) {
          peer.send(JSON.stringify({
            type: "peer-join",
            room: roomName,
            peers: room.size,
          }));
        }
      }
      return;
    }

    // NEW (Step 4): 시그널 메시지 릴레이
    if (msg.type === "signal") {
      const roomName = ws._roomName;
      if (!roomName) {
        ws.send(JSON.stringify({ type: "error", reason: "not-in-room" }));
        return;
      }
      const room = getRoom(roomName);
      for (const peer of room) {
        if (peer !== ws && peer.readyState === peer.OPEN) {
          peer.send(JSON.stringify({
            type: "signal",
            room: roomName,
            payload: msg.payload ?? null
          }));
        }
      }
      return;
    }

    // (에코는 그대로 유지: 테스트용)
    ws.send(JSON.stringify({ type: "echo", data: text }));
  });

  ws.on("close", () => {
    // --- NEW: 방에서 떠날 때 정리
    if (ws._roomName) {
      const room = getRoom(ws._roomName);
      room.delete(ws);
      // (선택) 남은 사람에게 인원수 알림
      for (const peer of room) {
        if (peer.readyState === peer.OPEN) {
          peer.send(JSON.stringify({
            type: "peer-leave",
            room: ws._roomName,
            peers: room.size
          }));
        }
      }
    }
    console.log("[server] WS closed");
  });
});


const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || '220.71.2.177';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
