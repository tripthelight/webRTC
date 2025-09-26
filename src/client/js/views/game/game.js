import {Signaling} from '../../../ws/signaling.js';
import {createManualPeer} from '../../../rtc/manualPeer.js';
import {createPeer} from '../../../rtc/peerPN.js';

const SIGNALING_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;

const $ = (sel) => document.querySelector(sel);
const logBox = $('#log');
const roomInput = $('#room');
const connectBtn = $('#connectBtn');
const msgInput = $('#msg');
const sendBtn  = $('#sendBtn');
function log(...args) {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ');
  logBox.textContent += line + '\n';
  logBox.scrollTop = logBox.scrollHeight;
}

let ws;

function uuid4() {
  // 충돌 가능성 극히 낮은 간단 UUID. (CSPRNG가 아니어도 데모엔 충분)
  return ([1e7]+-1e3+-4e3+-8e3+-1e11)
    .replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}
let myId = localStorage.getItem('pn_my_id') || (localStorage.setItem('pn_my_id', uuid4()), localStorage.getItem('pn_my_id'));
let peerId = null; // 상대 ID를 시그널로 주고 받음

let pc; // RTCPeerConnection
let dc; // RTCDataChannel
let isCaller = false; // 아주 단순하게: 내가 먼저 오퍼 만드는 쪽인지 표시
let makingOffer = false;
let isSettingRemoteAnswerPending = false;
let ignoreOffer = false;
let polite = false; // 기본값: 불공손. 아래에서 역할이 정해지면 업데이트.

let wsReady = false;
let outgoingBuf = [];
function safeSend(dataObj) {
  const raw = JSON.stringify(dataObj);
  if (ws && ws.readyState === WebSocket.OPEN && wsReady) {
    ws.send(raw);
  } else {
    outgoingBuf.push(raw);
  }
}

// 디바운서 도우미
function debounce(fn, ms=0) {
  let t; return (...args) => {
    clearTimeout(t); t = setTimeout(() => fn(...args), ms);
  };
}

let reconnectAttempts = 0;
function flushBuffer() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const raw of outgoingBuf) ws.send(raw);
  outgoingBuf = [];
}
function connectWS(room) {
  ws = new WebSocket(SIGNALING_URL);

  ws.addEventListener('open', () => {
    log('WS: open');
    wsReady = true; reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: 'join', room }));
    flushBuffer();
  });

  ws.addEventListener('close', () => {
    log('WS: close');
    wsReady = false;
    // 지수 백오프로 재연결
    const delay = Math.min(2000 * 2 ** reconnectAttempts, 15000);
    reconnectAttempts++;
    setTimeout(() => {
      log('WS: reconnecting...');
      connectWS(room);
    }, delay);
  });

  ws.addEventListener('error', (e) => log('WS: error', String(e)));

  ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'joined') {
      log(`WS: joined room "${msg.room}"`);
      // 방에 들어오면 PeerConnection 생성
      setupPeerConnection();
      sendSignal({ hello: { id: myId } }); // 내 ID를 먼저 광고
      polite = !isCaller; // 기존 false 였다가, 나중 접속자는 true로 유지됨

    } else if (msg.type === 'peer-joined') {
      log('WS: peer joined');

      // 내가 이 알림을 받은 쪽 → caller 역할
      isCaller = true;
      polite = false; // 기존 탭은 불공손

      // 1) 내가 데이터채널을 먼저 만든다.
      const channel = pc.createDataChannel('chat');
      wireDataChannel(channel, 'local-dc');

      // 이제 offer는 onnegotiationneeded에서 자동 생성됨
    } else if (msg.type === 'peer-left') {
      log('WS: peer left');

    } else if (msg.type === 'signal') {
      // log('WS: got signal payload (will be used later):', msg.payload);

      const { description, candidate, hello } = msg.payload || {};

      // 0) ID 교환
      if (hello && hello.id) {
        peerId = hello.id;
        // 항상 큰 쪽이 공손(polite=true)
        const me = String(myId), you = String(peerId);
        const iAmPolite = me > you; // 문자열 사전식 비교(길이 동일한 UUID 가정)
        polite = iAmPolite;
        log(`ROLE: decided by id — myId=${me.slice(0,8)} you=${you.slice(0,8)} → polite=${polite}`);
        // 나도 내 ID를 상대가 못 들었을 수 있으니 한번 더 보내기(무해)
        sendSignal({ hello: { id: myId } });
      }

      try {
        // A) SDP 수신
        if (description) {
          const readyForOffer = !makingOffer && (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);
          const offerCollision = description.type === 'offer' && !readyForOffer;

          ignoreOffer = !polite && offerCollision;
          if (ignoreOffer) {
            log('PN: offer collision — unpolite side ignoring offer');
            return; // 무시하고 끝
          }

          isSettingRemoteAnswerPending = description.type === 'answer';
          await pc.setRemoteDescription(description);
          isSettingRemoteAnswerPending = false;

          if (description.type === 'offer') {
            // 내가 상대 오퍼를 받았으면, 내 로컬에 answer를 만들어 돌려준다
            await pc.setLocalDescription();
            sendSignal({ description: pc.localDescription });
            log('SDP: answer sent (PN)');
          }
          // answer 수신이면 여기서 종료 (위에서 serRemoteDescription 끝)
          log(`SDP: ${description.type} handled (PN)`)
        }

        // B) ICE 후보 수신
        if (candidate) {
          await pc.addIceCandidate(candidate);
          log('ICE: remote candidate added');
        }
      } catch (err) {
        log('Signal handling error:', String(err));
      }
    }
  });



}

connectBtn.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    log('WS already connected');
    return;
  }
  const room = roomInput.value.trim() || 'taptap';
  connectWS(room);
});

sendBtn.addEventListener('click', () => {
  const text = msgInput.value.trim();
  if (!text || !dc || dc.readyState !== 'open') return;
  dc.send(text);
  log(`DC(me) → ${text}`);
  msgInput.value = '';
});

function sendSignal(payload) {
  safeSend({ type: "signal", payload })
}

function wireDataChannel(channel, label = 'dc') {
  dc = channel;

  dc.onopen = () => {
    log(`DC(${label}): open`);
    sendBtn.disabled = false; // 열리면 메시지 전송 가능
  };

  dc.onmessage = (ev) => {
    log(`DC(${label}) ← ${ev.data}`);
  };

  dc.onclose = () => {
    log(`DC(${label}): close`);
    sendBtn.disabled = true;
  };
}

const handleNegotiationNeeded = debounce(async () => {
  try {
    log('NEG(debounced): onnegotiationneeded');
    makingOffer = true;
    await pc.setLocalDescription(); // 필요 시 자동 offer 생성
    sendSignal({ description: pc.localDescription });
    log('SDP: offer sent (PN debounced)');
  } catch (e) {
    log('NEG error:', String(e));
  } finally {
    makingOffer = false;
  }
}, 50); // 50~120ms 사이 추천

function setupPeerConnection() {
  pc = new RTCPeerConnection({
    // STUN은 브라우저 기본(구글 퍼블릭)으로도 충분. 명시하고 싶다면 아래 주석 해제.
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  // 1) ICE 후보가 생길 때마다 시그널로 전달
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      sendSignal({ candidate: ev.candidate });
      log('ICE: local candidate sent');
    }
  };

  // 2) 상대가 만든 데이터채널을 받을 때
  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    wireDataChannel(dc, 'remote-dc');
  };

  // 3) 재협상 필요 시점: 오퍼를 "여기서" 만든다 (아직 PN 가드 없음)
  pc.onnegotiationneeded = () => handleNegotiationNeeded();

  pc.onconnectionstatechange = () => {
    log(`PC: connectionstate=${pc.connectionState}`);
    if (pc.connectionState === 'failed') {
      // ICE 실패 → 재협상(= ICE 재수집) 유도
      try { pc.restartIce?.(); log('ICE: restartIce()'); } catch {}
    }
  };

  pc.oniceconnectionstatechange = () => {
    log(`PC: iceConnectionState=${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'disconnected') {
      // 잠깐 끊김일 수도 → 약간 기다렸다 still disconnected면 재협상
      setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected') {
          // 재협상 트리거(채널 생성 → onnegotiationneeded 유발해도 되고,
          // 혹은 명시적으로 setLocalDescription() 시도)
          handleNegotiationNeeded();
        }
      }, 800);
    }
  };
}

// 탭이 사라졌다 돌아올 때, 필요하면 재협상
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pc) {
    // 돌아오자마자 상태 확인 후 살짝 건드려 onnegotiationneeded 유발
    handleNegotiationNeeded();
  }
});

// 페이지 떠날 때 힌트(선택)
window.addEventListener('beforeunload', () => {
  try { dc?.close(); } catch {}
  try { pc?.close(); } catch {}
});
