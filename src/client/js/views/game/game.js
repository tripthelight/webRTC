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
    // [+] STEP 2: sendSignal 주입
    negotiator = new PerfectNegotiator(pc, {
      polite: msg.polite,
      sendSignal: (payload) => {
        ws.send(JSON.stringify({ type: 'signal', payload }));
      },
    });

    // polite는 수신 대기, impolite는 DC를 '지금은' 만들지 않음 (paired 이후로 미룸)
    pc.ondatachannel = (e) => negotiator.setDataChannel(e.channel);
  };

  if (msg.type === 'paired') {
    // 이제부터 협상/ICE 송신 허용
    negotiator?.markReady();

    // 👇 impolite만 DC 생성 (이 타이밍이면 상대가 존재하므로 offer가 유실되지 않음)
    if (!negotiator?.polite && !negotiator?.dc) {
      const dc = pc.createDataChannel('chat');
      negotiator.setDataChannel(dc);
    }
  }

  if (msg.type === 'signal') {
    // [+] STEP 2: SDP와 ICE 모두 클래스에 위임
    await negotiator?.receiveSignal(msg.payload);
  };
});
