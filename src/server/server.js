import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// roomId => Set<WebSocket>
const rooms = new Map();

/* server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 원하는 경로만 허용 (선택)
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // 최종 업그레이드 완료 후 connection 이벤트 발생시킴
      wss.emit('connection', ws, req);
    });
  } catch (e) {
    socket.destroy();
  }
}); */

wss.on('connection', (ws, req, searchParams) => {
  // console.log('searchParams : ', searchParams);
  // const roomId = searchParams.get('room') || 'test';

  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') ?? 'test';

  // console.log('searchParams :', url.searchParams.toString());
  // console.log('roomId :', roomId);

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  };
  const room = rooms.get(roomId);
  const polite = room.size === 1; // 0명일 때 들어오면 impolite(false), 1명일 때 들어오면 polite(true)
  room.add(ws);

  // 입장 알림(나에게)
  ws.send(JSON.stringify({ type: 'joined', room: roomId, count: room.size, polite }));

  // 방의 다른 사람에게 입장 브로드캐스트
  for (const peer of room) {
    if (peer !== ws) {
      peer.send(JSON.stringify({ type: 'peer-join', room: roomId, count: room.size, polite }));
    };
  };

  ws.on('message', (buf) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString()); } catch { return; };
    // 간단 릴레이: 같은 방의 다른 사람에게만 전달
    for (const peer of room) {
      if (peer !== ws && peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify({ type: 'relay', data: msg }));
      };
    };
  });

  ws.on('close', () => {
    const r = rooms.get(roomId);
    if (!r) return;
    r.delete(ws);
    if (r.size === 0) rooms.delete(roomId);
    else {
      // 남아 있는 사람에게 퇴장 브로드캐스트
      for (const peer of r) {
        peer.send(JSON.stringify({ type: 'peer-leave', room: roomId, count: r.size }));
      };
    };
  });
});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || "59.186.79.10";
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
