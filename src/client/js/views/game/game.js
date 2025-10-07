import "../../../scss/common.scss";
// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import {scheduleRefresh} from "../../common/refreshScheduler.js"

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
// scheduleRefresh();

// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
// const ws = new WebSocket(WS_URL);

// 목표: 두 번째 입장자가 DataChannel을 만들며 offer를 보내고,
//      Perfect Negotiation 기본 구조로 글레어를 흡수.
//      새로고침 시 자동 재접속(단일 새로고침)까지 지원.

// ======== 설정(실험/개발용) ========
const ROOM_ID = 'dev-room-1'; // 같은 ROOM_ID를 가진 2개의 브라우저 탭/창으로 테스트

// ======== 페이지 요소 ========
const $log = document.getElementById('log');
const $text = document.getElementById('text');
const $sendBtn = document.getElementById('sendBtn');

// ======== 유틸 ========
function log(...args) {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  $log.textContent += line + '\n';
  $log.scrollTop = $log.scrollHeight;
}
function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) || Math.random().toString(36).slice(2) + Date.now().toString(36);
}
// === [추가] 작은 랜덤 유틸 ===
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ======== 상태 변수 ========
let ws;                 // 시그널링용 WebSocket
let pc;                 // RTCPeerConnection
let dc;                 // DataChannel (offerer가 생성)
let polite = false;     // Perfect Negotiation에서 "공손한 쪽" (글레어 시 더 유연)
let iAmOfferer = false; // 두 번째 입장자라면 true
const clientId = sessionStorage.getItem('clientId') || (() => {
  const id = uuid();
  sessionStorage.setItem('clientId', id);
  return id;
})();

// Perfect Negotiation 관련 플래그 (표준 패턴)
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;

// === [추가] 안전한 재협상 큐 ===
// 여러 이벤트가 몰려도 한 번에 setLocalDescription 하도록 직렬화/디바운스합니다.
let negotiateQueued = false;
async function negotiateSafely(options = {}) {
  if (!pc) return;
  if (negotiateQueued) return; // 이미 예약됨

  queueMicrotask(async () => {
    negotiateQueued = false;
    try {
      makingOffer = true;
      log('[negotiation] safe-offer start', options);
      const offer = await pc.createOffer(options); // options.iceRestart 지원
      await pc.setLocalDescription(offer);
      sendSignal({ type: 'description', description: pc.localDescription });
      log('[negotiation] safe-offer done');
    } catch (e) {
      log('[negotiation] safe-offer error', e?.message || e);
    } finally {
      makingOffer = false;
    }
  });
}

// === [추가] ICE Restart 스케줄러 ===
let iceRestartTimer = null;
function canOffer() {
  // 서버가 '두 번째 입장자 = offerer'를 주도하지만,
  // 글레어를 피하기 위해 여기서는 'offerer 이거나 polite'일 때만 우리가 오퍼를 시도
  return !!pc && (iAmOfferer || polite);
}
function maybeScheduleIceRestart() {
  if (!canOffer()) return;
  if (!canIceRestartNow()) { log('[ice-restart] rate-limited'); return; } // [추가]
  if (iceRestartTimer) return;

  iceRestartTimer = setTimeout(async () => {
    iceRestartTimer = null;
    if (!pc) return;
    if (ws?.readyState !== WebSocket.OPEN) { log('[ice-restart] skipped: WS not ready'); return; }
    iceRestartTimes.push(Date.now()); // [추가] 실제 시도 시점 기록
    log('[ice-restart] trying');
    await negotiateSafely({ iceRestart: true });
  }, 400); // 300~800ms 범위 내에서 환경에 맞게 조절 가능
}

// === [추가] WS 재연결 상태 ===
let wsRetryCount = 0;
let wsReconnectTimer = null;

function jitter(ms) {
  // 0.7~1.3배 사이 무작위 지터
  const j = 0.3 * ms;
  return Math.floor(ms + (Math.random() * (2*j) - j));
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  // 아주 작은 지수 백오프 (최대 3초), 새로고침 난타 시 서버 부하 최소화
  const base = Math.min(3000, 300 * Math.pow(1.7, wsRetryCount++));
  const delay = jitter(base);
  log(`[WS] reconnect in ${delay}ms`);
  wsReconnectTimer = setTimeout(async () => {
    wsReconnectTimer = null;
    try {
      await connectSignaling(); // 재연결 시도
      wsRetryCount = 0;         // 성공하면 초기화
      // 재연결 직후, 연결이 불안정하면 ICE Restart 1회 시도 (offer 가능한 경우)
      if (pc && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')) {
        maybeScheduleIceRestart();
      }
    } catch {
      // 실패해도 scheduleWsReconnect가 재호출됨
    }
  }, delay);
}

// === [추가] Offerer 시작 지연으로 글레어 감쇠 ===
let offererStartTimer = null;
function startAsOffererWithJitter() {
  if (!pc) return;
  if (offererStartTimer) return;
  const delay = randInt(120, 320); // 120~320ms 사이 지연
  log(`[offerer] start after ${delay}ms`);
  offererStartTimer = setTimeout(() => {
    offererStartTimer = null;
    if (!pc) return;
    // 이미 채널이 있으면 생략
    if (dc && dc.readyState !== 'closed') {
      log('[offerer] skip: dc already exists');
      return;
    }
    try {
      dc = pc.createDataChannel('chat'); // 이 순간 onnegotiationneeded 트리거
      wireDataChannel('outbound(createDataChannel, jittered)');
    } catch (e) {
      log('[offerer] createDataChannel error', e?.message || e);
    }
  }, delay);
}

// === [추가] ICE Restart 빈도 제한 ===
const ICE_RESTART_WINDOW_MS = 10000; // 10초
const ICE_RESTART_MAX = 2;           // 10초에 최대 2회
let iceRestartTimes = [];
function canIceRestartNow() {
  const now = Date.now();
  iceRestartTimes = iceRestartTimes.filter(t => now - t < ICE_RESTART_WINDOW_MS);
  return iceRestartTimes.length < ICE_RESTART_MAX;
}

// === [추가] 게임 상태 재수화(샘플 스텁)
// 실제 게임에서는 여기서 현재 라운드/점수/남은 시간/준비 상태 등을
// DataChannel로 주고받고, 수신 시 화면을 다시 그리세요.
function rehydrateGameState(peerId) {
  log('[rehydrate] run with peerId =', peerId);
  // 예시:
  // dc.send(JSON.stringify({ t: 'STATE', payload: yourCurrentGameState }));
  // 수신측 onmessage에서 t==='STATE'이면 UI를 해당 상태로 재구성
}

// ======== 시그널링 WebSocket 연결 ========
function connectSignaling() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      log('[WS] opened');
      wsRetryCount = 0; // 성공했으니 카운터 리셋
      ws.send(JSON.stringify({ type: 'join', roomId: ROOM_ID, clientId }));
      // 역할 수신 후 ensurePeerConnection() 호출 흐름은 동일
    };

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      const { type } = msg;

      if (type === 'role') {
        // 서버가 내려준 역할: 두 번째 입장자는 offerer:true, polite:true
        polite = !!msg.polite;
        iAmOfferer = !!msg.offerer;
        log(`[role] polite=${polite}, iAmOfferer=${iAmOfferer}`);
        // 역할을 받은 뒤에 PeerConnection을 준비합니다.
        ensurePeerConnection();
        return;
      }

      if (type === 'peer-joined') {
        log('[peer] joined');
        return;
      }

      if (type === 'peer-left') {
        log('[peer] left -> 연결을 정리하고 대기 상태로');
        cleanupPeer();
        // 상대가 나갔으니, 우리는 다시 '첫 번째'처럼 대기: 다음 사람이 들어오면 그가 offerer가 됨
        return;
      }

      if (type === 'description') {
        // 상대의 SDP(offer/answer) 수신
        const desc = msg.description;
        await onRemoteDescription(desc);
        return;
      }

      if (type === 'candidate') {
        // 상대 ICE 후보 수신
        const cand = msg.candidate;
        try {
          await pc?.addIceCandidate(cand || null);
        } catch (e) {
          // description 처리 타이밍 이슈로 실패할 수 있음 -> 무시(Perfect Negotiation 권장)
          log('[ice] addIceCandidate error (ignored)', e?.message || e);
        }
        return;
      }
    };

    ws.onerror = (e) => {
      log('[WS] error', e.message || e);
      // 즉시 재연결 스케줄 (중복 방지)
      scheduleWsReconnect();
    };

    ws.onclose = () => {
      log('[WS] closed');
      // 재연결 스케줄 (중복 방지)
      scheduleWsReconnect();
    };
  });
}

// ======== RTCPeerConnection 생성 및 Perfect Negotiation 기본기 ========
function ensurePeerConnection() {
  if (pc) return; // 이미 있으면 재사용

  // STUN 서버(공용) — 로컬/사내망이면 제거해도 무방하나, 기본값으로 둡니다.
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  // (핵심) onnegotiationneeded: 로컬의 "협상 필요" 이벤트 발생 시,
  // offer를 만들고 setLocalDescription -> 상대에게 SDP 전송
  pc.onnegotiationneeded = async () => {
  log('[negotiation] need');
  // 안전 큐를 통해 단일 offer로 수렴
  await negotiateSafely();
};

  // ICE 후보 발견 시 상대에게 전달
  pc.onicecandidate = ({ candidate }) => {
    sendSignal({ type: 'candidate', candidate });
  };

  pc.onconnectionstatechange = () => {
    log('[pc.state]', pc.connectionState);

    // 연결이 끊어졌거나 실패한 경우, 우리가 오퍼 가능한 쪽이면(offerer 또는 polite),
    // 과도한 재시도를 막기 위해 짧은 쿨다운 후 ICE Restart를 1회 시도합니다.
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      maybeScheduleIceRestart();
    }
  };

  // 상대가 만든 DataChannel을 수신(우리는 "첫 번째"일 때 채널을 만들지 않음)
  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    wireDataChannel('inbound(ondatachannel)');
  };

  // 내가 두 번째(offerer)이면, 입장 즉시 DataChannel을 하나 만들어 협상을 유도
  if (iAmOfferer) {
    startAsOffererWithJitter();
  }
}

function wireDataChannel(hint) {
  if (!dc) return;

  log(`[dc] wired (${hint})`);
  dc.onopen = () => {
    log('[dc] open');
    // [추가] 채널 열리면 간단한 헬로 핸드셰이크 전송
    try { dc.send(JSON.stringify({ t: 'HELLO', from: clientId })); } catch {}
  };

  dc.onclose = () => {
    log('[dc] close');
    // (STEP 2에서 추가했던 재생성 로직 유지)
    if (iAmOfferer && pc && (pc.connectionState === 'connected' || pc.connectionState === 'connecting')) {
      setTimeout(() => {
        if (!pc) return;
        if (!dc || dc.readyState === 'closed') {
          try {
            dc = pc.createDataChannel('chat');
            wireDataChannel('recreate(after close)');
          } catch (e) {
            log('[dc] recreate error', e?.message || e);
          }
        }
      }, 300);
    }
  };

  dc.onmessage = (ev) => {
    // [변경] 간단한 프로토콜(JSON 시도 → 실패 시 원문 로그)
    try {
      const data = JSON.parse(ev.data);
      if (data?.t === 'HELLO') {
        log('[dc] HELLO from', data.from);
        try { dc.send(JSON.stringify({ t: 'HELLO-ACK', from: clientId })); } catch {}
        rehydrateGameState(data.from); // 상태 재수화 트리거
        return;
      }
      if (data?.t === 'HELLO-ACK') {
        log('[dc] HELLO-ACK from', data.from);
        rehydrateGameState(data.from); // 상태 재수화 트리거
        return;
      }
    } catch {
      // JSON 아니면 기존대로 바로 출력
    }
    log('[dc] recv:', ev.data);
  };
}

// 원격 SDP 처리 (Perfect Negotiation 정석 패턴)
async function onRemoteDescription(description) {
  const offerCollision =
    description.type === 'offer' &&
    (
      makingOffer ||
      pc.signalingState !== 'stable'
    );

  ignoreOffer = !polite && offerCollision;
  if (ignoreOffer) {
    // 내가 공손하지 않(polite:false)고, 이미 내 쪽에서도 offer을 만들고 있었다면,
    // 이 offer는 무시하여 글레어를 회피 (표준 패턴)
    log('[pn] ignore remote offer (not polite & collision)');
    return;
  }

  try {
    if (offerCollision) {
      // 공손한 쪽(polite:true)은 rollback으로 상태를 안정화한 뒤 원격 offer를 반영
      log('[pn] rollback due to collision');
      await Promise.all([
        pc.setLocalDescription({ type: 'rollback' }),
        pc.setRemoteDescription(description),
      ]);
    } else {
      await pc.setRemoteDescription(description);
    }

    if (description.type === 'offer') {
      // 원격이 offer를 보냈다면, 우리는 answer 생성/전송
      isSettingRemoteAnswerPending = true;
      await pc.setLocalDescription(await pc.createAnswer());
      sendSignal({ type: 'description', description: pc.localDescription });
    } else {
      // 원격이 answer를 보낸 경우: 로컬에 이미 offer가 있었고, 이제 협상 완료 단계
    }
  } catch (e) {
    log('[pn] onRemoteDescription error', e?.message || e);
  } finally {
    isSettingRemoteAnswerPending = false;
  }
}

// ======== 시그널 전송 헬퍼 ========
function sendSignal(payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ roomId: ROOM_ID, clientId, ...payload }));
  } else {
    // WS가 아직 준비되지 않았다면 그냥 건너뜁니다(서버 부하 최소화).
    // 필요한 경우 WS 재연결 후 onconnectionstatechange에서 ICE Restart가 보완합니다.
    log('[signal] skipped (WS not open)', payload?.type);
  }
}

// ======== 정리(cleanup) ========
function cleanupPeer() {
  try { dc && dc.close(); } catch {}
  try { pc && pc.close(); } catch {}
  dc = null;
  pc = null;
  // 다음 상대를 기다리며 '첫 번째'처럼 대기: 역할은 서버가 새로 지정
}

// ======== UI 이벤트 ========
$sendBtn.onclick = () => {
  if (dc && dc.readyState === 'open') {
    const text = $text.value || '';
    dc.send(text);
    log('[dc] send:', text);
    $text.value = '';
  } else {
    log('[dc] not open yet');
  }
};

// ======== 새로고침/종료 시 서버에 가볍게 알림(선택) ========
window.addEventListener('pagehide', () => {
  try {
    ws?.send(JSON.stringify({ type: 'leave', roomId: ROOM_ID, clientId }));
  } catch {}
});

// ======== 시작 ========
(async function start() {
  log('clientId:', clientId);
  await connectSignaling();
  // 역할(role) 수신 후 ensurePeerConnection()이 호출됩니다.
})();
