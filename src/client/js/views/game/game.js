import "../../../scss/common.scss";
// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import {scheduleRefresh} from "../../common/refreshScheduler.js"

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
scheduleRefresh();

// // ----- WebSocket signaling -----
// const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
// const ws = new WebSocket(WS_URL);

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

function safeWsSend(obj) {
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
    STATE.ws.send(JSON.stringify(obj));
  }
}
function sendSignal(toPeerId, data) {
  if (!STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;
  STATE.ws.send(JSON.stringify({ type: "signal", to: toPeerId, data }));
};
function isPolite() {
  return STATE.role === "polite";
};

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
    doIceRestart().catch(err => console.error("ICE Restart Failed : ", err));
  }, ICE_RESTART_DEBOUNCE);
};

const RELIABLE = {
  nextSeq: 1,
  expectedSeq: 1,
  outbox: new Map(), // 보낸 편지 대기함
  buffer: new Map(), // 받은 편지 정렬함
  lastAcked: 0,
  resendTimer: null
};
let PING_TIMER = null;
const PING_INTERVAL = 5000;
let LAST_PING_TS = 0;
let LAST_RTT_MS = null;
const RESEND_INTERVAL = 300;
const RESEND_MAX = 10;

function rawSend(env) {
  if (!STATE.dc || STATE.dc.readyState !== 'open') return;
  // 최신 ack를 동봉(양방향 ack 파이프라인)
  if (typeof env.ack !== 'number') {
    env.ack = RELIABLE.expectedSeq - 1;
  }
  STATE.dc.send(JSON.stringify(env));
}
function stopPingLoop() {
  if (PING_TIMER) {
    clearInterval(PING_TIMER);
    PING_TIMER = null;
  }
};
function startPingLoop() {
  if (PING_TIMER) return;
  PING_TIMER = setInterval(() => {
    if (!STATE.dc || STATE.dc.readyState !== "open") return;
    LAST_PING_TS = Date.now();
    rawSend({ v: 1, t: "PING", ts: LAST_PING_TS });
  }, PING_INTERVAL);
};
function stopResendLoop() {
  if (RELIABLE.resendTimer) {
    clearInterval(RELIABLE.resendTimer);
    RELIABLE.resendTimer = null;
  }
}
function startResendLoop() {
  console.log("보낸자 6-1 : startResendLoop 진입");
  if (RELIABLE.resendTimer) return;
  RELIABLE.resendTimer = setInterval(() => {
    const now = Date.now();
    for (const [seq, rec] of RELIABLE.outbox) {
      if (!rec.sentAt || now - rec.sentAt >= RESEND_INTERVAL) {
        // 재전송(최대 횟수 초과 시 포기 및 오류 로그)
        if (rec.retries >= RESEND_MAX) {
          console.warn(`seq ${seq} dropped after ${RESEND_MAX} retries`);
          RELIABLE.outbox.delete(seq);
          console.log("보낸자 6-2 : outbox 삭제");
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
  console.log("보낸자 6-2 : startResendLoop 종료");
}
function resetReliableLayer() {
  RELIABLE.nextSeq = 1;
  RELIABLE.expectedSeq = 1;
  RELIABLE.outbox.clear();
  RELIABLE.buffer.clear();
  RELIABLE.lastAcked = 0;
  stopResendLoop();
}
function ackUntil(seq) {
  console.log("ackUntil 진입", seq);
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
function deliverToGame(payload, meta) {
  console.log("받는자 4 : deliverToGame에서 console 출력");
  console.log(
    `
      deliverToGame -
      payload : ${JSON.stringify(payload)}
      meta : ${JSON.stringify(meta)}
    `
  );
};
function handleReliableReceive(env) {
  console.log("받는자 3-1 : handleReliableReceive 진행");
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

  console.log("받는자 3-2 : rawSend 에 ACK 전송");
  // 전달 후 ack 전송(상대의 재전송 종료를 빠르게)
  rawSend({ v: 1, t: 'ACK', seq: RELIABLE.expectedSeq - 1 });
}
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
    case 'HELLO': {
      // 새 세션 인사: 필요하면 내 상태 스냅샷 전달
      // rawSend({ v:1, t:'STATE', payload:getCurrentGameSnapshot() });
      break;
    }
    case 'STATE': {
      // 전체 상태 스냅샷 수신 → 로컬 UI/상태 갱신
      // applyGameSnapshot(env.payload);
      break;
    }
    case 'MSG': {
      console.log("받는자 2 : handleEnvelope 에서 MSG로 받음");
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
  console.log("보낸자 1 : rawSend에 env 전송");
  rawSend(env);
  console.log("보낸자 5 : startResendLoop 시작");
  startResendLoop();
}






function attachDataChannelHandlers(dc, tag) {
  dc.onopen = () => {
    log(`DataChannel[${tag}] open`);

    resetReliableLayer();
    // startPingLoop();
  };
  dc.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; };
    handleEnvelope(msg);
  };
  dc.onclose = () => {
    log(`DataChannel[${tag}] close`);

    // stopPingLoop();
    stopResendLoop();

    if (STATE.role === "impolite" && STATE.pc?.connectionState !== "closed") {
      debounceIceRestart();
    }
  };
};

function cleanupPeerConnection(logIt = true) {
  if (STATE.dc) {
    try { STATE.dc.close() } catch {};
    STATE.dc = null;
  };
  if (STATE.pc) {
    try {
      STATE.pc.onicecandidate = null;
      STATE.pc.ondatachannel = null;
      STATE.pc.onconnectionstatechange = null;
      STATE.pc.oniceconnectionstatechange = null;
      STATE.pc.close()
    } catch {};
    STATE.pc = null;
  };

  STATE.makingOffer = false;
  STATE.ignoreOffer = false;
  STATE.isSettingRemoteAnswerPending = false;

  if (logIt) log("pc clean up");
};

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
    if (STATE.role !== "impolite") return;
    try {
      STATE.makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer());
      sendSignal(STATE.partnerId, { sdp: pc.localDescription });
    } catch(err) {
      console.error("onnegotiationneeded error : ", err);
    } finally {
      STATE.makingOffer = false;
    };
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
    };
  };
  pc.onconnectionstatechange = () => {
    log("connectionState", pc.connectionState);
  };
  pc.oniceconnectionstatechange = () => {
    log("iceConnectionState", pc.iceConnectionState);

    if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
      if (STATE.role === "impolite") {
        debounceIceRestart();
      };
    };
  };
};

async function handleRemoveSignal(msg) {
  const pc = STATE.pc;
  if (!pc) return;
  try {
    const data = msg.data;
    if (data?.sdp) {
      const desc = data.sdp;
      const offerCollision = desc.type === "offer" && (STATE.makingOffer || STATE.isSettingRemoteAnswerPending);
      STATE.ignoreOffer = !isPolite() && offerCollision;
      if (STATE.ignoreOffer) return;
      if (desc.type === "offer") {
        if (STATE.makingOffer) {
          await pc.setLocalDescription({ type: "rollback" });
        };
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
          console.error("addIceCandidate error : ", e);
        }
      }
    }
  } catch(err) {
    console.error("handleRemoveSignal error : ", err);
  };
};

function connectSignaling(connected = false) {
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) return;

  // ----- WebSocket signaling -----
  const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
  const ws = new WebSocket(WS_URL);
  STATE.ws = ws;

  ws.addEventListener("open", () => {
    log(connected ? "WS reconnected." : "WS connected.");
    WS_RETRY.tries = 0;
    if (WS_RETRY.timer) {
      clearTimeout(WS_RETRY.timer);
      WS_RETRY.timer = null;
    };

    // ★ 이전 roomId가 있으면 힌트로 보낸다.
    const roomHint = sessionStorage.getItem('roomId') || null;
    safeWsSend({ type: 'join', roomHint });
  });

  ws.addEventListener("message", async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; };
    switch(msg.type) {
      case "room-assigned" : {
        STATE.roomId = msg.roomId;
        STATE.peerId = msg.peerId;
        STATE.role = msg.role;
        // ★ 세션에 저장(재접속시 hint로 사용)
        sessionStorage.setItem('roomId', STATE.roomId);
        log(`Assigned room=${STATE.roomId}, me=${STATE.peerId}, role=${STATE.role}`);
        break;
      }
      case "paired" : {
        if (msg.roomId !== STATE.roomId) return;
        if (msg.you?.peerId === STATE.peerId) {
          STATE.role = msg.you.role;
          STATE.partnerId = msg.partner.peerId;

          // ★ 안전 위해 여기서도 다시 저장(경합 대비)
          sessionStorage.setItem('roomId', msg.roomId);
          log(`Paired! me(${STATE.role}) <-> partner(${msg.partner.peerId}/${msg.partner.role})`);

          await startPeerConnection();
        };
        break;
      }
      case "partner-left" : {
        if (msg.roomId !== STATE.roomId) return;
        console.log("Partner Lefted...");
        cleanupPeerConnection();
        break;
      }
      case "signal" : {
        if (!STATE.pc) {
          await startPeerConnection();
        };
        await handleRemoveSignal(msg);
        break;
      }
    };
  });
  ws.addEventListener("close", (ev) => {
    log("WS closed. Try reconnecting...", ev.code, ev.reason);
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
  /* if (!STATE.dc) {
    log("DataChannel is not open.");
    return;
  }
  IPT.value !== "" && STATE.dc.send(IPT.value);
  IPT.value = ""; */
  sendGame({ type: "ROUND_START", seed: Math.random() });
  // sendGame({ type: "INPUT", key: "LEFT", ts: Date.now() }, { reliable: false });
});
