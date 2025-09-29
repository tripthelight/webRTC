// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';

const $log = document.getElementById("log");
const log = (...args) => {
  const line = args.map(String).join(" ");
  console.log(line);
  $log.textContent += line + "\n";
};

const ROOM_NAME = "room1"; // NEW: 방 이름 상수
let __HELLO_SENT__ = false;

const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
const ws = new WebSocket(WS_URL);

ws.addEventListener("open", () => {
  log("[client] WS open");
  ws.send(JSON.stringify({ type: "join", room: ROOM_NAME })); // 기존
});

ws.addEventListener("message", (ev) => {
  log("[client] WS msg", ev.data);
  try {
    const msg = JSON.parse(ev.data);

    if (msg.type === "peer-join") {
      log(`[client] peer-join (peers=${msg.peers})`);
      if (window.__ROLE__ === "impolite" && msg.peers >= 2 && !__HELLO_SENT__) {
        __HELLO_SENT__ = true;
        sendSignal({ kind: "hello-from-impolite", t: Date.now() });
      }
    }

    if (msg.type === "role") {
      window.__ROLE__ = msg.role; // "impolite" | "polite"
      log(`[client] Assigned role = ${window.__ROLE__} (peers=${msg.peers})`);

      makePeerConnection(); // 기존 Step 3
    }

    // NEW: 상대에게서 온 시그널 수신
    if (msg.type === "signal") {
      handleSignal(msg.payload);
    }

    if (msg.type === "room-full") {
      log("[client] Room is full. Please try later.");
    }
  } catch {}
});

ws.addEventListener("close", () => log("[client] WS close"));

// // 간단한 테스트 메시지 전송
// setTimeout(() => {
//   if (ws.readyState === WebSocket.OPEN) {
//     ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
//   }
// }, 300);

// ===== NEW: 아주 작은 WebRTC 뼈대 =====
let pc = null;
let dc = null;

function makePeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  log("[pc] created");

  pc.addEventListener("connectionstatechange", () => {
    log(`[pc] connectionState = ${pc.connectionState}`);
  });

  pc.addEventListener("icecandidate", (ev) => {
    log("[pc] icecandidate:", ev.candidate ? "got" : "end");
  });

  pc.addEventListener("negotiationneeded", async () => {
    log("[pc] onnegotiationneeded (다음 단계에서 offer 생성)");
  });

  if (window.__ROLE__ === "impolite") {
    dc = pc.createDataChannel("chat");
    log("[dc] created by impolite (name='chat')");
    dc.addEventListener("open", () => log("[dc] open"));
    dc.addEventListener("message", (e) => log("[dc] msg", e.data));
    dc.addEventListener("close", () => log("[dc] close"));
  } else {
    pc.addEventListener("datachannel", (ev) => {
      dc = ev.channel;
      log("[dc] received by polite (name='" + dc.label + "')");
      dc.addEventListener("open", () => log("[dc] open"));
      dc.addEventListener("message", (e) => log("[dc] msg", e.data));
      dc.addEventListener("close", () => log("[dc] close"));
    });
  }
}

// ===== NEW: 시그널 헬퍼와 핸들러 =====
function sendSignal(payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "signal", room: ROOM_NAME, payload }));
  }
}

function handleSignal(payload) {
  log("[signal] received", JSON.stringify(payload));
  // 다음 단계부터 여기서 offer/answer/ICE를 분기 처리합니다.
}
