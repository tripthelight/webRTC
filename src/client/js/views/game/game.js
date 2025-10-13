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

// ———————————————————————————————————————————————————

/**
 * STEP 1 클라이언트
 * - 페이지 로드 즉시 WebSocket 연결 (버튼 없음)
 * - 서버가 배정한 roomId / peerId / role 을 수신
 * - 방이 두 명으로 "ready" 되면, 콘솔/화면에 상태 로그만 출력
 * - 아직 RTCPeerConnection은 만들지 않음 (다음 단계에서 추가)
 */

const logEl = document.getElementById('log');
const log = (...args) => {
  console.log(...args);
  logEl.textContent += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
};

// 배포 환경에 맞춰 주소 수정하세요.
const SIGNAL_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;

let ws;
let roomId = null;
let peerId = null;
let role = null;

function connect() {
  ws = new WebSocket(SIGNAL_URL);

  ws.addEventListener('open', () => {
    log('[ws] connected');
    // STEP1에서는 서버가 접속 즉시 방을 배정하므로, 여기서 보낼 것은 없음
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'joined') {
      roomId = msg.roomId;
      peerId = msg.peerId;
      role = msg.role;
      log('[joined]', { roomId, peerId, role });
      if (role === 'impolite') {
        log('→ 나는 먼저 들어온 impolite 역할입니다. (다음 단계에서 glare 시 롤백하지 않음)');
      } else {
        log('→ 나는 나중에 들어온 polite 역할입니다. (다음 단계에서 glare 시 롤백 담당)');
      }
    }

    if (msg.type === 'ready') {
      log('[ready] 두 명 매칭 완료. 상대 peerId =', msg.peerId);
      // 다음 단계에서 이 타이밍에 RTCPeerConnection을 만들고
      // Perfect Negotiation 골격을 붙일 예정입니다.
    }

    if (msg.type === 'peer-left') {
      log('[peer-left] 상대가 떠났습니다. 새 입장을 기다리거나, 다음 단계에서 재연결 로직을 붙입니다.');
    }

    // 이후 단계에서 사용할 relay 메시지 예: {type:'signal', sdp/candidate...}
    if (msg.type === 'signal') {
      log('[relay] 수신:', msg);
    }
  });

  ws.addEventListener('close', () => {
    log('[ws] closed');
    // 새로고침 난타 상황에서도 서버 부하를 줄이기 위해,
    // 즉시 무한 재연결은 지양 (지수 백오프는 다음 단계에서 다룸).
  });

  ws.addEventListener('error', () => {
    log('[ws] error');
  });
}

connect();
