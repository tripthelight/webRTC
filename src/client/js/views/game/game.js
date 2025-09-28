// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import { createPeer, openMyDataChannel, setSignaling, onSignalMessage } from '../../../rtc/rtc.js';

const $ = (sel) => document.querySelector(sel);
const log = (msg) => {
  const el = $('#log');
  el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  el.scrollTop = el.scrollHeight;
};
const setState = (s) => $('#wsState').textContent = s;

let ws = null;
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;

// 아주 간단한 클라이언트 식별용(나중에 예의바름/비예의바름 판단에도 쓸 예정)
const clientId = crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
// const clientId = (crypto?.randomUUID && crypto.randomUUID()) || String(Math.random());

$('#btnConnect').addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    log('[client] already connected');
    return;
  }
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    setState('connected');
    log('[client] ws open');

    // 이번 단계: Peer 만들기 + 시그널 전송 함수 등록
    createPeer();
    setSignaling((msg) => {
      // 모든 시그널에 sender id를 붙여서 보냄
      ws.send(JSON.stringify({ ...msg, from: clientId }));
    });
  });

  ws.addEventListener('message', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      // 서버는 브로드캐스트이므로 내 것이면 건너뜀(서버가 이미 제외하지만 2중 안전)
      if (data?.from === clientId) return;

      // ★ RTC로 시그널 메시지 전달
      onSignalMessage(data);
    } catch (e) {
      log(`[client] non-JSON message: ${ev.data}`);
    }
  });

  ws.addEventListener('close', () => {
    setState('disconnected');
    log('[client] ws close');
  });

  ws.addEventListener('error', (e) => {
    log(`[client] ws error: ${e?.message ?? e}`);
  });
});

$('#btnDisconnect').addEventListener('click', () => {
  if (ws) {
    ws.close();
    ws = null;
  } else {
    log('[client] not connected');
  }
});

// 이 버튼을 누르면 내가 먼저 dataChannel을 "만들기만" 합니다.
// 그러면 onnegotiationneeded가 발생하는 것을 로그로 확인 가능
$("#btnStart").addEventListener("click", () => {
  openMyDataChannel();
})
