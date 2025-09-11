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

const pc = new RTCPeerConnection(servers);

let negotiator = null;

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'join', room, id }));
});

ws.addEventListener('message', async (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === 'role') {
    negotiator = new PerfectNegotiator(pc, { polite: msg.polite });

    // 로컬 ICE를 신호 서버로 중계
    negotiator.onLocalIce = (cand) => {
      ws.send(JSON.stringify({ type: 'signal', payload: { ice: cand } }));
    };

    console.log(`[STEP 1] 내 역할: ${msg.polite ? 'polite(true)' : 'impolite(false)'}`);

    // impolite 쪽이 먼저 DC를 만드는 기본 패턴
    if (!msg.polite) {
      const dc = pc.createDataChannel('chat');
      negotiator.setDataChannel(dc);
    } else {
      pc.ondatachannel = (e) => {
        negotiator.setDataChannel(e.channel);
      };
    };
  };

  if (msg.type === 'signal') {
    const { payload } = msg;
    // 1단계에서는 ICE만 수신 처리 (SDP는 다음 단계에서)
    if (payload.ice) {
      try { await pc.addIceCandidate(payload.ice); }
      catch(err) { console.warn(`addIceCandidate error (STEP 1) : `, err); };
    };
  };
});
