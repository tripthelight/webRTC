import PerfectNegotiator from "../../common/PerfectNegotiator.js";

const servers = {
  iceServers: [
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
};

const ws = new WebSocket('ws://59.186.79.36:5000');
const roomName = sessionStorage.getItem('roomName') || 'my-room';

const pn = new PerfectNegotiator({
  rtcConfig: servers,
  send: (msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ roomName, ...msg }));
  },
  onData: (text) => console.log('받은 메시지 : ', text),
  onOpen: () => console.log('데이터채널 OPEN'),
  onConnStateChange: (state) => console.log('PC state : ', state),
});

ws.addEventListener('open', () => {
  console.log('WebSocket client OPEN');
  ws.send(JSON.stringify({ type: 'join', roomName }));
});

ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  pn.handleSignal(msg); // role/description/candidate 모두 여기로
});