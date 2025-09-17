import PerfectNegotiator from '../../common/PerfectNegotiator.js';
import {createSignaling} from '../../../ws/signaling.js';
import {createManualPeer} from '../../../rtc/manualPeer.js';
import {createPeerPN} from '../../../rtc/peerPN.js';

const servers = {
  iceServers: [
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
};

const room = new URL(location.href).searchParams.get('room') || 'test';
const signaling = createSignaling(room);

uiInit();
log(`[Step4] room=${room} 웹소켓 연결 시도`);
await signaling.waitOpen();
log('[Step4] WS 연결됨');

let peer = null;
let polite = null;

// 서버 3단계 구현은 들어오자마자 joined/peer-join 등을 던집니다.
// 여기서는 joined가 오면 peer 인스턴스 생성만 해두고,
// 이후, 'signal' 메시지를 받으면 peer.handleSignal 로 넘깁니다.
signaling.onMessage(async msg => {
  if (msg.type === 'joined') {
    // --- joined ------------------------------------
    polite = !!msg.polite;
    log(`[WS] joined count=${msg.count}, polite=${polite}`);
    if (!peer) peer = createPeerPN({polite, signaling, log});
    // 방에 이미 2명인 상태로 합류했다면(내가 두 번째) -> 바로 킥
    if (msg.count === 2) {
      peer.ensureNegotiationKick?.();
    }
  } else if (msg.type === 'peer-join') {
    // --- peer-join ---------------------------------
    log(`[WS] peer-join count=${msg.count}`);
    if (!peer && polite !== null) peer = createPeerPN({polite, signaling, log});
    // 상대가 '지금' 들어왔다면 -> 이 타이밍에 킥
    peer.ensureNegotiationKick?.();
  } else if (msg.type === 'relay' && msg.data?.type === 'signal') {
    // --- relay -------------------------------------
    if (!peer && polite !== null) peer = createPeerPN({polite, signaling, log});
    await peer.handleSignal(msg.data.data);
  } else if (msg.type === 'peer-leave') {
    // --- peer-leave --------------------------------
    log(`[WS] peer-leave count=${msg.count}`);
    // 상대가 떠났다면: 내 쪽 RTCPeerConnection을 정리하고 "새 연결 받을 준비" 상태로 전환
    try {
      peer?.close();
    } catch {}
    peer = null;
    // 이제 방에 "나만" 남았으므로, 다음 상대가 들어오면 내가 impolite가 어어되어 채널을 먼저 만들어야 함
    polite = false;
    // 새 피어를 미리 만들어 둔다(상대가 들어오면 즉시 킥 가능)
    if (polite !== null) {
      peer = createPeerPN({polite, signaling, log});
      // 여기서는 아직 eensureNegotiationKick를 호출하지 않음
      // -> 상대가 들어와 'peer-join'을 발생시킬 때 즉시 킥
    }
  }
});

// --- UI ---
function uiInit() {
  const wrap = document.createElement('div');
  wrap.style.margin = '12px 0';
  const btnCall = document.createElement('button');
  btnCall.textContent = '📞 Call (offer 시작)';
  const input = document.createElement('input');
  input.placeholder = '메시지';
  const btnSend = document.createElement('button');
  btnSend.textContent = 'Send';
  const btnClear = document.createElement('button');
  btnClear.textContent = 'Clear';
  btnClear.style.width = '100%';
  btnClear.style.padding = '6px';

  btnCall.onclick = () => {
    log('지금 단계에서는 Call 버튼이 동작하지 않습니다. (다음 단계에서 자동 협상으로 대체)');
  };
  btnSend.onclick = () => {
    if (!peer) return;
    const text = input.value.trim();
    if (!text) return;
    peer.send(text);
    log(`[dc] send: ${text}`);
    input.value = '';
  };

  wrap.append(btnCall, document.createTextNode(' '), input, btnSend);
  document.body.appendChild(wrap);
  document.body.appendChild(btnClear);

  // 로그 박스
  let el = document.getElementById('log');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'log';
    el.style.whiteSpace = 'pre-wrap';
    el.style.background = '#111';
    el.style.color = '#ddd';
    el.style.padding = '12px';
    el.style.height = '260px';
    el.style.overflow = 'auto';
    document.body.appendChild(el);
  }

  btnClear.onclick = () => {
    el.textContent = '';
    el.scrollTop = el.scrollHeight;
  };
}

function log(s) {
  console.log(s);
  const el = document.getElementById('log');
  el.textContent += s + '\n';
  el.scrollTop = el.scrollHeight;
}

/*
const room = new URLSearchParams(location.search).get('room') || 'room1';
const id = (crypto?.randomUUID && crypto.randomUUID()) || String(Math.random());

// ====== WebSocket (시그널) ======
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${wsProto}://${location.hostname}:5000`);
*/
