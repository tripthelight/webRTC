// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';

function log(s) {
  console.log(s);
  $status.textContent = s;
}

const roomId = 'room-1'; // 필요 시 동적 생성/URL 파라미터로 대체 가능
const $status = document.getElementById('status');

// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
// const ws = new WebSocket(WS_URL);
let ws;                    // 재생성 가능
const outbox = [];         // OPEN 전/닫힘 중 신호 보관 (이전 단계 그대로 사용)
function wsSend(type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
  else {
    outbox.push(msg);
    console.log('📦 queued signal (len=', outbox.length, ')', type);
  }
}
function flushOutbox() {
  while (ws && ws.readyState === WebSocket.OPEN && outbox.length) {
    ws.send(outbox.shift());
  }
}

let pc;
let isPolite = false; // 후접속자가 true
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;
let pendingCandidates = []; // remoteDescription 세팅 전 받은 ICE 임시 보관
let havePeer = false; // 상대 존재 여부
let started = false;  // 초기 협상(내가 dataChannel 생성) 시작 여부
let myCh = null;      // 내가 만든 dataChannel 핸들
let iceRestarting = false;
let discoTimer = null;
let lastRestartAt = 0;
const RESTART_COOLDOWN = 5000; // ms: 과도한 재시작 방지

let reconnectAttempt = 0;
let reconnectTimer = null;
const BASE_BACKOFF = 300;   // ms
const MAX_BACKOFF  = 5000;  // ms
function backoffDelay() {
  const d = Math.min(MAX_BACKOFF, BASE_BACKOFF * Math.pow(2, reconnectAttempt));
  const jitter = Math.random() * 200; // 소량 지터
  return d + jitter;
}
function scheduleReconnect(reason = 'unknown') {
  if (reconnectTimer) return;
  const delay = backoffDelay();
  console.log(`⚠️ ws ${reason} → ${Math.round(delay)}ms 후 재연결`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempt++;
    connectWS();
  }, delay);
}

function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    reconnectAttempt = 0;
    console.log('🔌 시그널 서버 연결됨, 방 참가 중...');
    if (!pc) createPC();           // 혹시 아직 PC 미생성 상태면 생성
    wsSend('join', { roomId });    // 방 자동 재참가
    flushOutbox();                 // 큐에 쌓인 신호 즉시 전송
  });

  ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'role') {
      isPolite = msg.role === 'polite';
      log(`내 역할: ${msg.role}`);
      if (!isPolite && havePeer && !started) startAsImpolite();
    }
    if (msg.type === 'peer-joined') {
      havePeer = true;
      log('상대가 방에 입장함');
      if (!isPolite && !started) startAsImpolite();
    }
    if (msg.type === 'peer-left') {
      havePeer = false;
      log('상대가 방에서 나감 (재입장 시 재협상 예정)');
      try { if (myCh && myCh.readyState !== 'closed') myCh.close(); } catch {}
      myCh = null;
      resetPC(); // 다음 연결을 위해 깨끗이
    }
    if (msg.type === 'signal') {
      await handleSignal(msg.payload);
    }
  });

  ws.addEventListener('close', () => scheduleReconnect('close'));
  ws.addEventListener('error', () => scheduleReconnect('error'));
}

async function maybeRestartIce(reason = '') {
  // 오직 impolite(선접속자)만 트리거 → glare 방지
  if (isPolite) return;
  if (!havePeer) return;
  if (pc.signalingState !== 'stable') return;
  if (makingOffer || isSettingRemoteAnswerPending || iceRestarting) return;
  if (Date.now() - lastRestartAt < RESTART_COOLDOWN) return;

  try {
    iceRestarting = true;
    lastRestartAt = Date.now();
    console.log('🧊 ICE restart start:', reason);
    await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
    wsSend('signal', { payload: { description: pc.localDescription } });
  } catch (e) {
    console.error('ICE restart error:', e);
  } finally {
    iceRestarting = false;
  }
}

function createPC() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  // Perfect Negotiation: onnegotiationneeded에서 offer 생성
  pc.onnegotiationneeded = async () => {
    if (!havePeer) {
      log('onnegotiationneeded but no peer yet — skip');
      return;
    }
    try {
      makingOffer = true;
      log('onnegotiationneeded → createOffer');
      await pc.setLocalDescription(await pc.createOffer());
      wsSend('signal', { payload: { description: pc.localDescription } });
    } catch (e) {
      console.error(e);
    } finally {
      makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    wsSend('signal', { payload: { candidate } });
  };

  pc.onconnectionstatechange = () => {
    log(`pc.connectionState = ${pc.connectionState}`);
    const st = pc.connectionState;
    if (st === 'connected') {
      if (discoTimer) { clearTimeout(discoTimer); discoTimer = null; }
      return;
    }
    if (st === 'disconnected' || st === 'failed') {
      // 잠깐의 hiccup을 위해 짧게 디바운스 후 ICE 재시작
      if (discoTimer) clearTimeout(discoTimer);
      discoTimer = setTimeout(() => {
        maybeRestartIce(`connectionState:${st}`);
      }, 1500);
    }
  };

  // (선택) 참고 로그
  pc.oniceconnectionstatechange = () => {
    console.log('iceConnectionState:', pc.iceConnectionState);
  };

  // 상대가 만든 DataChannel 수신 (polite 쪽은 보통 여기서 채널을 받음)
  pc.ondatachannel = (ev) => {
    const ch = ev.channel;
    ch.onopen = () => log(`📥 datachannel open (label=${ch.label})`);
    ch.onmessage = (e) => console.log('peer says:', e.data);
  };
}

function resetPC() {
  if (discoTimer) { clearTimeout(discoTimer); discoTimer = null; }
  try { pc?.getSenders()?.forEach(s => s.track && s.track.stop()); } catch {}
  try { pc?.close(); } catch {}
  createPC();
  started = false;
  myCh = null;
  pendingCandidates = [];
  makingOffer = false;
  ignoreOffer = false;
  isSettingRemoteAnswerPending = false;
  iceRestarting = false;
  // lastRestartAt은 유지(짧은 시간 내 과도한 재시작 방지)
  console.log('🔄 RTCPeerConnection reset');
}

async function handleSignal(payload) {
  const { description, candidate } = payload;

  try {
    if (description) {
      const readyForOffer =
        !makingOffer && (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);
      const offerCollision = description.type === 'offer' && !readyForOffer;

      ignoreOffer = !isPolite && offerCollision;
      if (ignoreOffer) {
        log('⚠️ glare: impolite가 상대 offer 무시');
        return;
      }

      if (offerCollision) {
        // polite는 rollback 후 상대 offer 수락
        log('⚠️ glare: polite가 rollback');
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          // no-op to yield
        ]);
      }

      isSettingRemoteAnswerPending = description.type === 'answer';
      await pc.setRemoteDescription(description);
      isSettingRemoteAnswerPending = false;

      // remoteDescription 세팅되었으니 보류된 ICE 처리
      await flushPendingCandidates();

      if (description.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        wsSend('signal', { payload: { description: pc.localDescription } });
      }
      return;
    }

    if (candidate) {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(candidate);
      } else {
        pendingCandidates.push(candidate);
      }
      return;
    }
  } catch (err) {
    console.error('signal handling error:', err);
  }
}

async function flushPendingCandidates() {
  for (const c of pendingCandidates) {
    try { await pc.addIceCandidate(c); } catch (e) { console.error(e); }
  }
  pendingCandidates = [];
}

function startAsImpolite() {
  if (started) return;
  started = true;
  myCh = pc.createDataChannel('chat');
  myCh.onopen = () => log('📤 datachannel open (내가 생성)');
  myCh.onmessage = (e) => console.log('peer says:', e.data);
}

connectWS(); // 페이지 로드시 소켓 연결 시작
