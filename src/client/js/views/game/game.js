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

// ———————————————————————————————————————————————————



const STATE = {
  ws: null,
  roomId: null,
  peerId: null,
  role: null,        // 'impolite' | 'polite'
  partnerId: null,
  pc: null,          // RTCPeerConnection
  dc: null,          // RTCDataChannel (impolite가 선제 생성, polite는 ondatachannel로 받음)
  makingOffer: false,
  ignoreOffer: false,
  isSettingRemoteAnswerPending: false,
};

// [추가] 재연결/리스타트 상태 관리
let WS_RETRY = { tries: 0, timer: null };
const WS_RETRY_MAX = 6;          // 최대 6회 (0.2s → 6.4s)
const WS_RETRY_BASE = 200;       // 200ms 지수 백오프

let ICE_RESTART_TIMER = null;
const ICE_RESTART_DEBOUNCE = 1200; // ms: 흔들림 동안 과도 호출 방지

const ICE_SERVERS = [
  // 공개 STUN 예시(실서비스는 TURN 필요)
  { urls: 'stun:stun.l.google.com:19302' },
];

function log(...args) {
  console.log('[CLIENT]', ...args);
}

function isPolite() {
  return STATE.role === 'polite';
}

function sendSignal(toPeerId, data) {
  if (!STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;
  STATE.ws.send(JSON.stringify({ type: 'signal', to: toPeerId, data }));
}

function cleanupPeerConnection(logIt = true) {
  if (STATE.dc) {
    try { STATE.dc.close(); } catch {}
    STATE.dc = null;
  }
  if (STATE.pc) {
    try { STATE.pc.onicecandidate = null;
      STATE.pc.ondatachannel = null;
      STATE.pc.onconnectionstatechange = null;
      STATE.pc.oniceconnectionstatechange = null;
      STATE.pc.close();
    } catch {}
    STATE.pc = null;
  }
  STATE.makingOffer = false;
  STATE.ignoreOffer = false;
  STATE.isSettingRemoteAnswerPending = false;
  if (logIt) log('PC cleaned up.');
}

function scheduleWsReconnect() {
  if (WS_RETRY.timer) return; // 이미 예약됨
  const t = Math.min(WS_RETRY_MAX, WS_RETRY.tries++);
  const delay = WS_RETRY_BASE * Math.pow(2, t); // 200ms, 400ms, 800ms...
  WS_RETRY.timer = setTimeout(() => {
    WS_RETRY.timer = null;
    connectSignaling(true);
  }, delay);
}
function debounceIceRestart() {
  if (ICE_RESTART_TIMER) clearTimeout(ICE_RESTART_TIMER);
  ICE_RESTART_TIMER = setTimeout(() => {
    ICE_RESTART_TIMER = null;
    doIceRestart().catch(err => console.error('ICE restart failed:', err));
  }, ICE_RESTART_DEBOUNCE);
}

/**
 * ICE Restart:
 * - localDescription을 새로 만들되, createOffer({ iceRestart: true }) 사용
 * - Perfect Negotiation의 "impolite만 오퍼 생성" 규칙 유지
 */
async function doIceRestart() {
  const pc = STATE.pc;
  if (!pc) return;
  if (STATE.role !== 'impolite') return; // 단일 오퍼 생성자 유지

  log('ICE Restart: creating new offer with iceRestart:true');
  try {
    STATE.makingOffer = true;
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    sendSignal(STATE.partnerId, { sdp: pc.localDescription });
  } finally {
    STATE.makingOffer = false;
  }
}

// -------------------- DataChannel 헬퍼 --------------------
function attachDataChannelHandlers(dc, tag) {
  dc.onopen = () => {
    log(`DataChannel[${tag}] open`);
    // ▶ 여기서부터 게임 메시지 송수신 가능
    // 예시: 주기적 ping
    // dc.send(JSON.stringify({ t: 'ping', at: Date.now() }));
  };
  dc.onmessage = (ev) => {
    // 서버 없이 두 브라우저 간 게임 상태/입력 등을 주고 받기
    // 예: const msg = JSON.parse(ev.data);
    // log('dc message:', msg);
  };
  dc.onclose = () => {
    log(`DataChannel[${tag}] close`);
    // 채널이 닫힌 건 연결 흔들림 신호일 수 있음 → impolite가 재협상 트리거
    if (STATE.role === 'impolite' && STATE.pc?.connectionState !== 'closed') {
      debounceIceRestart();
    }
  };
}

// -------------------- WebRTC: Perfect Negotiation --------------------
async function startPeerConnection() {
  // 이미 존재하면 재사용하지 않고 깨끗이 재생성(난타/재입장에도 단순하고 안전)
  cleanupPeerConnection(false);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  STATE.pc = pc;

  // --- Perfect Negotiation용 내부 플래그 초기화 ---
  STATE.makingOffer = false;
  STATE.ignoreOffer = false;
  STATE.isSettingRemoteAnswerPending = false;

  // (게임은 데이터채널 기반이므로 트랙 추가는 생략)
  // impolite는 "선제 오퍼 생성자"로서 데이터채널을 먼저 생성해
  // onnegotiationneeded를 유발 → offer를 단 한쪽에서만 만들게 유도.
  if (STATE.role === 'impolite') {
    STATE.dc = pc.createDataChannel('game'); // 이 순간 아직 open 아님 → onopen에서 사용
    attachDataChannelHandlers(STATE.dc, 'active-dc');
  } else {
    STATE.dc = null; // polite는 상대가 만든 채널을 ondatachannel로 받음
  }

  // --- 이벤트 바인딩 ---

  // 1) negotiationneeded: 로컬 변경(채널 생성 등)으로 협상이 필요해질 때 호출
  pc.onnegotiationneeded = async () => {
    // 오직 "impolite"만 선제 오퍼를 만든다 → offer 단일화
    if (STATE.role !== 'impolite') {
      log('negotiationneeded (polite) → no-op (wait for offer)');
      return;
    }
    try {
      STATE.makingOffer = true;
      log('negotiationneeded → creating offer (impolite)');
      await pc.setLocalDescription(await pc.createOffer());
      sendSignal(STATE.partnerId, { sdp: pc.localDescription });
    } catch (err) {
      console.error('onnegotiationneeded error:', err);
    } finally {
      STATE.makingOffer = false;
    }
  };

  // 2) 원격에서 생성한 데이터채널 수신 (polite가 주로 받음)
  pc.ondatachannel = (ev) => {
    log('ondatachannel:', ev.channel?.label);
    STATE.dc = ev.channel;
    attachDataChannelHandlers(STATE.dc, 'passive-dc');
  };

  // 3) ICE 후보 발견 시 상대에게 릴레이
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      sendSignal(STATE.partnerId, { candidate: ev.candidate });
    } else {
      // candidate=null → ICE 후보 송신 종료 신호(end-of-candidates)
      sendSignal(STATE.partnerId, { candidate: null });
    }
  };

  // (선택) 연결 상태 로깅
  pc.onconnectionstatechange = () => {
    log('connectionstate:', pc.connectionState);
    // 'failed' → (TURN 필요/네트워크 문제) 실제 서비스에선 ICE restart 고려
  };
  pc.oniceconnectionstatechange = () => {
    log('iceconnectionstate:', pc.iceConnectionState);

    // 연결이 흔들리거나 실패할 때, impolite 쪽이 ICE Restart를 주도
    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
      if (STATE.role === 'impolite') {
        debounceIceRestart();
      } else {
        // polite는 보수적으로 대기. (상대가 재시작 주도)
        // 필요하다면 일정 시간 후 상대가 실패하면 우리가 주도하는 전략도 가능.
      }
    }
  };
}

// 수신 시그널(SDP/ICE) 처리: Perfect Negotiation 핵심
async function handleRemoteSignal(msg) {
  const pc = STATE.pc;
  if (!pc) return;
  const data = msg.data;

  try {
    if (data?.sdp) {
      // --- SDP 처리 흐름 ---
      const desc = data.sdp;

      // 1) glare(동시 오퍼) 판단
      // - 'offer'를 받았는데 내가 지금 오퍼를 만들고 있거나(makingOffer)
      //   혹은 내가 이미 remote offer를 받아놓고 아직 local answer를 쓰는 중이면(isSettingRemoteAnswerPending)
      //   → "offer 충돌(offerCollision)"
      const offerCollision =
        desc.type === 'offer' &&
        (STATE.makingOffer || STATE.isSettingRemoteAnswerPending);

      // 2) 충돌 시 처리 규칙
      // - polite: 충돌이어도 상대 오퍼를 "수용" (rollback 또는 대기 전략)
      // - impolite: 충돌이면 "무시" (ignoreOffer = true)
      STATE.ignoreOffer = !isPolite() && offerCollision;
      if (STATE.ignoreOffer) {
        log('Glare detected → ignoring remote offer (impolite).');
        return;
      }

      if (desc.type === 'offer') {
        // (중요) 만약 우리가 로컬 변경을 적용한 직후라면 rollback으로 상태를 되돌려 충돌 해소
        if (STATE.makingOffer) {
          log('Rollback before applying remote offer (polite glare resolution).');
          await pc.setLocalDescription({ type: 'rollback' });
        }

        // 원격 offer 적용
        await pc.setRemoteDescription(desc);

        // answer 생성/전송
        STATE.isSettingRemoteAnswerPending = true;
        await pc.setLocalDescription(await pc.createAnswer());
        sendSignal(STATE.partnerId, { sdp: pc.localDescription });
        STATE.isSettingRemoteAnswerPending = false;
      } else {
        // 'answer'
        await pc.setRemoteDescription(desc);
      }
    } else if ('candidate' in data) {
      // --- ICE 후보 처리 ---
      try {
        await pc.addIceCandidate(data.candidate || null);
      } catch (err) {
        // glare 무시 등으로 remote SDP가 아직 설정 전일 때 발생 가능
        if (!STATE.ignoreOffer) {
          console.error('addIceCandidate error:', err);
        } else {
          // 무시 모드일 땐 조용히 스킵
        }
      }
    }
  } catch (err) {
    console.error('handleRemoteSignal error:', err);
  }
}

function connectSignaling(reconnect = false) {
  // 이미 열려있으면 그대로 둠
  if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) return;

  // 배포시에는 wss://prod.example.com 등으로 교체
  STATE.ws = ws;

  ws.addEventListener('open', () => {
    log(reconnect ? 'WS reconnected.' : 'WS connected.');
    // 재연결 성공 → 카운터 리셋
    WS_RETRY.tries = 0;
    if (WS_RETRY.timer) { clearTimeout(WS_RETRY.timer); WS_RETRY.timer = null; }
  });

  ws.addEventListener('message', async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case 'room-assigned': {
        // 서버가 방 배정 및 나의 역할을 알려줌
        STATE.roomId = msg.roomId;
        STATE.peerId = msg.peerId;
        STATE.role   = msg.role; // Perfect Negotiation에서 핵심: 나의 관례적 역할
        log(`Assigned to room=${STATE.roomId}, peerId=${STATE.peerId}, role=${STATE.role}`);
        break;
      }

      case 'paired': {
        if (msg.roomId !== STATE.roomId) return;

        // 서버 권위로 역할 재확인 + 파트너 ID 확보
        if (msg.you?.peerId === STATE.peerId) {
          STATE.role = msg.you.role;
          STATE.partnerId = msg.partner.peerId;
          log(`Paired! me(${STATE.role}) <-> partner(${msg.partner.peerId}/${msg.partner.role})`);

          // ▶ 버튼 없이 즉시 WebRTC 시작
          await startPeerConnection();
        }
        break;
      }

      case 'partner-left': {
        if (msg.roomId !== STATE.roomId) return;
        log(`Partner left: ${msg.peerId}. Cleaning up PC...`);
        cleanupPeerConnection(); // 상대가 나갔으니 PC 정리
        // 이후 새 파트너가 오면 서버가 다시 paired 이벤트를 주고, startPeerConnection()이 다시 호출됨
        break;
      }

      case 'signal': {
        // 서버 릴레이로 전송된 SDP/ICE 처리
        // 구조: { type: 'signal', from, data: { sdp? | candidate? } }
        if (!STATE.pc) {
          // 드물게 타이밍 이슈로 PC가 아직 준비 전일 수 있음 → 준비 후에도 수신될 수 있게 최소화
          await startPeerConnection();
        }
        await handleRemoteSignal(msg);
        break;
      }
    }
  });

  ws.addEventListener('close', () => {
    log('WS disconnected. retrying...');
    scheduleWsReconnect();
  });

  ws.addEventListener('error', () => {
    // 에러 발생 즉시 닫히지 않을 수 있으니 보호적으로 재연결 예약
    try { ws.close(); } catch {}
  });
}

// 1) 시그널링 서버에 자동 연결 (버튼 없음)
connectSignaling();
