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
  outbox: new Map(),
  buffer: new Map(),
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
  if (!STATE.dc || STATE.dc.readyState !== "open") return;
  if (typeof env.ack !== "number") {
    env.ack = RELIABLE.expectedSeq - 1;
  }
  STATE.dc.send(JSON.stringify(env));
};
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
  };
};
function startResendLoop() {
  if (RELIABLE.resendTimer) return;
  RELIABLE.resendTimer = setInterval(() => {
    const now = Date.now();
    for (const [seq, rec] of RELIABLE.outbox) {
      if (!rec.sentAt || now - rec.sentAt >= RESEND_INTERVAL) {
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
    if (RELIABLE.outbox.size === 0) {
      stopResendLoop();
    }
  }, RESEND_INTERVAL)
};
function resetReliableLayer() {
  RELIABLE.nextSeq = 1;
  RELIABLE.expectedSeq = 1;
  RELIABLE.outbox.clear();
  RELIABLE.buffer.clear();
  RELIABLE.lastAcked = 0;
  stopResendLoop();
};
function ackUntil(seq) {
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
};
function deliverToGame(payload, meta) {
  console.log(
    `
      deliverToGame -
      payload : ${JSON.stringify(payload)}
      meta : ${JSON.stringify(meta)}
    `
  );
};
function handleReliableReceive(env) {
  const seq = env.seq; // 1
  if (seq < RELIABLE.expectedSeq) return;
  if (seq > RELIABLE.expectedSeq) {
    RELIABLE.buffer.set(seq, env);
    rawSend({ v: 1, t: "ACK", seq: RELIABLE.expectedSeq - 1 });
    return;
  };

  deliverToGame(env.payload, { reliable: true, seq });

  RELIABLE.expectedSeq++;

  while(RELIABLE.buffer.has(RELIABLE.expectedSeq)) {
    const nextEnv = RELIABLE.buffer.get(RELIABLE.expectedSeq);
    RELIABLE.buffer.delete(RELIABLE.expectedSeq);
    deliverToGame(nextEnv.payload, { reliable: true, seq: RELIABLE.expectedSeq });
    RELIABLE.expectedSeq++;
  }

  rawSend({ v: 1, t: "ACK", seq: RELIABLE.expectedSeq - 1 });
};
function handleEnvelope(env) {
  if (!env || env.v !== 1 || !env.t) return;
  if (typeof env.ack === "number") {
    ackUntil(env.ack);
  };
  switch(env.t) {
    case "ACK" : {
      if (typeof env.seq === "number") ackUntil(env.seq);
      break;
    }
    case "PING": {
      rawSend({ v: 1, t: "PONG", ts: Date.now() });
      break;
    }
    case "PONG": {
      if (LAST_PING_TS) {
        LAST_RTT_MS = Date.now() - LAST_PING_TS;
        console.log(`RTT ~ ${LAST_RTT_MS} ms`);
      }
      break;
    }
    case "MSG" : {
      if (typeof env.seq === "number") {
        handleReliableReceive(env);
      } else {
        deliverToGame(env.payload, { unreliable: true });
      }
      break;
    }
  };
};
function sendGame(payload, { reliable = true, id = undefined } = {}) {
  if (!STATE.dc || STATE.dc.readyState !== "open") return;

  if (!reliable) {
    const env = { v: 1, t: "MSG", ts: Date.now(), id, payload };
    STATE.dc.send(JSON.stringify(env));
    return;
  };

  const seq = RELIABLE.nextSeq++;
  const env = {
    v: 1,
    t: "MSG",
    seq,
    ts: Date.now(),
    id,
    ack: RELIABLE.expectedSeq - 1,
    payload,
  };
  RELIABLE.outbox.set(seq, { msg: env, sentAt: 0, retries: 0 });
  rawSend(env);
  startResendLoop();
};






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

  STATE.ws = ws;

  ws.addEventListener("open", () => {
    log(connected ? "WS reconnected." : "WS connected.");
    WS_RETRY.tries = 0;
    if (WS_RETRY.timer) {
      clearTimeout(WS_RETRY.timer);
      WS_RETRY.timer = null;
    };
  });
  ws.addEventListener("message", async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; };
    switch(msg.type) {
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
        };
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
        };
        await handleRemoveSignal(msg);
        break;
      }
    };
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
  /* if (!STATE.dc) {
    log("DataChannel is not open.");
    return;
  }
  IPT.value !== "" && STATE.dc.send(IPT.value);
  IPT.value = ""; */
  sendGame({ type: "ROUND_START", seed: Math.random() });
  // sendGame({ type: "INPUT", key: "LEFT", ts: Date.now() }, { reliable: false });
});
