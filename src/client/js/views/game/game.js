import PerfectNegotiator from "../../common/PerfectNegotiator.js";

const servers = {
  iceServers: [
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
};

const room = new URLSearchParams(location.search).get('room') || 'room1';
const id = (crypto?.randomUUID && crypto.randomUUID()) || String(Math.random());

// ====== WebSocket (시그널) ======
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${wsProto}://${location.hostname}:5000`);
