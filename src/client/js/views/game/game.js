import { NegotiationManager } from '../../common/negotiationManager.js';
import { v4 as uuidV4 } from 'uuid';

// ---- 설정 (필요 시 수정) -------------------------------------------------
const SIGNALING_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // { urls: 'turn:your.turn.server', username: 'user', credential: 'pass' },
  ],
};

// roomName / clientId 초기화 (세션 유지)
const roomName = sessionStorage.getItem('roomName') || 'demo-room';
sessionStorage.setItem('roomName', roomName);
const myId = sessionStorage.getItem('clientId') || uuidV4();
sessionStorage.setItem('clientId', myId);

// ---- attemptId 유틸 ----
function genAttemptId() { return Date.now(); }

// WebSocket 연결
const ws = new WebSocket(SIGNALING_URL);
function send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// Peer 관리
let peerId = null;            // 상대 ID
let IS_POLITE = false;        // Perfect Negotiation 역할
let I_AM_INITIATOR = false;   // 누가 먼저 offer 낼지 결정(충돌 방지용)

// Negotiation Manager 생성
const neg = new NegotiationManager({
  createPeerConnection: () => new RTCPeerConnection(RTC_CONFIG),
  onLog: (...args) => console.log(...args),
});

// 현재 attempt pc/dc 헬퍼
function cur() { return neg.current || {}; }

// 자신의 최신 attemptId로 시그널 보내기
function sendSignal(payload) {
  const attemptId = cur().attemptId;
  send({ type: 'signal', roomName, from: myId, to: peerId, attemptId, ...payload });
}

// 피어가 정해지면 역할 고정 (ID 사전순 기준 예시)
function decideRoles() {
  if (!peerId) return;
  IS_POLITE = myId > peerId;             // 사전순 큰 쪽을 Polite로
  I_AM_INITIATOR = myId < peerId;        // 사전순 작은 쪽이 최초 Offer 주도
  console.log('[ROLE] polite=', IS_POLITE, 'initiator=', I_AM_INITIATOR);
}

// 새 attempt 시작(필수 이벤트 바인딩)
function startAttempt(attemptId = genAttemptId(), asCaller = false) {
  const { pc, controller } = neg.startNewAttempt(attemptId);
  const signal = controller.signal;

  // 로컬 미디어/데이터 채널(데모: 데이터채널)
  if (asCaller) {
    const dc = pc.createDataChannel('chat');
    neg.attachDataChannel(dc);
    // open시 자동 테스트 메시지
    dc.onopen = () => {
      console.log('[DC] open');
      try { dc.send(`hello-from:${myId} attempt:${attemptId}`); } catch {}
    };
  }

  pc.ondatachannel = (e) => {
    const ch = e.channel;
    neg.attachDataChannel(ch);
    ch.onopen = () => {
      console.log('[DC] (rx) open');
      try { ch.send(`hello-from:${myId} attempt:${attemptId}`); } catch {}
    };
  };

  // ICE
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    if (!neg.current || neg.current.attemptId !== attemptId) return; // 최신 시도만 전송
    const cand = (typeof e.candidate.toJSON === 'function') ? e.candidate.toJSON() : {
      candidate: e.candidate.candidate,
      sdpMid: e.candidate.sdpMid,
      sdpMLineIndex: e.candidate.sdpMLineIndex,
      usernameFragment: e.candidate.usernameFragment,
    };
    sendSignal({ action: 'candidate', candidate: cand });
  };

  return pc;
}

// ---- 송신: Offer 생성 ----
async function makeOffer() {
  if (!peerId) return;
  const attemptId = genAttemptId();
  startAttempt(attemptId, true);
  const { pc, controller } = cur();
  const signal = controller.signal;

  const offer = await pc.createOffer();
  if (signal.aborted) return;
  await pc.setLocalDescription(offer);
  if (signal.aborted) return;

  sendSignal({ action: 'offer', sdp: offer.sdp });
}

// ---- 수신: Offer 처리 ----
async function onOffer(msg) {
  const { attemptId, sdp } = msg;

  if (!neg.ensureLatest(attemptId)) return; // 최신성 보장
  const { pc, controller } = cur();
  const signal = controller.signal;

  // Perfect Negotiation: Polite는 로컬 오퍼 중이면 롤백
  if (IS_POLITE && pc.signalingState === 'have-local-offer') {
    try { await pc.setLocalDescription({ type: 'rollback' }); } catch {}
  }
  if (signal.aborted) return;

  await pc.setRemoteDescription({ type: 'offer', sdp });
  if (signal.aborted) return;

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  if (signal.aborted) return;

  sendSignal({ action: 'answer', sdp: answer.sdp });
  await neg.flushCandidates(attemptId, pc);
}

// ---- 수신: Answer 처리 ----
async function onAnswer(msg) {
  const { attemptId, sdp } = msg;
  if (!neg.ensureLatest(attemptId)) return;
  const { pc, controller } = cur();
  const signal = controller.signal;

  await pc.setRemoteDescription({ type: 'answer', sdp });
  if (signal.aborted) return;

  await neg.flushCandidates(attemptId, pc);
}

// ---- 수신: Candidate 처리 ----
async function onCandidate(msg) {
  const { attemptId, candidate } = msg;
  if (neg.isStaleAttempt(attemptId)) return; // 구 attempt는 폐기

  const rtcCandObj = candidate; // plain object

  if (!neg.current || neg.current.attemptId !== attemptId) {
    neg.bufferCandidate(attemptId, rtcCandObj);
    return;
  }
  const { pc } = cur();
  if (!pc.remoteDescription) {
    neg.bufferCandidate(attemptId, rtcCandObj);
  } else {
    try {
      const ice = (typeof RTCIceCandidate !== 'undefined') ? new RTCIceCandidate(rtcCandObj) : rtcCandObj;
      await pc.addIceCandidate(ice);
    } catch (err) { console.warn('[ICE] addIceCandidate error', err); }
  }
}

// ---- WebSocket 수신 핸들러 ----
ws.onopen = () => {
  console.log('[WS] open');
  send({ type: 'join', roomName, clientId: myId });
};

ws.onmessage = (ev) => {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.type === 'peer-list') {
    const others = msg.peers.filter((p) => p !== myId);
    if (others.length) {
      const nextPeer = others[0]; // 2인 방 가정
      if (peerId !== nextPeer) {
        peerId = nextPeer;
        decideRoles();
        if (I_AM_INITIATOR) setTimeout(() => makeOffer(), 50); // 안정용 소지연
      }
    }
    return;
  }

  if (msg.type === 'signal' && msg.to === myId) {
    const { action } = msg;
    if (action === 'offer') return onOffer(msg);
    if (action === 'answer') return onAnswer(msg);
    if (action === 'candidate') return onCandidate(msg);
  }
};

// ---- (선택) 콘솔에서 손쉽게 테스트 메시지 보내기 ----
window._rtc = {
  send: (text) => neg.send(text),
  onMessage: (fn) => neg.onMessage(fn),
  status: () => {
    const st = {
      attemptId: cur().attemptId,
      hasCurrent: !!neg.current,
      currentDC: neg.current?.dc?.readyState,
      openDC: neg.openDC?.readyState,
      signalingState: neg.current?.pc?.signalingState,
      iceState: neg.current?.pc?.iceConnectionState,
      connState: neg.current?.pc?.connectionState,
      peerId,
      IS_POLITE,
      I_AM_INITIATOR,
    };
    console.table(st); return st;
  },
  makeOffer,
  neg,
  get peerId() { return peerId; },
  get IS_POLITE() { return IS_POLITE; }
};

// 예)
// 1) 연결 상태 확인:  _rtc.status()
// 2) 메세지 전송:    _rtc.send('hello')
// 3) 수신 훅 등록:   _rtc.onMessage((msg) => console.log('REMOTE>', msg))

function main() {
  window.addEventListener('click', () => {
    console.log('111');
  })
};
main();