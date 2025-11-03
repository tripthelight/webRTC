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
  };
  dc.onmessage = (ev) => {
    console.log("[SEND]", ev.data);
  };
  dc.onclose = () => {
    log(`DataChannel[${tag}] close`);

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
  IPT.value = "";
});
