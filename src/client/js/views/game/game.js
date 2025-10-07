import "../../../scss/common.scss";
// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import {scheduleRefresh} from "../../common/refreshScheduler.js"

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
// scheduleRefresh();

// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
// const ws = new WebSocket(WS_URL);

// 목표: 두 번째 입장자가 DataChannel을 만들며 offer를 보내고,
//      Perfect Negotiation 기본 구조로 글레어를 흡수.
//      새로고침 시 자동 재접속(단일 새로고침)까지 지원.

// ======== 설정(실험/개발용) ========
const ROOM_ID = 'dev-room-1'; // 같은 ROOM_ID를 가진 2개의 브라우저 탭/창으로 테스트

// ======== 페이지 요소 ========
const $log = document.getElementById('log');
const $text = document.getElementById('text');
const $sendBtn = document.getElementById('sendBtn');

// ======== 유틸 ========
function log(...args) {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  $log.textContent += line + '\n';
  $log.scrollTop = $log.scrollHeight;
}
function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) || Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ======== 상태 변수 ========
let ws;                 // 시그널링용 WebSocket
let pc;                 // RTCPeerConnection
let dc;                 // DataChannel (offerer가 생성)
let polite = false;     // Perfect Negotiation에서 "공손한 쪽" (글레어 시 더 유연)
let iAmOfferer = false; // 두 번째 입장자라면 true
const clientId = sessionStorage.getItem('clientId') || (() => {
  const id = uuid();
  sessionStorage.setItem('clientId', id);
  return id;
})();

// Perfect Negotiation 관련 플래그 (표준 패턴)
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;

// ======== 시그널링 WebSocket 연결 ========
function connectSignaling() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      log('[WS] opened');
      // 방에 참여 요청. 서버는 첫 번째/두 번째에 따라 역할(role) 메시지를 내려줌.
      ws.send(JSON.stringify({ type: 'join', roomId: ROOM_ID, clientId }));
      resolve();
    };

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      const { type } = msg;

      if (type === 'role') {
        // 서버가 내려준 역할: 두 번째 입장자는 offerer:true, polite:true
        polite = !!msg.polite;
        iAmOfferer = !!msg.offerer;
        log(`[role] polite=${polite}, iAmOfferer=${iAmOfferer}`);
        // 역할을 받은 뒤에 PeerConnection을 준비합니다.
        ensurePeerConnection();
        return;
      }

      if (type === 'peer-joined') {
        log('[peer] joined');
        return;
      }

      if (type === 'peer-left') {
        log('[peer] left -> 연결을 정리하고 대기 상태로');
        cleanupPeer();
        // 상대가 나갔으니, 우리는 다시 '첫 번째'처럼 대기: 다음 사람이 들어오면 그가 offerer가 됨
        return;
      }

      if (type === 'description') {
        // 상대의 SDP(offer/answer) 수신
        const desc = msg.description;
        await onRemoteDescription(desc);
        return;
      }

      if (type === 'candidate') {
        // 상대 ICE 후보 수신
        const cand = msg.candidate;
        try {
          await pc?.addIceCandidate(cand || null);
        } catch (e) {
          // description 처리 타이밍 이슈로 실패할 수 있음 -> 무시(Perfect Negotiation 권장)
          log('[ice] addIceCandidate error (ignored)', e?.message || e);
        }
        return;
      }
    };

    ws.onerror = (e) => {
      log('[WS] error', e.message || e);
      reject(e);
    };

    ws.onclose = () => {
      log('[WS] closed');
      // 필요 시 재연결 로직을 넣을 수 있으나, STEP1에서는 페이지 새로고침으로 대체
    };
  });
}

// ======== RTCPeerConnection 생성 및 Perfect Negotiation 기본기 ========
function ensurePeerConnection() {
  if (pc) return; // 이미 있으면 재사용

  // STUN 서버(공용) — 로컬/사내망이면 제거해도 무방하나, 기본값으로 둡니다.
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  // (핵심) onnegotiationneeded: 로컬의 "협상 필요" 이벤트 발생 시,
  // offer를 만들고 setLocalDescription -> 상대에게 SDP 전송
  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      log('[negotiation] need -> createOffer');
      await pc.setLocalDescription(await pc.createOffer());
      sendSignal({ type: 'description', description: pc.localDescription });
    } catch (e) {
      log('[negotiation] error', e?.message || e);
    } finally {
      makingOffer = false;
    }
  };

  // ICE 후보 발견 시 상대에게 전달
  pc.onicecandidate = ({ candidate }) => {
    sendSignal({ type: 'candidate', candidate });
  };

  pc.onconnectionstatechange = () => {
    log('[pc.state]', pc.connectionState);
    // disconnected/failed 시 다음 단계에서 재시도 정책을 더 보강할 수 있습니다.
  };

  // 상대가 만든 DataChannel을 수신(우리는 "첫 번째"일 때 채널을 만들지 않음)
  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    wireDataChannel('inbound(ondatachannel)');
  };

  // 내가 두 번째(offerer)이면, 입장 즉시 DataChannel을 하나 만들어 협상을 유도
  if (iAmOfferer) {
    dc = pc.createDataChannel('chat');
    wireDataChannel('outbound(createDataChannel)');
  }
}

function wireDataChannel(hint) {
  if (!dc) return;

  log(`[dc] wired (${hint})`);
  dc.onopen = () => log('[dc] open');
  dc.onclose = () => log('[dc] close');
  dc.onmessage = (ev) => log('[dc] recv:', ev.data);
}

// 원격 SDP 처리 (Perfect Negotiation 정석 패턴)
async function onRemoteDescription(description) {
  const offerCollision =
    description.type === 'offer' &&
    (
      makingOffer ||
      pc.signalingState !== 'stable'
    );

  ignoreOffer = !polite && offerCollision;
  if (ignoreOffer) {
    // 내가 공손하지 않(polite:false)고, 이미 내 쪽에서도 offer을 만들고 있었다면,
    // 이 offer는 무시하여 글레어를 회피 (표준 패턴)
    log('[pn] ignore remote offer (not polite & collision)');
    return;
  }

  try {
    if (offerCollision) {
      // 공손한 쪽(polite:true)은 rollback으로 상태를 안정화한 뒤 원격 offer를 반영
      log('[pn] rollback due to collision');
      await Promise.all([
        pc.setLocalDescription({ type: 'rollback' }),
        pc.setRemoteDescription(description),
      ]);
    } else {
      await pc.setRemoteDescription(description);
    }

    if (description.type === 'offer') {
      // 원격이 offer를 보냈다면, 우리는 answer 생성/전송
      isSettingRemoteAnswerPending = true;
      await pc.setLocalDescription(await pc.createAnswer());
      sendSignal({ type: 'description', description: pc.localDescription });
    } else {
      // 원격이 answer를 보낸 경우: 로컬에 이미 offer가 있었고, 이제 협상 완료 단계
    }
  } catch (e) {
    log('[pn] onRemoteDescription error', e?.message || e);
  } finally {
    isSettingRemoteAnswerPending = false;
  }
}

// ======== 시그널 전송 헬퍼 ========
function sendSignal(payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ roomId: ROOM_ID, clientId, ...payload }));
  }
}

// ======== 정리(cleanup) ========
function cleanupPeer() {
  try { dc && dc.close(); } catch {}
  try { pc && pc.close(); } catch {}
  dc = null;
  pc = null;
  // 다음 상대를 기다리며 '첫 번째'처럼 대기: 역할은 서버가 새로 지정
}

// ======== UI 이벤트 ========
$sendBtn.onclick = () => {
  if (dc && dc.readyState === 'open') {
    const text = $text.value || '';
    dc.send(text);
    log('[dc] send:', text);
    $text.value = '';
  } else {
    log('[dc] not open yet');
  }
};

// ======== 새로고침/종료 시 서버에 가볍게 알림(선택) ========
window.addEventListener('pagehide', () => {
  try {
    ws?.send(JSON.stringify({ type: 'leave', roomId: ROOM_ID, clientId }));
  } catch {}
});

// ======== 시작 ========
(async function start() {
  log('clientId:', clientId);
  await connectSignaling();
  // 역할(role) 수신 후 ensurePeerConnection()이 호출됩니다.
})();
