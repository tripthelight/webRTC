import "../../../scss/common.scss";
// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import {scheduleRefresh} from "../../common/refreshScheduler.js"

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
// scheduleRefresh();

// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
const ws = new WebSocket(WS_URL);

const ICE_SERVERS = [
  // 공개 STUN 예시(실서비스는 TURN 필요)
  { urls: 'stun:stun.l.google.com:19302' },
];

// ———————————————————————————————————————————————————

function log(...args) {
  console.log("[CLIENT]", ...args);
};

const STATE = {
  ws: null,
  roomId: null,
  peerId: null,
  role: null,
  partnerId: null,
  pc: null,
  dc: null,
  makingOffer: false,
  ignoreOffer: false,
  isSettingRemoteAnswerPending: false,
};

function sendSignal(toPeerId, data) {
  if (!STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;
  STATE.ws.send(JSON.stringify({ type: "signal", to: toPeerId, data }));
};
function isPolite() {
  return STATE.role === "polite";
};

// --------------------------------------------------------
// 직렬화 전 JS 객체 형태
/*
{
  v: 1, // 프로토콜 버전
  t: "MSG"|"ACK"|"PING"|"PONG"|"HELLO"|"STATE", // 타입
  seq?: number, // 송신측 시퀀스(신뢰/순서 보장용)
  ack?: number, // 내가 마지막으로 잘 받았다고 확인하는 seq
  id?: string, // 논리 메시지 ID(멱등/충돌 처리 시 유용)
  ts?: number, // 송신 시각(ms)
  payload?: any // 실제 게임 페이로드
}
  */
// --- [추가] 신뢰/순서 보장 레이어 상태 ---
const RELIABLE = {
  nextSeq: 1,                  // 다음에 보낼 seq
  expectedSeq: 1,              // 다음에 "전달"되어야 할 seq
  outbox: new Map(),           // 미확인 전송: seq -> { msg, sentAt, retries }
  buffer: new Map(),           // 순서 앞선 도착 보관: seq -> msg
  lastAcked: 0,                // 상대가 ack 보낸 마지막 seq (로그/모니터용)
  resendTimer: null,
};

const RESEND_INTERVAL = 300;   // ms: ACK 없으면 재전송 간격
const RESEND_MAX = 10;         // 최대 재전송 횟수

// --- [추가] 핑/퐁(RTT) ---
let PING_TIMER = null;
const PING_INTERVAL = 5000;    // 5s
let LAST_PING_TS = 0;
let LAST_RTT_MS = null;

function deliverToGame(payload, meta) {
  log('deliverToGame:', payload, meta);
}

function handleReliableReceive(env) {
  const seq = env.seq;

  // 이미 전달한(seq < expected) 이거나 중복이면 무시
  if (seq < RELIABLE.expectedSeq) return;

  // 미래 패킷(seq > expected) → 버퍼에 저장
  if (seq > RELIABLE.expectedSeq) {
    RELIABLE.buffer.set(seq, env);
    // 최신 ack를 동봉해 즉시 회신해 주면 상대 재전송 최적화에 도움
    rawSend({ v: 1, t: 'ACK', seq: RELIABLE.expectedSeq - 1 });
    return;
  }

  // 정확히 다음에 전달되어야 할 패킷(seq === expected)
  deliverToGame(env.payload, { reliable: true, seq });

  // 전달 완료 → expectedSeq 증가
  RELIABLE.expectedSeq++;

  // 혹시 버퍼에 다음 것들이 와 있으면 연속으로 전달
  while (RELIABLE.buffer.has(RELIABLE.expectedSeq)) {
    const nextEnv = RELIABLE.buffer.get(RELIABLE.expectedSeq);
    RELIABLE.buffer.delete(RELIABLE.expectedSeq);
    deliverToGame(nextEnv.payload, { reliable: true, seq: RELIABLE.expectedSeq });
    RELIABLE.expectedSeq++;
  }

  // 전달 후 ack 전송(상대의 재전송 종료를 빠르게)
  rawSend({ v: 1, t: 'ACK', seq: RELIABLE.expectedSeq - 1 });
};

function ackUntil(seq) {
  // seq 이하 outbox를 정리
  let removed = 0;
  for (const s of Array.from(RELIABLE.outbox.keys())) {
    if (s <= seq) {
      RELIABLE.outbox.delete(s);
      removed++;
    }
  }
  if (removed) {
    RELIABLE.lastAcked = seq;
  }
}

function startPingLoop() {
  if (PING_TIMER) return;
  PING_TIMER = setInterval(() => {
    if (!STATE.dc || STATE.dc.readyState !== 'open') return;
    LAST_PING_TS = Date.now();
    rawSend({ v: 1, t: 'PING', ts: LAST_PING_TS });
  }, PING_INTERVAL);
};

function stopPingLoop() {
  if (PING_TIMER) {
    clearInterval(PING_TIMER);
    PING_TIMER = null;
  }
}

function stopResendLoop() {
  if (RELIABLE.resendTimer) {
    clearInterval(RELIABLE.resendTimer);
    RELIABLE.resendTimer = null;
  }
}

function resetReliableLayer() {
  RELIABLE.nextSeq = 1;
  RELIABLE.expectedSeq = 1;
  RELIABLE.outbox.clear();
  RELIABLE.buffer.clear();
  RELIABLE.lastAcked = 0;
  stopResendLoop();
}

function startResendLoop() {
  if (RELIABLE.resendTimer) return;
  RELIABLE.resendTimer = setInterval(() => {
    const now = Date.now();
    for (const [seq, rec] of RELIABLE.outbox) {
      if (!rec.sentAt || now - rec.sentAt >= RESEND_INTERVAL) {
        // 재전송(최대 횟수 초과 시 포기 및 오류 로그)
        if (rec.retries >= RESEND_MAX) {
          console.warn(`seq ${seq} dropped after ${RESEND_MAX} retries`);
          RELIABLE.outbox.delete(seq);
          continue;
        }
        rec.sentAt = now;
        rec.retries++;
        rawSend(rec.msg);
      }
    }
    // outbox가 비면 타이머 중지
    if (RELIABLE.outbox.size === 0) {
      stopResendLoop();
    }
  }, RESEND_INTERVAL);
}

function sendGame(payload, { reliable = true, id = undefined } = {}) {
  if (!STATE.dc || STATE.dc.readyState !== 'open') return;

  if (!reliable) {
    // 비신뢰/무순서(간단): 타입만 MSG, seq/ack 없이 전송
    const env = { v: 1, t: 'MSG', ts: Date.now(), id, payload };
    STATE.dc.send(JSON.stringify(env));
    return;
  }

  // --- 신뢰/순서 보장 경로 ---
  const seq = RELIABLE.nextSeq++;
  const env = {
    v: 1,
    t: 'MSG',
    seq,
    ts: Date.now(),
    id,
    // 내가 마지막으로 "전달 완료"한 원격 seq를 ack에 담아 보내줘 상호 확인 빠르게
    ack: RELIABLE.expectedSeq - 1,
    payload,
  };

  // outbox에 보관(ACK 오기 전까지 재전송 대상)
  RELIABLE.outbox.set(seq, { msg: env, sentAt: 0, retries: 0 });

  // 즉시 송신 + 재전송 루프 가동
  rawSend(env);
  startResendLoop();
};

// Envelope 저수준 송신(ack 최신값을 매번 동봉)
function rawSend(env) {
  if (!STATE.dc || STATE.dc.readyState !== 'open') return;
  // 최신 ack를 동봉(양방향 ack 파이프라인)
  if (typeof env.ack !== 'number') {
    env.ack = RELIABLE.expectedSeq - 1;
  }
  STATE.dc.send(JSON.stringify(env));
}

// 가장 하위 수신 처리
function handleEnvelope(env) {
  if (!env || env.v !== 1 || !env.t) return;

  // 상대가 동봉해 온 ack를 처리 (outbox 정리)
  if (typeof env.ack === 'number') {
    ackUntil(env.ack);
  }

  switch (env.t) {
    case 'ACK': {
      // 단독 ACK 타입도 지원(현재는 MSG에 동봉 ack로 충분)
      if (typeof env.seq === 'number') ackUntil(env.seq);
      break;
    }
    case 'PING': {
      // PING 수신 → 곧바로 PONG 회신(내 ack 포함)
      rawSend({ v: 1, t: 'PONG', ts: Date.now() });
      break;
    }
    case 'PONG': {
      // PONG → RTT 측정
      if (LAST_PING_TS) {
        LAST_RTT_MS = Date.now() - LAST_PING_TS;
        log(`RTT ~ ${LAST_RTT_MS} ms`);
      }
      break;
    }
    case "HELLO": {break;}
    case "STATE": {break;}
    case 'MSG': {
      // --- 신뢰/순서 보장 수신 ---
      if (typeof env.seq === 'number') {
        handleReliableReceive(env);
      } else {
        // 비신뢰/무순서 수신(예: 단순 입력) → 즉시 전달
        deliverToGame(env.payload, { unreliable: true });
      }
      break;
    }
  }
}

function sendEnvelope(env) {
  if (!env || !env.t) return;          // 타입은 필수
  const envelope = {
    v: 1,
    ts: Date.now(),
    ...env,                             // { t:'HELLO', payload:{...} } 같은 형태
  };
  rawSend(envelope);
}

// --------------------------------------------------------

let WS_RETRY = { tries: 0, timer: null };
const WS_RETRY_MAX = 6;
const WS_RETRY_BASE = 200;

function scheduleWsReconnect() {
  if (WS_RETRY.timer) return;
  const t = Math.min(WS_RETRY_MAX, WS_RETRY.tries++);
  const delay = WS_RETRY_BASE * Math.pow(2, t);
  WS_RETRY.timer = setTimeout(() => {
    WS_RETRY.timer = null;
    connectSignaling(true);
  }, delay);
};

let ICE_RESTART_TIMER = null;
const ICE_RESTART_DEBOUNCE = 1200;

async function doIceRestart() {
  const pc = STATE.pc;
  if (!pc) return;
  if (STATE.role !== "impolite") return;
  try {
    STATE.makingOffer = true;
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    sendSignal(STATE.partnerId, { sdp: pc.localDescription });
  } finally {
    STATE.makingOffer = false;
  }
};
function debounceIceRestart() {
  if (ICE_RESTART_TIMER) clearTimeout(ICE_RESTART_TIMER);
  ICE_RESTART_TIMER = setTimeout(() => {
    ICE_RESTART_TIMER = null;
    doIceRestart().catch(err => console.error("Ice Restart failed:", err));
  }, ICE_RESTART_DEBOUNCE);
};


function attachDataChannelHandlers(dc, tag) {
  dc.onopen = () => {
    log(`DataChannel[${tag}] open`);

    // 채널 열리면 신회 레이어 초기화 + 주기적 PING 시작
    resetReliableLayer();
    startPingLoop();
    // 새 세션 인사/동기(HELLO)
    sendEnvelope({ t: 'HELLO', payload: { hello: STATE.peerId } });
  };
  dc.onmessage = (ev) => {
    let msg;
    try { msg = ev.data; } catch(e) { return };
    // console.log("[SEND]", msg);
    // 모든 수신은 Envelope 처리
    handleEnvelope(msg);
  };
  dc.onclose = () => {
    log(`DataChannel[${tag}] close`);

    stopPingLoop();
    stopResendLoop();

    if (STATE.role === "impolite" && STATE.pc?.connectionState !== "closed") {
      debounceIceRestart();
    };
  };
};

function cleanupPeerConnection(logIt = true) {
  if (STATE.dc) {
    try { STATE.dc.close(); } catch {};
    STATE.dc = null;
  };
  if (STATE.pc) {
    try {
      STATE.pc.onicecandidate = null;
      STATE.pc.ondatachannel = null;
      STATE.pc.onconnectionstatechange = null;
      STATE.pc.oniceconnectionstatechange = null;
      STATE.pc.close();
    } catch {};
    STATE.pc = null;
  };

  STATE.makingOffer = false;
  STATE.ignoreOffer = false;
  STATE.isSettingRemoteAnswerPending = false;

  if (logIt) log("pc clean up");
}

async function startPeerConnection() {
  cleanupPeerConnection(false);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  STATE.pc = pc;

  STATE.makingOffer = false;
  STATE.ignoreOffer = false;
  STATE.isSettingRemoteAnswerPending = false;

  if (STATE.role === "impolite") {
    STATE.dc = pc.createDataChannel("game");
    attachDataChannelHandlers(STATE.dc, "active-dc");
  } else {
    STATE.dc = null;
  };

  pc.onnegotiationneeded = async () => {
    if (STATE.role !== "impolite") {
      return;
    }
    try {
      STATE.makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer());
      sendSignal(STATE.partnerId, { sdp: pc.localDescription });
    } catch(err) {
      console.error("onnegotiationneeded error : ", err);
    } finally {
      STATE.makingOffer = false;
    }
  };
  pc.ondatachannel = (ev) => {
    STATE.dc = ev.channel;
    attachDataChannelHandlers(STATE.dc, "passive-dc");
  };
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      sendSignal(STATE.partnerId, { candidate: ev.candidate });
    } else {
      sendSignal(STATE.partnerId, { candidate: null });
    }
  };
  pc.onconnectionstatechange = () => {
    log("connectionState", pc.connectionState);
  };
  pc.oniceconnectionstatechange = () => {
    log("iceConnectionState", pc.iceConnectionState);

    if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
      if (STATE.role === "impolite") {
        debounceIceRestart();
      }
    }
  };
}

async function handleRemoteSignal(msg) {
  const pc = STATE.pc;
  if (!pc) return;
  try {
    const data = msg.data;
    if (data?.sdp) {
      const desc = data.sdp;
      const offerCollistion = desc.type === "offer" && (STATE.makingOffer || STATE.isSettingRemoteAnswerPending);
      STATE.ignoreOffer = !isPolite && offerCollistion;
      if (STATE.ignoreOffer) {
        return;
      }
      if (desc.type === "offer") {
        if (STATE.makingOffer) {
          await pc.setLocalDescription({ type: "rollback" });
        }
        await pc.setRemoteDescription(desc);
        STATE.isSettingRemoteAnswerPending = true;
        await pc.setLocalDescription(await pc.createAnswer());
        sendSignal(STATE.partnerId, { sdp: pc.localDescription });
        STATE.isSettingRemoteAnswerPending = false;
      } else {
        await pc.setRemoteDescription(desc);
      }
    } else if ("candidate" in data) {
      try {
        await pc.addIceCandidate(data.candidate || null);
      } catch(e) {
        if (!STATE.ignoreOffer) {
          console.error("addIceCandidate error : ", err);
        }
      };
    }
  } catch(err) {
    console.error("handleRemoteSignal error : ", err);
  };
};

function connectSignaling(connected = false) {
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) return;

  STATE.ws = ws;

  ws.addEventListener("open", () => {
    log(connected ? "WS reconnected." : "WS connected.");
    WS_RETRY.tries = 0;
    if (WS_RETRY.timer) { clearTimeout(WS_RETRY.timer); WS_RETRY.timer = null };
  });
  ws.addEventListener("message", async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; };

    switch (msg.type) {
      case "room-assigned" : {
        STATE.roomId = msg.roomId;
        STATE.peerId = msg.peerId;
        STATE.role = msg.role;
        break;
      }
      case "paired" : {
        if (msg.roomId !== STATE.roomId) return;
        if (msg.you?.peerId === STATE.peerId) {
          STATE.role = msg.you.role;
          STATE.partnerId = msg.partner.peerId;
          await startPeerConnection();
        }
        break;
      }
      case "partner-left" : {
        if (msg.roomId !== STATE.roomId) return;
        cleanupPeerConnection();
        break;
      }
      case "signal" : {
        if (!STATE.pc) {
          await startPeerConnection();
        }
        await handleRemoteSignal(msg);
        break;
      }
    }
  });
  ws.addEventListener("close", () => {
    log("WS closed. Try reconnecting...");
    scheduleWsReconnect();
  });
  ws.addEventListener("error", () => {
    try { ws.close(); } catch {};
  });
};

connectSignaling();

// ———————————————————————————————————————————————————

const IPT = document.querySelector(".ipt");
const BTN = document.querySelector(".btn");
BTN.addEventListener("click", () => {
  IPT.value !== "" && STATE.dc.send(IPT.value);
});
