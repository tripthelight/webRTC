import dotenv from 'dotenv';
dotenv.config();
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';

const PORT = process.env.RTC_PORT || 8081;
const wss = new WebSocketServer({ port: PORT });

// roomName -> Map(clientId -> socket)
const rooms = new Map();

// (roomName:from) -> 최신 attemptId (가장 최근 시도만 통과)
const latestAttemptByKey = new Map();

function getRoom(roomName) {
  if (!rooms.has(roomName)) rooms.set(roomName, new Map());
  return rooms.get(roomName);
}

function broadcastPeerList(roomName) {
  const room = getRoom(roomName);
  const peers = [...room.keys()];
  const msg = JSON.stringify({ type: 'peer-list', roomName, peers });
  room.forEach((sock) => { try { sock.send(msg); } catch {} });
}

function shouldForwardSignal(roomName, from, attemptId) {
  const key = `${roomName}:${from}`;
  const latest = latestAttemptByKey.get(key);
  if (!latest || attemptId > latest) latestAttemptByKey.set(key, attemptId);
  return attemptId === latestAttemptByKey.get(key);
}

wss.on('connection', (socket) => {
  let joinedRoom = null;
  let clientId = null;

  socket.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'join') {
      const { roomName, clientId: cid } = msg;
      if (!roomName || !cid) return;
      joinedRoom = roomName; clientId = cid;
      const room = getRoom(roomName);
      room.set(clientId, socket);
      broadcastPeerList(roomName);
      return;
    }

    if (msg.type === 'signal') {
      const { roomName, from, to, action, attemptId } = msg;
      if (!roomName || !from || !to || !action || !attemptId) return;
      if (!shouldForwardSignal(roomName, from, attemptId)) return; // 최신 시도만 중계

      const room = getRoom(roomName);
      const peerSock = room.get(to);
      if (!peerSock || peerSock.readyState !== 1) return;
      try { peerSock.send(JSON.stringify({ type: 'signal', ...msg })); } catch {}
      return;
    }
  });

  socket.on('close', () => {
    if (joinedRoom && clientId) {
      const room = getRoom(joinedRoom);
      room.delete(clientId);
      broadcastPeerList(joinedRoom);
    }
  });
});

console.log(`[signaling] ws://localhost:${PORT} ready`);