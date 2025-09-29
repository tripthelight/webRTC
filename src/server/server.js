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

// 새 연결이 오면
wss.on('connection', (ws) => {
  console.log('[WS] client connected');

  // 어떤 메시지를 받으면, 보낸 사람을 제외한 모두에게 중계
  ws.on('message', (data) => {
    for (const client of wss.clients) {
      if (client !== ws && client.readyState === client.OPEN) {
        client.send(String(data));
      }
    }
  });

  ws.on('close', () => console.log('[WS] client disconnected'));
});

const PORT = process.env.RTC_PORT || 5000;
const HOST = process.env.RTC_HOST || '220.71.2.177';
server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});
