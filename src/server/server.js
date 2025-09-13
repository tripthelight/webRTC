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

server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname !== '/ws') {
    socket.destroy(); // 다른 경로는 업그레이드 거절
    return;
  };
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, searchParams);
  });
});

wss.on('connection', (ws, req, searchParams) => {
  const roomId = searchParams.get('room') || 'test';

})

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || "59.186.79.36";
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
