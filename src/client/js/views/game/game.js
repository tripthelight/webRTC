import "../../../scss/common.scss";
// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import {scheduleRefresh} from "../../common/refreshScheduler.js"

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
scheduleRefresh();

// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
const ws = new WebSocket(WS_URL);

let myRole = { slot: null, polite: null, isStarter: null };
let pc = null;   // 내 RTCPeerConnection (한 번만 만든다)
let dc = null;   // 내 DataChannel (Starter일 때 만들고, 수신측은 ondatachannel로 받음)

// STEP 1: 안정적인 clientId + roomId 파싱 + 화면 로그
// - 아직 서버/RTC 없음
// - 새로고침(F5) 난타해도 clientId가 변하지 않도록 localStorage에 저장

const $log = document.getElementById('log') || (() => {
  const d = document.createElement('div'); d.id = 'log';
  d.style.whiteSpace = 'pre-wrap'; d.style.background = '#f7f7f7';
  d.style.padding = '12px'; d.style.borderRadius = '8px';
  document.body.appendChild(d); return d;
})();

function log(...a){ $log.textContent += a.join(' ') + '\n'; console.log(...a); }

// 1) 새로고침에도 변하지 않는 고정 clientId
function getClientId() {
  const k = 'webrtc.clientId';
  let id = localStorage.getItem(k);
  if (!id) {
    id = (crypto.randomUUID?.() || 'cid-' + Math.random().toString(36).slice(2));
    localStorage.setItem(k, id);
  }
  return id;
}

// 2) URL의 ?room= 값 사용, 없으면 기본값 'room1'
function getRoomId() {
  const u = new URL(location.href);
  return u.searchParams.get('room') || 'room1';
}

const clientId = getClientId();
const roomId = getRoomId();

log('🆔 clientId:', clientId);
log('🏠 roomId:', roomId);
log('✅ 준비 완료 (다음 단계에서 서버 연결)');

function ensurePC() {
  if (pc) return pc; // 이미 있으면 재사용

  // 1) 아주 기본 PC 생성 (ICE 서버 설정은 다음 단계에서 필요 시 추가)
  pc = new RTCPeerConnection();

  // 2) 디버깅용 로그: 연결 상태 변화 감지
  pc.onconnectionstatechange = () => {
    log("pc.connectionState = ", pc.connectionState)
  }

  // 3) 원격에서 DataChannel을 "보내요면" 수신측은 여기서 잡힙니다.
  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    dc.onopen = () => log("dataChannel(open) - 수신측");
    dc.onmessage = (e) => log("recv:", e.data);
    log("ondatachannel: 채널을 수신했습니다.(아직 시그널링 없음)")
  }

  // 4) 협상 필요 이벤트 - ** 다음 단계에서 ** offer/answer 로직을 붙입니다.
  pc.onnegotiationneeded = () => {
    log("onnegotiationneeded (다음 단계에서 처리할 예정)")
  }

  return pc;
}

// 기존 open 핸들러를 '조금' 확장: 접속되면 join 전송 1줄 추가
ws.addEventListener('open', () => {
  log('🔗 signaling connected');
  ws.send(JSON.stringify({ type: 'join', roomId, clientId })); // ← 추가 1줄
});

// --- 추가: 서버 응답(join 결과)만 처리 ---
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === 'joined') {
    // waiting=true면 내가 A로 먼저 앉아 상대 대기 중
    log(`🪑 자리 배정: slot=${msg.slot}, 대기중=${msg.waiting}`);
  } else if (msg.type === 'full') {
    log('🚫 방이 가득 찼습니다(2인 전용).');
  } else if (msg.type === 'role') {
    myRole = msg.you;
    log(`🎭 역할 확정 → slot=${myRole.slot}, polite=${myRole.polite}, isStarter=${myRole.isStarter}`);

    // 1) 내 RTCPeerConnection을 준비(없으면 생성)
    ensurePC();

    // 2) 내가 Starter라면, "보내는 쪽" dataChannel을 지금 '만들기만' 합니다.
    //    (실제 연결은 다음 단계의 offer/answer 시그널링이 붙은 뒤 열립니다)
    if (myRole.isStarter) {
      dc = pc.createDataChannel('game'); // 채널 이름 'game' (임의)
      dc.onopen = () => log('📡 dataChannel(open) — 시작측');
      dc.onmessage = (e) => log('📨 recv:', e.data);
      log('🧪 Starter이므로 dataChannel을 생성만 했습니다. (아직 SDP 전송 없음)');
    }
  }
});

ws.addEventListener('close', () => log('🔌 signaling closed'));
ws.addEventListener('error', (e) => log('⚠️ signaling error', e?.message || e.type));
