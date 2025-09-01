const logEl = document.getElementById('log');
const roomInput = document.getElementById('room');
const saveBtn = document.getElementById('saveRoom');
const msgInput = document.getElementById('msg');
const sendBtn = document.getElementById('send');
const disconnectBtn = document.getElementById('disconnect');

const log = (...a) => {
  const s = a.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ');
  console.log('[LOG]', ...a);
  logEl.textContent += s + '\n';
  logEl.scrollTop = logEl.scrollHeight;
};

// --- roomName: sessionStorage 우선 ---
const roomName = sessionStorage.getItem('roomName') || '';
if (roomName) roomInput.value = roomName;
saveBtn.onclick = () => {
  const v = roomInput.value.trim();
  if (v) {
    sessionStorage.setItem('roomName', v);
    log('roomName 저장:', v);
  }
};

// --- WS 연결 ---
const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${wsProtocol}://${location.host}`;
const ws = new WebSocket(wsUrl);

let me = null;          // 나의 peerId
let peer = null;        // 상대 peerId
let polite = false;     // 서버가 정해줌
let pc = null;
let dc = null;          // datachannel
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;

// ICE 서버(예시)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ]
};

// 방 참가 시도(페이지 로드시 자동)
ws.addEventListener('open', () => {
  const rn = sessionStorage.getItem('roomName') || roomInput.value.trim();
  if (!rn) {
    log('⚠️ roomName이 비어 있습니다. 입력 후 [room 저장]을 누르세요.');
    return;
  }
  join(rn);
});

ws.addEventListener('message', async (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === 'joined') {
    me = msg.you;
    polite = !!msg.polite;
    peer = msg.peer; // 있을 수도, 없을 수도
    log('🟢 joined:', { me, polite, peer, room: msg.room });

    // RTCPeerConnection 준비
    await ensurePC();

    // impolite 쪽만 DataChannel 생성 → 글레어 줄임
    if (!polite && !dc) {
      dc = pc.createDataChannel('chat');
      setupDataChannel(dc);
    }
    return;
  }

  if (msg.type === 'peer-joined') {
    peer = msg.peer;
    log('👥 peer-joined:', peer);
    // 상대가 들어오면 negotiationneeded가 자연히 발생(impolite가 dc를 만들었기 때문)
    return;
  }

  if (msg.type === 'peer-left') {
    log('👋 peer-left:', msg.peer);
    peer = null;
    // 연결 유지중이면 닫고 새 연결 준비
    closePC();
    await ensurePC();
    return;
  }

  if (msg.type === 'kicked') {
    log('⚠️ 방이 가득차 교체되었습니다. 새로고침하세요.');
    return;
  }

  if (msg.type === 'signal' && msg.signal && msg.from) {
    // 시그널 수신
    await handleSignal(msg.from, msg.signal);
    return;
  }
});

// 떠날 때 방에 알림(가능하면)
window.addEventListener('unload', () => {
  try {
    const body = JSON.stringify({ type: 'leave' });
    navigator.sendBeacon(wsUrl.replace(/^ws/, 'http'), body);
  } catch {}
});

// --- 기본 유틸 ---
function join(room) {
  ws.send(JSON.stringify({ type: 'join', room }));
}

function sendSignal(to, signal) {
  if (!to) return;
  ws.send(JSON.stringify({ type: 'signal', to, signal }));
}

async function ensurePC() {
  if (pc) return pc;

  pc = new RTCPeerConnection(rtcConfig);

  // Perfect Negotiation flags
  makingOffer = false;
  ignoreOffer = false;
  isSettingRemoteAnswerPending = false;

  pc.addEventListener('connectionstatechange', () => {
    log('pc.connectionState =', pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      // 문제가 생기면 정리
      // (상황에 따라 재시도/재협상 로직을 붙일 수 있음)
    }
  });

  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate && peer) {
      sendSignal(peer, { type: 'candidate', candidate: e.candidate });
    }
  });

  // negotiationneeded: (impolite가 dc를 만들면 자동 발생)
  pc.addEventListener('negotiationneeded', async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      if (peer) sendSignal(peer, { type: 'description', description: pc.localDescription });
    } catch (err) {
      log('negotiationneeded error', err);
    } finally {
      makingOffer = false;
    }
  });

  // 상대가 만든 데이터채널
  pc.addEventListener('datachannel', (e) => {
    dc = e.channel;
    setupDataChannel(dc);
  });

  return pc;
}

function setupDataChannel(ch) {
  ch.addEventListener('open', () => {
    log('💬 DataChannel OPEN');
    // 연결 성사 즉시, 예시 메시지 전송
    ch.send(`hello from ${me} (${polite ? 'polite' : 'impolite'})`);
  });
  ch.addEventListener('message', (e) => {
    log('📩 recv:', e.data);
  });
  ch.addEventListener('close', () => {
    log('💤 DataChannel CLOSED');
  });
}

async function handleSignal(from, signal) {
  if (!pc) await ensurePC();

  // Description 처리 (Perfect Negotiation)
  if (signal.type === 'description') {
    const desc = signal.description;
    const readyForOffer =
      !makingOffer &&
      (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);
    const offerCollision =
      desc.type === 'offer' && !readyForOffer;

    ignoreOffer = !polite && offerCollision;
    if (ignoreOffer) {
      log('⚠️ glare: impolite → remote offer 무시');
      return;
    }

    try {
      if (offerCollision) {
        // polite 쪽: 진행 중이던 로컬 변경 롤백
        log('↩️ glare: polite → rollback');
        await pc.setLocalDescription({ type: 'rollback' });
      }
      isSettingRemoteAnswerPending = desc.type === 'answer';
      await pc.setRemoteDescription(desc);
      isSettingRemoteAnswerPending = false;

      if (desc.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        sendSignal(from, { type: 'description', description: pc.localDescription });
      }
    } catch (err) {
      log('setRemote/Answer error', err);
    }
    return;
  }

  // ICE candidate
  if (signal.type === 'candidate') {
    try {
      await pc.addIceCandidate(signal.candidate);
    } catch (err) {
      if (!ignoreOffer) {
        log('addIceCandidate error', err);
      } else {
        log('addIceCandidate ignored due to glare');
      }
    }
    return;
  }
}

// 전송 버튼
sendBtn.onclick = () => {
  if (dc && dc.readyState === 'open') {
    const text = msgInput.value.trim();
    if (text) {
      dc.send(text);
      log('📤 send:', text);
      msgInput.value = '';
    }
  } else {
    log('⚠️ DataChannel이 아직 열리지 않았습니다.');
  }
};

// 수동 종료
disconnectBtn.onclick = () => {
  closePC();
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'leave' })); } catch {}
  }
};

function closePC() {
  if (dc) { try { dc.close(); } catch {} dc = null; }
  if (pc) {
    try { pc.ontrack = pc.onicecandidate = pc.onnegotiationneeded = null; } catch {}
    try { pc.close(); } catch {}
    pc = null;
  }
}