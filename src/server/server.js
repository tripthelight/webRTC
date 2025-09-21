import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import http from 'http';
import {WebSocketServer} from 'ws';
import path from 'path';
import {fileURLToPath} from 'url';
import {json} from 'stream/consumers';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({server});

app.use(express.static(path.join(__dirname, '..', 'client', 'public')));

// roomId -> Set<SebSocket>
const rooms = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') ?? 'test';
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  const room = rooms.get(roomId);
  room.add(ws);

  // 입장 알림 (나에게)
  ws.send(JSON.stringify({type: 'jponed', room: roomId, count: room.size}));

  // 방의 다른 사람들에게 입장 브로드케스팅
  for (const peer of room) {
    if (peer !== ws) {
      peer.send(JSON.stringify({type: 'peer-join', room: roomId, count: room.size}));
    }
  }

  ws.on('message', buf => {
    let msg = null;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    // 간단 릴레이: 같은 방의 다른 사람에게만 전달
    for (const peer of room) {
      if (peer !== ws && peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify({type: 'relay', data: msg}));
      }
    }
  });

  ws.on('close', () => {
    const r = rooms.get(roomId);
    if (!r) return;
    r.delete(ws);
    if (r.size === 0) rooms.delete(roomId);
    else {
      // 남아있는 사람들에게 퇴장 브로드캐스트
      for (const peer of r) {
        peer.send(JSON.stringify({type: 'peer-leave', room: roomId, count: r.size}));
      }
    }
  });
});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || '220.71.2.152';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
