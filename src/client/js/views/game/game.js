import {Signaling} from '../../../ws/signaling.js';
import {createManualPeer} from '../../../rtc/manualPeer.js';
import {createPeer} from '../../../rtc/peerPN.js';

const logEl = document.getElementById('log');
const roleEl = document.getElementById('role');
const countEl = document.getElementById('count');
const btn = document.getElementById('connect');
const roomInput = document.getElementById('room');

const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const renegotiateBtn = document.getElementById('renegotiateBtn');
const restartIceBtn = document.getElementById('restartIceBtn');
const clearLogBtn = document.getElementById('clearLogBtn');

function log(...args) {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ');
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

const SIGNALING_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
const signaling = new Signaling(SIGNALING_URL);

let roomName = null;
let peer = null;
let currentCount = 0;
let lastRole = "-";

btn.addEventListener("click", async () => {
  const room = roomInput.value.trim();
  if (!room) { alert('방 이름을 입력해 주세요'); return; };
  roomName = room;

  if (!signaling.connected) {
    log("WS 연결 시도...");
    try {
      await signaling.connect();
      log("WS 연결 완료");
    } catch(e) {
      log("WS 연결 실패: ", e.message);
      return;
    };
  };

  signaling.join(room);
  log(`방 참여 요청: ${room}`);
});

function makePeer(role) {
  if (peer) { try { peer.close(); } catch {} }

  lastRole = role;
  peer = createPeer({
    role,
    sendSignal: (payload) => signaling.signal(roomName, payload),
    log,
    onNeedHardReset: () => {
      log('[MAIN] Peer 하드 리셋 요청 수신 → 새 Peer 생성');
      makePeer(lastRole);              // 같은 role로 새로 만듦(역할 고정이 중요한 서비스가 아니라면 OK)
      if (currentCount === 2) {
        log('[MAIN] 재생성 후 즉시 start()');
        peer.start();
      }
    }
  });

  // 콘솔에서 통제 편의
  window.startStats = (ms=3000)=>peer.startStats(ms);
  window.stopStats = ()=>peer.stopStats();
}

// 서버에서 오는 이벤트 바인딩
signaling.on("joined", ({ room, you, role, count }) => {
  log(`방 "${room}" 참여 완료. 내 id=${you}, role=${role}`);
  roleEl.textContent = `role: ${role}`;
  currentCount = count;
  countEl.textContent = `peers: ${count}`;

  // peer 생성(Perfect Negotiation 포함)
  makePeer(role);

  // impolite는 보통 DataChannel을 먼저 만드니,
  // 연결 유도를 위해 "눈꼽만큼"의 SDP 흐름을 트리거하고 싶다면
  // createDataChannel을 이미 peer.js에서 impolite가 수행합니다.

  // 상대가 이미 방에 있었다면 count===2일 수 있으니 즉시 체크
  if (currentCount === 2) {
    log("두 명이 방에 있습니다. 협상 시작");
    peer.start();
  };
});

signaling.on("peer-count", ({ count }) => {
  const prev = currentCount;
  currentCount = count;
  countEl.textContent = `peer: ${count}`;
  log(`현재 방 인원: ${count}`);

  // 1 -> 2로 변화되는 순간에만 시작
  if (prev === 1 && count === 2 && peer) {
    log("두 명이 되었습니다. 협상 시작.");
    peer.start();
  };

  // 2 -> 1 로 줄면: 상대가 나간 것. 여기서는 대기만
  // 다음 참가자가 들어오면 다시 1 -> 2 이벤트에서 start()가 호출됩니다.
});

// WS 재연결 후 자동 재합류됨
signaling.on("reconnected", ({ room }) => {
  log(`[WS] 재연결됨 -> 방("${room}") 재합류 완료(서버 수락 후 'joined' 올 것)`)
})

// /////////////////////////////////////////////////////

// 핵심: 시그널 라우팅
signaling.on("signal", ({ payload }) => {
  if (!peer) return;
  peer.handleSignal(payload);
});

// 기타 이벤트
signaling.on("closed", () => {
  log("WS 연결 종료");
});
signaling.on("error", ({ message }) => {
  log("서버 에러: ", message);
});

// ===== UI 핸들러 =====
sendBtn.addEventListener('click', () => {
  sendChat();
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

renegotiateBtn.addEventListener('click', async () => {
  if (!peer) return log('peer 없음');
  await peer.renegotiate();
});

restartIceBtn.addEventListener('click', () => {
  if (!peer) return log('peer 없음');
  peer.restartIce();
});

clearLogBtn.addEventListener('click', () => {
  logEl.textContent = '';
});

// 편의 함수
function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  if (!peer) return log('peer가 없습니다');
  if (peer.send(text)) {
    log(`Me => ${text}`);
    chatInput.value = '';
  } else {
    log('DataChannel 아직 open 아님');
  }
}

// 창/탭 닫힐 때 정리
window.addEventListener('beforeunload', () => {
  try { peer?.close(); } catch {}
});

// ====== 네트워크/가시성 이벤트로 부드러운 복구 유도 ======
window.addEventListener('online', () => {
  if (!peer) return;
  console.log('[net] online → 재협상 시도');
  peer.renegotiate();
});
window.addEventListener('offline', () => {
  console.log('[net] offline');
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!peer) return;
    console.log('[page] visible → 가볍게 ICE 재시작');
    peer.restartIce();
  }
});
