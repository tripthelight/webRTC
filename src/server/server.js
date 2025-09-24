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

app.use(express.static(path.join(__dirname, '..', 'client', 'public')));

/**
 * room: Map<string, Set<WebSpcket>>
 * 각 ws에는 { id, room, role } 를 속성으로 부여
 */
const rooms = new Map();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};

function broadcast(roomName, obj) {
  const set = rooms.get(roomName);
  if (!set) return;
  for (const peer of set) send(peer, obj);
};

function updateCount(roomName) {
  const set = rooms.get(roomName);
  const count = set ? set.size : 0;
  broadcast(roomName, { type: "peer-count", count });
};

wss.on("connection", (ws) => {
  ws.id = randomUUID();

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch (e) { return send(ws, { type: 'error', message: 'Invalid JSON' }); };

    // join ------------------------------------
    if (msg.type === "join") {
      const roomName = String(msg.room || '').trim();
      if (!roomName) return send(ws, { type: 'error', message: 'room required' });

      let set = rooms.get(roomName);
      if (!set) { set = new Set(); rooms.set(roomName, set); };

      if (set.size >= 2) {
        return send(ws, { type: 'error', message: 'room full (max 2)' });
      };

      // 먼저 들어온 사람: impolite, 두 번째: polite
      ws.room = roomName;
      ws.role = (set.size === 0 ? "impolite" : "polite");
      set.add(ws);

      send(ws, { type: 'joined', room: roomName, you: ws.id, role: ws.role, count: set.size });
      updateCount(roomName);
      return;
    };

    // signal ----------------------------------
    if (msg.type === "signal") {
      const { room, payload } = msg;
      if (!room || !rooms.get(room)) return;
      for (const peer of rooms.get(room)) {
        if (peer !== ws) send(peer, { type: 'signal', from: ws.id, payload });
      }
      return;
    };

    send(ws, { type: 'error', message: `unknown type: ${msg.type}` });
  });

  ws.on("close", () => {
    const roomName = ws.room;
    if (roomName && rooms.has(roomName)) {
      const set = rooms.get(roomName);
      set.delete(ws);
      if (set.size === 0) rooms.delete(roomName);
      else updateCount(roomName);
    };
  });
});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || '220.71.2.79';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
