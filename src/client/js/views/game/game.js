// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import {scheduleRefresh} from "../../common/refreshScheduler.js"

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
scheduleRefresh();

// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
// const ws = new WebSocket(WS_URL);

const ROOM_ID = 'room-1';

let ws;
let pc;
let dc; // data channel
let remotePeerId = null; // NEW: 현재 상대의 ws.id

let polite = false;
let peerCount = 0;
let joined = false;

// ICE 재시작(iceRestart) 상태
const ICE_RESTART_DEBOUNCE_MS = 1200;
let iceRestartTimer = null;
let lastIceRestartAt = 0;

let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;

const JOIN_JITTER_MIN = 50;
const JOIN_JITTER_MAX = 200;

function randJitter() {
  return Math.floor(Math.random() * (JOIN_JITTER_MAX - JOIN_JITTER_MIN + 1)) + JOIN_JITTER_MIN;
}

function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    // 동시 새로고침 폭주 완화: 소량 지연 후 1회만 join
    setTimeout(() => {
      if (!joined && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'join', roomId: ROOM_ID }));
        joined = true;
      }
    }, randJitter());
  });

  ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'role') {
      // 역할 수신 → PC 준비 (채널은 아직 만들지 않음)
      polite = !!msg.polite;
      setupPeerConnection();
      // 혹시 이미 2명이라면 즉시 협상 시도
      ensureNegotiation();
      return;
    }

    if (msg.type === 'peer_count') {
      peerCount = msg.count || 0;
      // 두 명이 되었을 때만 impolite가 오퍼 흐름 시작
      ensureNegotiation();
      return;
    }

    if (msg.type === 'signal') {
      // NEW: 처음 본 상대면 등록, 다르면 "상대가 새 세션"으로 간주하고 초기화
      if (!remotePeerId) {
        remotePeerId = msg.from;
      } else if (msg.from !== remotePeerId) {
        handleRemotePeerReplaced(msg.from);
        return; // 이전 세션 신호는 모두 무시
      }
      await onSignal(msg.payload);
      return;
    }

    if (msg.type === 'peer_left') {
      peerCount = msg.count || 0;
      remotePeerId = null; // NEW: 상대가 떠났으니 ID 해제
      // 빠르게 깨끗이 초기화하고, 다음 상대 진입 시 자동 협상되게 함
      resetPeer();
      return;
    }
  });

  // 탭/페이지 내려갈 때 빠른 정리
  window.addEventListener('pagehide', () => {
    try { flushIceCandidates(); } catch {}
    try { ws.send(JSON.stringify({ type: 'leaving' })); } catch {}
    try { ws.close(); } catch {}
  });
}

function sendSignal(payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'signal', payload }));
  }
}

// 핵심: 두 명 있을 때만 impolite가 DataChannel 생성(=offfer 트리거)
function ensureNegotiation() {
  if (!pc) return;
  if (!polite && peerCount === 2 && !dc) {
    dc = pc.createDataChannel('chat');
    bindDC();
    // onnegotiationneeded 에서 오퍼 흐름이 시작됨
  }
}

// Perfect Negotiation 뼈대
async function onSignal(payload) {
  if (payload?.desc) {
    const desc = payload.desc;
    const readyForOffer =
      !makingOffer &&
      (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);
    const offerCollision = desc.type === 'offer' && !readyForOffer;

    // impolite는 충돌 시 무시
    ignoreOffer = !polite && offerCollision;
    if (ignoreOffer) {
      console.log('[PN] ignore remote offer (impolite & collision)');
      return;
    }

    try {
      // ✅ polite가 충돌 상황에서 오퍼를 받으면: 로컬 오퍼 롤백 후 상대 오퍼 수락
      if (desc.type === 'offer' && offerCollision && polite) {
        await pc.setLocalDescription({ type: 'rollback' });
      }

      isSettingRemoteAnswerPending = (desc.type === 'answer');
      await pc.setRemoteDescription(desc);

      // 오퍼를 받았으면 우리가 앤서를 만든다.
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        sendSignal({ desc: pc.localDescription });
      }
    } catch (err) {
      console.warn('[PN] offer/answer handling failed:', err);
      return;
    } finally {
      isSettingRemoteAnswerPending = false;
    }
  } else if (payload?.candidate) {
    try {
      const key = payload.candidate.candidate;
      if (!recvIceKeys.has(key)) {
        recvIceKeys.add(key);
        await pc.addIceCandidate(payload.candidate);
      }
    } catch (err) {
      if (!ignoreOffer) console.warn('addIceCandidate failed:', err);
    }
  } else if (payload?.candidates) {
    // NEW — 배열로 온 후보들을 순차 적용(중복 제거)
    for (const item of payload.candidates) {
      try {
        const key = item.candidate?.candidate;
        if (!key) continue;
        if (recvIceKeys.has(key)) continue;
        recvIceKeys.add(key);
        await pc.addIceCandidate(item.candidate);
      } catch (err) {
        if (!ignoreOffer) console.warn('addIceCandidate(batch) failed:', err);
      }
    }
  }
}

function setupPeerConnection() {
  // 기존 것이 있으면 깨끗이 닫고 새로
  if (pc) {
    try { pc.close(); } catch {}
  }
  pc = new RTCPeerConnection();

  pc.onicecandidate = (e) => {
    // null이면 end-of-candidates → 남은 큐 즉시 전송
    if (!e.candidate) {
      flushIceCandidates();
      return;
    }
    // 후보 문자열을 키로 사용해 중복 제거
    const key = e.candidate.candidate; // SDP 'candidate:' 라인 전체
    if (sentIceKeys.has(key)) return;
    sentIceKeys.add(key);
    iceSendQueue.push({ candidate: e.candidate });
    scheduleIceFlush();
  };

  pc.ondatachannel = (e) => {
    // polite(두 번째) 쪽은 일반적으로 여기서 채널을 받게 됨
    dc = e.channel;
    bindDC();
  };

  pc.onnegotiationneeded = async () => {
    // 여기서 오퍼는 ensureNegotiation -> createDataChannel 이후에만 유효하게 발생
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      sendSignal({ desc: pc.localDescription });
    } catch (err) {
      console.warn('onnegotiationneeded failed:', err);
    } finally {
      makingOffer = false;
    }
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    console.log('pc.connectionState:', st);
    // 실패/끊김이 지속되면 빠르게 초기화하여 재협상 트리거 조건을 충족시키게 함
    if (st === 'failed' || st === 'disconnected') {
      // 1) 우선 ICE 재시작을 시도 (impolite 단일 트리거 + 디바운스)
      scheduleIceRestart(`conn:${st}`);
      // 2) 그래도 회복 안 되면 기존 fallback(빠른 재생성) 유지
      setTimeout(() => {
        if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
          resetPeer();
          ensureNegotiation();
        }
      }, 2000); // 재시작으로 복구할 시간을 조금 더 줌
    }
  };

  // NEW: iceConnectionState도 모니터링(브라우저별 차이를 보완)
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    // 'disconnected'는 네트워크 순간 끊김에서 자주 나타남 → 재시작 예약
    if (st === 'disconnected') scheduleIceRestart(`ice:${st}`);
    if (st === 'failed') scheduleIceRestart(`ice:${st}`);
  };
}

function bindDC() {
  if (!dc) return;
  dc.onopen = () => console.log('DC open');
  dc.onmessage = (e) => console.log('peer:', e.data);
  dc.onclose = () => console.log('DC closed');
}

function resetPeer() {
  if (dc) {
    try { dc.close(); } catch {}
    dc = null;
  }
  if (pc) {
    try { pc.close(); } catch {}
  }
  // NEW: PN 관련 플래그도 초기화 (오래된 상태가 끌려오지 않도록)
  makingOffer = false;
  ignoreOffer = false;
  isSettingRemoteAnswerPending = false;
  // NEW — ICE 배치/중복 상태 초기화
  if (iceFlushTimer) { clearTimeout(iceFlushTimer); iceFlushTimer = null; }
  iceSendQueue = [];
  sentIceKeys.clear();
  recvIceKeys.clear();

  // NEW — ICE 재시작 디바운스/타이머 정리
  if (iceRestartTimer) { clearTimeout(iceRestartTimer); iceRestartTimer = null; }
  // lastIceRestartAt은 유지해도 무방(과도한 재시작 억제)

  setupPeerConnection(); // 역할(polite/impolite)은 유지
  // 채널은 만들지 않음 → peer_count === 2 일 때 ensureNegotiation()이 처리
}

function handleRemotePeerReplaced(newId) {
  console.log('[signal] remote peer replaced:', remotePeerId, '→', newId);
  remotePeerId = newId;
  resetPeer();         // 깨끗이 초기화해서 예전 세션 신호와 분리
  ensureNegotiation(); // 두 명 있고 impolite면 곧바로 재협상 진행
}

// NEW — 짧은 지연 후 묶어서 1회 전송
function scheduleIceFlush() {
  if (iceFlushTimer) return;
  iceFlushTimer = setTimeout(() => {
    iceFlushTimer = null;
    flushIceCandidates();
  }, ICE_BATCH_MS);
}

// NEW — 큐 비우고 candidates 배열 한 번에 전송
function flushIceCandidates() {
  if (!iceSendQueue.length) return;
  const batch = iceSendQueue;
  iceSendQueue = [];
  sendSignal({ candidates: batch }); // 서버는 그대로 릴레이만 하면 됨
}

// NEW — 조건을 만족할 때만(impolite && 두 명 && stable) 디바운스로 재시작 오퍼
function scheduleIceRestart(reason = '') {
  if (polite) return;                // impolite만 재시작 트리거
  if (peerCount !== 2) return;       // 두 명 있을 때만 의미 있음
  if (!pc || pc.signalingState !== 'stable') return;

  const now = Date.now();
  if (now - lastIceRestartAt < ICE_RESTART_DEBOUNCE_MS) return;
  if (iceRestartTimer) return;

  iceRestartTimer = setTimeout(async () => {
    iceRestartTimer = null;
    if (!pc || pc.signalingState !== 'stable') return;
    try {
      lastIceRestartAt = Date.now();
      console.log('[ICE-Restart] start, reason:', reason);
      makingOffer = true;
      // iceRestart 옵션으로 오퍼 생성 → PN 규칙 그대로 적용됨
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      sendSignal({ desc: pc.localDescription });
    } catch (err) {
      console.warn('[ICE-Restart] failed:', err);
    } finally {
      makingOffer = false;
    }
  }, 200); // 아주 짧은 지연으로 순간적 흔들림을 흡수
}

// 페이지 진입 시 실행
connectWS();

// 데모용: 콘솔에서 메시지 보내보기
export function send(text) {
  if (dc?.readyState === 'open') dc.send(text);
}
