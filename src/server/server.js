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

/** roomName -> Array<ws> (2인 룸) */
const ROOMS = new Map();

wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    let data;
    try { data = JSON.parse(buf.toString()); } catch { return; }
    const { type } = data;

    if (type === 'join') {
      const { room, id } = data;
      ws.room = room;
      ws.id = id;

      if (!ROOMS.has(room)) ROOMS.set(room, []);
      const peers = ROOMS.get(room);

      if (peers.length >= 2) {
        ws.send(JSON.stringify({ type: 'room-full' }));
        ws.close();
        return;
      };

      // 먼저: role 통지
      // 먼저 들어온 피어 = impolite(false), 두 번째 피어 = polite(true)
      const polite = peers.length === 1;
      peers.push(ws);
      ws.send(JSON.stringify({ type: 'role', polite }));


      // 모두에게 입장 알림(선택)
      peers.forEach(p => {
        if (p !== ws) p.send(JSON.stringify({ type: 'peer-joined', id }));
      });

      // 2명이 되면 양쪽에 'paired'를 보내 협상 시작 신호를 줌
      if (peers.length === 2) {
        const [p0, p1] = peers;
        p0.send(JSON.stringify({ type: 'paired', orderId: p1.id }));
        p1.send(JSON.stringify({ type: 'paired', orderId: p0.id }));
      };
      return;
    }

    if (type === 'signal') {
      const peers = ROOMS.get(ws.room) || [];
      peers.forEach(p => {
        if (p !== ws) {
          p.send(JSON.stringify({
            type: 'signal',
            from: ws.id,
            payload: data.payload
          }));
        }
      });
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    const list = ROOMS.get(room) || [];
    const idx = list.indexOf(ws);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) ROOMS.delete(room);
    else list.forEach(p => p.send(JSON.stringify({ type: 'peer-left', id: ws.id })));
  });
});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || "59.186.79.36";
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
