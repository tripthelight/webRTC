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

const ROOMS = Object.create(null);
const PEERS = new WeakMap();

const now = () => Date.now();
const makeRoomId = () => `room-${Math.random().toString(36).slice(2, 10)}`;

function findWaitingRoom() {
  for (const id in ROOMS) {
    const room = ROOMS[id];
    if (room && room.clients.size === 1) return room;
  };
  return null;
};
function createRoom() {
  const id = makeRoomId();
  ROOMS[id] = {
    id,
    clients: new Map(),
    createdAt: now(),
  };
  return ROOMS[id];
};

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
};

function broadcast(room, obj) {
  for (const [, sock] of room.clients) {
    safeSend(sock, obj);
  };
};
function deleteRoomIfEmpty(roomId) {
  const room = ROOMS[roomId];
  if (!room) return;
  if (room.clients.size === 0) {
    delete ROOMS[roomId];
  }
};

function cbConnection(ws) {
  const peerId = randomUUID();
  let room = findWaitingRoom();
  if (!room) room = createRoom();
  room.clients.set(peerId, ws);
  PEERS.set(ws, { peerId, roomId: room.id });
  const role = (room.clients.size === 1) ? "impolite" : "polite";
  safeSend(ws, {
    type: "room-assigned",
    roomId: room.id,
    peerId,
    role
  });
  if (room.clients.size === 2) {
    const peers = Array.from(room.clients.keys());
    const [impolitePeerId, politePeerId] = peers;
    const rolesByPeer = {
      [impolitePeerId]: "impolite",
      [politePeerId]: "polite",
    };
    for (const [id, sock] of room.clients) {
      const partnerId = (id === impolitePeerId) ? politePeerId : impolitePeerId;
      safeSend(sock, {
        type: "paired",
        roomId: room.id,
        you: { peerId: id, role: rolesByPeer[id] },
        partner: { peerId: partnerId, role: rolesByPeer[partnerId] }
      });
    };
  }

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; };
    const meta = PEERS.get(ws);
    if (!meta) return;
    const room = ROOMS[meta.roomId];
    if (!room) return;
    if (msg?.type === "signal" && msg?.to) {
      const target = room.clients.get(msg.to);
      if (target) {
        safeSend(target, {
          type: "signal",
          from: meta.peerId,
          data: msg.data
        })
      }
    }
  });

  ws.on("close", () => {
    const meta = PEERS.get(ws);
    if (!meta) return;
    const { peerId, roomId } = meta;
    const room = ROOMS[roomId];
    if (room) {
      room.clients.delete(peerId);
      broadcast(room, { type: "partner-left", roomId, peerId });
      deleteRoomIfEmpty(roomId);
    }
    PEERS.delete(ws);
  });
};

wss.on("connection", cbConnection);
