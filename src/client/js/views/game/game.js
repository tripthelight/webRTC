// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import { scheduleRefresh } from "../../common/refreshScheduler.js"

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
scheduleRefresh();

// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
const ws = new WebSocket(WS_URL);

const logEl = document.getElementById('log');
const log = (...args) => { console.log(...args); logEl.textContent += args.join(' ') + '\n'; };

// ---- 환경 설정 ----
const room = new URLSearchParams(location.search).get('room') || 'demo-room';
const clientId = localStorage.getItem('clientId') || (() => {
  const id = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
  localStorage.setItem('clientId', id);
  return id;
})();

// ---- 시그널링 WS ----
const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

let polite = false;           // 두 번째 입장자 = polite
let slot = null;              // 'a' or 'b'
let partnerReady = false;     // 파트너 준비 완료
let started = false;          // datachannel 생성 1회만

// datachannel 참조
let pc; // 동적으로 만들고 없앱니다.
let dc = null; // datachannel 참조

// Perfect Negotiation core flags
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;

// ICE 후보 큐
let pendingCandidates = [];

// 오퍼 감시자(타이머)
let offerWatchdog = null;

function flushPendingCandidates() {
  if (!pc || !pc.remoteDescription) return;
  const toApply = pendingCandidates;
  pendingCandidates = [];
  (async () => {
    for (const c of toApply) {
      try { await pc.addIceCandidate(c); } catch {}
    }
    // log('[ice] flushed', toApply.length, 'candidates');
  })();
}

function startOfferWatchdog(delayMs = 3500) {
  if (slot !== 'a') return;      // impolite('a')만 수행 → 과잉 재시작 방지
  if (offerWatchdog) return;     // 중복 방지
  offerWatchdog = setTimeout(() => {
    offerWatchdog = null;
    // 여전히 응답 대기 중이면(recv answer 전) 재시작 예약
    if (pc && pc.signalingState === 'have-local-offer') {
      log('[wd] no answer yet → schedule iceRestart');
      scheduleIceRestart(600);   // STEP 3의 함수 재사용
    }
  }, delayMs);
}
function clearOfferWatchdog() {
  if (offerWatchdog) { clearTimeout(offerWatchdog); offerWatchdog = null; }
}

let iceRestartTimer = null;

function scheduleIceRestart(ms = 1500) {
  // impolite('a')만 재시작을 시도 → 서버/시그널링 트래픽 최소화
  if (slot !== 'a') return;
  if (iceRestartTimer) return; // 중복 방지(디바운스)
  iceRestartTimer = setTimeout(async () => {
    iceRestartTimer = null;
    try {
      if (!partnerReady || !pc) return;
      log('[ice] restart -> send offer with iceRestart');
      makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      send({ type: 'signal', payload: { description: pc.localDescription } });
      log('[signal] sent offer(iceRestart)');
      startOfferWatchdog();
    } catch (e) {
      log('[ice] restart error:', e.message);
    } finally {
      makingOffer = false;
    }
  }, ms);
}

// PC 이벤트 바인딩 함수(작게!)
function attachPCEvents() {
  pc.onnegotiationneeded = async () => {
    if (!partnerReady) return; // 파트너 준비 전에는 서버부담 줄이기
    try {
      log('[pc] onnegotiationneeded -> create/sent offer');
      makingOffer = true;
      await pc.setLocalDescription();
      send({ type: 'signal', payload: { description: pc.localDescription } });
      log('[signal] sent offer');
      startOfferWatchdog();
    } catch (err) {
      log('onnegotiationneeded error:', err.message);
    } finally {
      makingOffer = false;
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'signal', payload: { candidate: e.candidate } });
  };

  pc.onconnectionstatechange = () => {
    log('[pc] state:', pc.connectionState);
    if (pc.connectionState === 'connected') clearOfferWatchdog();
    // 'disconnected'가 잠깐(와이파이 전환 등) 나올 수 있으니, 바로가 아닌 예약 재시작
    if (pc.connectionState === 'disconnected') scheduleIceRestart(2000);
    // 'failed'는 빠르게 재시작 예약
    if (pc.connectionState === 'failed') scheduleIceRestart(500);
  };

  pc.onsignalingstatechange = () => {
    // 안정 상태가 되면 감시자 정리
    if (pc.signalingState === 'stable') clearOfferWatchdog();
  };

  pc.ondatachannel = (e) => {
    if (dc) return;
    dc = e.channel;
    dc.onopen = () => log('[dc] open (remote-created)');
    dc.onmessage = (ev) => log('[dc] msg:', ev.data);
    log('[dc] received');
  };
}

// 새 PC를 만들고 이벤트 연결
function createPeer() {
  // 새로운 PC로 갈아끼우기
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  makingOffer = false;
  ignoreOffer = false;
  isSettingRemoteAnswerPending = false;
  dc = null; // DC는 새 협상에서 다시 생깁니다.
  attachPCEvents();
  log('[pc] created');
}

// 파트너 이탈/리셋 시 깨끗하게 정리
function teardownPeer() {
  try { if (dc) { dc.onopen = dc.onmessage = null; dc.close(); } } catch {}
  try { if (pc) { pc.onnegotiationneeded = pc.onicecandidate = pc.ondatachannel = pc.onconnectionstatechange = null; pc.close(); } } catch {}
  dc = null;
  pc = null;
  log('[pc] torn down');
}

// 추가: WS open 직후 join 보내는 기존 코드 위/아래 아무 데나 OK
createPeer();

// ---- WS 핸들링 ----
ws.addEventListener('open', () => {
  log('WS open, join room:', room, 'clientId:', clientId);
  send({ type: 'join', room, clientId });
});

ws.addEventListener('message', async (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === 'role') {
    slot = msg.slot;
    polite = !!msg.polite;
    log(`[role] slot=${slot}, polite=${polite}`);
    return;
  }

  if (msg.type === 'partner-ready') {
    partnerReady = true;
    log('[partner] ready');

    // 조건: 첫 번째 입장자(impolite, slot==='a')가 datachannel을 만들어 협상을 시작
    if (!started && slot === 'a') {
      started = true;
      dc = pc.createDataChannel('game');
      dc.onopen = () => log('[dc] open');
      dc.onmessage = (e) => log('[dc] msg:', e.data);
      log('[dc] created by first joiner -> will trigger negotiation');
    }
    return;
  }

  if (msg.type === 'partner-left') {
    log('[partner] left');
    partnerReady = false; // 다음 접속을 기다립니다.
    started = false; // 첫 입장자가 다시 DC를 만들 수 있도록 초기화
    teardownPeer(); // 이전 연결 자원 정리
    createPeer(); // 새 연결 준비 (WS는 유지, 서버부담 없음)
    return;
  }

  if (msg.type === 'signal') {
    const { payload } = msg;
    if (payload?.description) {
      const desc = payload.description;
      log('[signal] remote description:', desc.type);

      const readyForOffer = pc.signalingState === 'stable' || isSettingRemoteAnswerPending;
      const offerCollision = desc.type === 'offer' && (!readyForOffer || makingOffer);

      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) {
        log('[perfect-negotiation] glare: ignoring offer (we are impolite)');
        return;
      }

      try {
        // polite가 offer 충돌을 만났다면 rollback 후 수용(권장 패턴)
        if (polite && offerCollision) {
          log("[perfect-negotiation] polite rollback for glare")
          await pc.setLocalDescription({ type: "rollback" })
        }

        isSettingRemoteAnswerPending = desc.type === 'answer';
        await pc.setRemoteDescription(desc);
        isSettingRemoteAnswerPending = false;

        // ★ 원격 SDP가 세팅되었으니 큐에 쌓인 후보를 플러시
        flushPendingCandidates();

        if (desc.type === 'offer') {
          // 우리는 answer를 보냅니다.
          await pc.setLocalDescription();
          send({ type: 'signal', payload: { description: pc.localDescription } });
          log('[signal] sent answer');
        } else if (desc.type === 'answer') {
          // answer를 받았으니 오퍼 감시자는 해제
          clearOfferWatchdog();
        }
      } catch (err) {
        log('setRemoteDescription error:', err.message);
      }
      return;
    }

    if (payload?.candidate) {
      try {
        // glare로 remote offer를 일단 무시 중이거나, 아직 remoteDescription이 없다면 → 큐잉
        if (ignoreOffer || !pc.remoteDescription) {
          pendingCandidates.push(payload.candidate);
          // log('[ice] queued candidate');
        } else {
          await pc.addIceCandidate(payload.candidate);
          // log('[ice] addIceCandidate ok');
        }
      } catch (err) {
        log('addIceCandidate error:', err.message);
      }
      return;
    }
  }
});
