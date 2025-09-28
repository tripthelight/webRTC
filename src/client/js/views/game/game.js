import {Signaling} from '../../../ws/signaling.js';
import {createManualPeer} from '../../../rtc/manualPeer.js';
import {createPeer} from '../../../rtc/peerPN.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // 필요 시 TURN 추가 (실제 값으로 교체)
  // { urls: 'turn:your.turn.server:3478', username: 'user', credential: 'pass' },
];

// 최소한의 clientId 생성기(crypto.randomUUID()우선)
function makeClientId() {
  // 1) 가능하면 표준 UUID
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  // 2) 안전한 난수 16바이트
  const bytes = new Uint8Array(16);

  // 핵심: 메서드 분리 호출 금지! 반드시 객체를 통해 호출
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes); // ✅ 바인딩 OK
    // // 아래처럼 호출해도 동작합니다:
    // globalThis.crypto.getRandomValues.call(globalThis.crypto, bytes);
  } else {
    // 폴백
    for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
  }

  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function getRoomName() {
  // URL 해시(#room-abc) 우선, 없으면 한 번만 물어보고 해시에 저장
  let r = location.hash.replace(/^#/, '');
  if (!r) {
    r = prompt('입장할 방 이름을 입력하세요 (예: room-1)', 'room-1') || '';
    r = r.trim();
    if (!r) { alert('방 이름이 필요합니다. 새로고침 후 다시 시도하세요.'); throw new Error('no room'); }
    location.hash = r;
  }
  return r;
}

// === Peer 관리 테이블 ===
// Map<peerId, { pc, dc, dcOpen, isMakingOffer, isSettingRemoteAnswerPending, ignoreOffer, pendingCandidates }>
const peers = new Map();
function getOrCreatePeer(peerId) {
  let p = peers.get(peerId);
  if (p) return p;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onconnectionstatechange = () => {
    console.log(`[pc:${peerId}] connectionState=`, pc.connectionState);
  };
  pc.onicegatheringstatechange = () => {
    console.log(`[pc:${peerId}] iceGatheringState=`, pc.iceGatheringState);
  };
  pc.oniceconnectionstatechange = () => {
    console.log(`[pc:${peerId}] iceConnectionState=`, pc.iceConnectionState);
  };

  // ★ 새로 추가: ICE 후보 생성 시마다 상대에게 즉시 전송(Trickle ICE)
  pc.onicecandidate = (ev) => {
    // ev.candidate가 null이면 'end-of-candidates' 의미 (보내도/안 보내도 무방)
    sendSignal(peerId, { candidate: ev.candidate });
  };

  pc.onicecandidateerror = (ev) => {
    console.warn(`[pc:${peerId}] icecandidateerror`, ev.errorText || ev);
  };

  // (Step 6의 onnegotiationneeded 로직 그대로 유지)
  pc.onnegotiationneeded = async () => {
    console.log(`[pc:${peerId}] onnegotiationneeded`);
    if (state.polite === true) {
      console.log(`[pc:${peerId}] I am polite → 선제 offer 생성 안 함`);
      return;
    }
    const entry = peers.get(peerId);
    if (!entry || entry.isMakingOffer) return;

    entry.isMakingOffer = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log(`[pc:${peerId}] → send offer`);
      sendSignal(peerId, { sdp: pc.localDescription });
    } catch (err) {
      console.warn(`[pc:${peerId}] offer 실패`, err);
    } finally {
      entry.isMakingOffer = false;
    }
  };

  pc.ondatachannel = (ev) => {
    const dc = ev.channel;
    attachDataChannelHandlers(peerId, dc, /*isOwner*/ false);
    const entry = peers.get(peerId);
    if (entry) entry.dc = dc;
  };

  p = {
    pc,
    dc: null,
    dcOpen: false,
    isMakingOffer: false,
    isSettingRemoteAnswerPending: false,
    ignoreOffer: false,
    pendingCandidates: [] // ★ 후보 임시 저장 큐
  };
  peers.set(peerId, p);
  return p;
}

// DataChannel 공통 핸들러
function attachDataChannelHandlers(peerId, dc, isOwner) {
  console.log(`[dc:${peerId}] created name="${dc.label}" owner=${isOwner}`);

  dc.onopen = () => {
    peers.get(peerId).dcOpen = true;
    console.log(`[dc:${peerId}] open`);

    // ★ 테스트: 열린 순간 간단한 메시지 1회 전송
    try { dc.send(`hello from ${state.clientId} @${new Date().toLocaleTimeString()}`); } catch {}
  };
  dc.onclose = () => {
    peers.get(peerId).dcOpen = false;
    console.log(`[dc:${peerId}] close`);
  };
  dc.onerror = (e) => {
    console.log(`[dc:${peerId}] error`, e);
  };
  dc.onmessage = (e) => {
    console.log(`[dc:${peerId}] message:`, e.data);
  };
}

// Peer 자원 정리
function cleanupPeer(peerId) {
  const p = peers.get(peerId);
  if (!p) return;
  try { p.dc?.close(); } catch {}
  try { p.pc?.close(); } catch {}
  peers.delete(peerId);
  console.log(`[peer:${peerId}] cleaned`);
}

// SDP 적용 직후, 대기 중이던 후보 드레인(drain) 유틸
async function drainPendingCandidates(peerId) {
  const entry = peers.get(peerId);
  if (!entry) return;
  const { pc, pendingCandidates } = entry;
  if (!pc.remoteDescription) return; // 원격 SDP가 먼저 있어야 addIceCandidate 가능

  while (pendingCandidates.length > 0) {
    const c = pendingCandidates.shift();
    try {
      await pc.addIceCandidate(c);
      console.log(`[pc:${peerId}] addIceCandidate (queued)`);
    } catch (err) {
      console.warn(`[pc:${peerId}] addIceCandidate(queued) 실패`, err);
    }
  }
}

function getOrMakeUserId() {
  try {
    const k = 'webrtc-demo-userId';
    let id = localStorage.getItem(k);
    if (!id) {
      id = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)) + '-u';
      localStorage.setItem(k, id);
    }
    return id;
  } catch {
    // localStorage 불가 환경 폴백
    return (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)) + '-u';
  }
}

// === App 상태 + WS
const state = {
  userId: getOrMakeUserId(),   // ★ 새로고침해도 유지
  clientId: makeClientId(),    // ★ 매 세션마다 새로 생성(기존대로)
  roomName: getRoomName(),
  polite: null,
  peers: new Set(),
};

console.log('[client] clientId=', state.clientId, 'room=', state.roomName);

const SIGNALING_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
// const ws = new WebSocket(SIGNALING_URL);

let ws;
function connectWS() {
  ws = new WebSocket(SIGNALING_URL);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      type: 'join',
      roomName: state.roomName,
      userId: state.userId,
      clientId: state.clientId
    }));
  });
  ws.addEventListener('message', onWSMessage);
  ws.addEventListener('close', () => {
    console.log('[client] ws closed → retry in 800ms');
    setTimeout(connectWS, 800);
  });
  ws.addEventListener('error', (e) => {
    console.log('[client] ws error', e);
    try { ws.close(); } catch {}
  });
}
connectWS();

// --- [추가] 시그널 헬퍼 ---
function sendSignal(toPeerId, payload) {
  ws.send(JSON.stringify({
    type: "signal",
    to: toPeerId,
    roomName: state.roomName,
    clientId: state.clientId,
    ...payload
  }));
};

async function onWSMessage(e) {
  const text = typeof e.data === 'string' ? e.data : await e.data.text();
  let msg;
  try { msg = JSON.parse(text); }
  catch { return; }

  switch (msg.type) {
    case 'joined': {
      state.polite = !!msg.polite;
      state.peers = new Set(msg.peers || []);
      console.log(`[client] joined room="${msg.roomName}" polite=${state.polite} peers=`, [...state.peers]);

      for (const peerId of state.peers) {
        const entry = getOrCreatePeer(peerId);
        if (state.polite === false && !entry.dc) {
          const dc = entry.pc.createDataChannel('chat');
          attachDataChannelHandlers(peerId, dc, /*isOwner*/ true);
          entry.dc = dc;
        }
      }
      break;
    }

    case 'room-full': {
      console.warn(`[client] room "${msg.roomName}" is full.`);
      alert('방이 가득 찼습니다.');
      break;
    }

    case 'peer-join': {
      if (msg.clientId && msg.clientId !== state.clientId) {
        state.peers.add(msg.clientId);
        console.log('[client] peer-join:', msg.clientId, 'peers=', [...state.peers]);

        const entry = getOrCreatePeer(msg.clientId);
        if (state.polite === false && !entry.dc) {
          const dc = entry.pc.createDataChannel('chat');
          attachDataChannelHandlers(msg.clientId, dc, /*isOwner*/ true);
          entry.dc = dc;
        }
      }
      break;
    }

    case 'peer-leave': {
      if (msg.clientId) {
        state.peers.delete(msg.clientId);
        console.log('[client] peer-leave:', msg.clientId, 'peers=', [...state.peers]);
        cleanupPeer(msg.clientId);
      }
      break;
    }

    case 'peer-replace': {
      const { oldClientId, newClientId, userId } = msg;
      if (oldClientId && peers.has(oldClientId)) {
        cleanupPeer(oldClientId);
        state.peers.delete(oldClientId);
      }
      if (newClientId && newClientId !== state.clientId) {
        state.peers.add(newClientId);
        console.log('[client] peer-replace:', { oldClientId, newClientId, userId });
        const entry = getOrCreatePeer(newClientId);
        if (state.polite === false && !entry.dc) {
          const dc = entry.pc.createDataChannel('chat');
          attachDataChannelHandlers(newClientId, dc, /*isOwner*/ true);
          entry.dc = dc;
        }
      }
      break;
    }

    case 'signal': {
      const from = msg.from;
      if (!from || from === state.clientId) break;
      const entry = getOrCreatePeer(from);
      const pc = entry.pc;

      // --- SDP 처리 ---
      if (msg.sdp) {
        const desc = msg.sdp;

        if (desc.type === 'offer') {
          console.log(`[pc:${from}] ← offer 수신`);

          const offerCollision =
            (entry.isMakingOffer) ||
            (pc.signalingState !== 'stable');

          entry.ignoreOffer = !state.polite && offerCollision;
          if (entry.ignoreOffer) {
            console.log(`[pc:${from}] glare: impolite → offer 무시`);
            break;
          }

          entry.isSettingRemoteAnswerPending = (desc.type === 'answer');
          try {
            if (offerCollision && state.polite) {
              console.log(`[pc:${from}] glare: polite → rollback 후 수용`);
              await pc.setLocalDescription({ type: 'rollback' });
            }
            await pc.setRemoteDescription(desc);
            await drainPendingCandidates(from);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            console.log(`[pc:${from}] → answer 전송`);
            sendSignal(from, { sdp: pc.localDescription });
          } catch (err) {
            console.warn(`[pc:${from}] offer 처리 실패`, err);
          } finally {
            entry.isSettingRemoteAnswerPending = false;
          }
        } else if (desc.type === 'answer') {
          console.log(`[pc:${from}] ← answer 수신`);
          try {
            entry.isSettingRemoteAnswerPending = true;
            await pc.setRemoteDescription(desc);
            await drainPendingCandidates(from);
          } catch (err) {
            console.warn(`[pc:${from}] answer 처리 실패`, err);
          } finally {
            entry.isSettingRemoteAnswerPending = false;
          }
        }
      }

      // --- ICE 후보 처리 ---
      if ('candidate' in msg) {
        if (msg.candidate == null) {
          console.log(`[pc:${from}] end-of-candidates`);
          break;
        }
        try {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(msg.candidate);
            console.log(`[pc:${from}] addIceCandidate (immediate)`);
          } else {
            entry.pendingCandidates.push(msg.candidate);
            console.log(`[pc:${from}] queue ICE candidate`);
          }
        } catch (err) {
          console.warn(`[pc:${from}] addIceCandidate 실패`, err);
        }
      }
      break;
    }

    default:
      // 다른 타입 무시
      break;
  }
}

ws.addEventListener('message', async (e) => {
  const text = typeof e.data === 'string' ? e.data : await e.data.text();
  let msg; try { msg = JSON.parse(text); } catch { return; }

  switch (msg.type) {
    case 'joined': {
      state.polite = !!msg.polite;
      state.peers = new Set(msg.peers || []);
      console.log(`[client] joined room="${msg.roomName}" polite=${state.polite} peers=`, [...state.peers]);

      for (const peerId of state.peers) {
        const entry = getOrCreatePeer(peerId);
        if (state.polite === false && !entry.dc) {
          const dc = entry.pc.createDataChannel('chat');
          attachDataChannelHandlers(peerId, dc, /*isOwner*/ true);
          entry.dc = dc;
        }
      }
      break;
    }
    case 'peer-join': {
      if (msg.clientId && msg.clientId !== state.clientId) {
        state.peers.add(msg.clientId);
        console.log('[client] peer-join:', msg.clientId, 'peers=', [...state.peers]);
        const entry = getOrCreatePeer(msg.clientId);
        if (state.polite === false && !entry.dc) {
          const dc = entry.pc.createDataChannel('chat');
          attachDataChannelHandlers(msg.clientId, dc, /*isOwner*/ true);
          entry.dc = dc;
        }
      }
      break;
    }
    case 'peer-leave': {
      if (msg.clientId) {
        state.peers.delete(msg.clientId);
        console.log('[client] peer-leave:', msg.clientId, 'peers=', [...state.peers]);
        // [추가] 자원 정리
        cleanupPeer(msg.clientId);
      }
      break;
    }
    case 'room-full': {
      console.warn(`[client] room "${msg.roomName}" is full (정원 2명). 다른 방으로 들어가세요.`);
      alert('해당 방은 정원(2명)이 찼습니다. 해시(#)를 다른 이름으로 바꾼 뒤 새로고침 하세요.');
      break;
    }
    case 'signal': {
      const from = msg.from;
      if (!from || from === state.clientId) break;
      const entry = getOrCreatePeer(from);
      const pc = entry.pc;

      // --- SDP 처리 ---
      if (msg.sdp) {
        const desc = msg.sdp;

        if (desc.type === 'offer') {
          console.log(`[pc:${from}] ← offer 수신`);

          const offerCollision =
            (entry.isMakingOffer) ||
            (pc.signalingState !== 'stable');

          entry.ignoreOffer = !state.polite && offerCollision;
          if (entry.ignoreOffer) {
            console.log(`[pc:${from}] glare: 나는 impolite → 이번 offer 무시`);
            break;
          }

          entry.isSettingRemoteAnswerPending = (desc.type === 'answer');
          try {
            if (offerCollision && state.polite) {
              console.log(`[pc:${from}] glare: 나는 polite → rollback 후 상대 offer 수용`);
              await pc.setLocalDescription({ type: 'rollback' });
            }
            await pc.setRemoteDescription(desc);
            // ★ 원격 SDP 적용 직후, 대기 후보 드레인
            await drainPendingCandidates(from);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            console.log(`[pc:${from}] → answer 전송`);
            sendSignal(from, { sdp: pc.localDescription });
          } catch (err) {
            console.warn(`[pc:${from}] offer 처리 실패`, err);
          } finally {
            entry.isSettingRemoteAnswerPending = false;
          }
        } else if (desc.type === 'answer') {
          console.log(`[pc:${from}] ← answer 수신`);
          try {
            entry.isSettingRemoteAnswerPending = true;
            await pc.setRemoteDescription(desc);
            // ★ 원격 SDP 적용 직후, 대기 후보 드레인
            await drainPendingCandidates(from);
          } catch (err) {
            console.warn(`[pc:${from}] answer 처리 실패`, err);
          } finally {
            entry.isSettingRemoteAnswerPending = false;
          }
        }
      }

      // --- ICE 후보 처리(새로 추가) ---
      if ('candidate' in msg) {
        // null(= end-of-candidates) 이면 그냥 전달하거나 무시 가능
        if (msg.candidate == null) {
          // 선택: 원하면 아래 주석 해제
          // await pc.addIceCandidate(null).catch(() => {});
          console.log(`[pc:${from}] end-of-candidates`);
          break;
        }

        try {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(msg.candidate);
            console.log(`[pc:${from}] addIceCandidate (immediate)`);
          } else {
            // 원격 SDP가 아직 없으면 큐에 저장
            entry.pendingCandidates.push(msg.candidate);
            console.log(`[pc:${from}] queue ICE candidate (no remoteDescription yet)`);
          }
        } catch (err) {
          console.warn(`[pc:${from}] addIceCandidate 실패`, err);
        }
      }

      break;
    }
    case 'peer-replace': {
      const { oldClientId, newClientId, userId } = msg;
      if (oldClientId && peers.has(oldClientId)) {
        // 1) 옛 연결 완전 정리
        cleanupPeer(oldClientId);
        state.peers.delete(oldClientId);
      }
      // 2) 새 peerId 등록(같은 사람의 새 세션)
      if (newClientId && newClientId !== state.clientId) {
        state.peers.add(newClientId);
        console.log('[client] peer-replace:', { oldClientId, newClientId, userId });

        // 새 세션에 대해 처음부터 연결 준비
        const entry = getOrCreatePeer(newClientId);
        // impolite이면 DC 선생성(우리 규칙 그대로)
        if (state.polite === false && !entry.dc) {
          const dc = entry.pc.createDataChannel('chat');
          attachDataChannelHandlers(newClientId, dc, /*isOwner*/ true);
          entry.dc = dc;
        }
      }
      break;
    }
    default:
      break;
  }
});

function sendBye() {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'bye',
        roomName: state.roomName,
        userId: state.userId,
        clientId: state.clientId
      }));
    }
  } catch {}
}

window.addEventListener('beforeunload', sendBye);
// 탭 전환 순간에도 빠르게 쏘고 싶다면(선택):
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') sendBye();
});

// 콘솔에서 모든 피어에게 보내기: window.say('안녕')
window.say = (text) => {
  for (const [peerId, entry] of peers) {
    if (entry.dc && entry.dcOpen) {
      entry.dc.send(String(text));
    }
  }
  console.log('[chat] sent:', text);
};
