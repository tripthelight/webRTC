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

// STEP 1: 역할 정하기 + 최소 시그널링 + Perfect Negotiation 스캐폴딩
// - 첫 입장자: polite: true (대기자)
// - 두 번째: polite:false (입장자, 최초 offer 생성 담당)
// - 아직은 "재연결" 로직을 넣지 않습니다. 오늘은 구조/역할/흐름만 정확히

// === 0) 환경 준비: WebSocket 연결 ===

function send(msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    ws.addEventListener('open', () => ws.send(JSON.stringify(msg)), { once: true });
  }
}

// === 1) RTCPeerConnection 준비 ===
// - 향후 glare(동시 협상) 대비용 플래그들(Perfect Negotiation 핵심 변수)만 미리 잡아둡니다.
// - 오늘은 "자리만" 잡아두고, 실제 충돌 처리/재연결은 다음 단계에서 점진 추가.
let pc;
let polite = null;                 // 서버가 정해주는 내 역할 (true=polite, false=impolite)
let makingOffer = false;           // 지금 내가 offer를 만들고 있는 중인지
let ignoreOffer = false;           // 상대가 보낸 offer를 일시적으로 무시해야 하는지
let isSettingRemoteAnswerPending = false; // answer 적용 대기 중인지

// 데이터채널(게임용) 예시: 오늘은 채널만 만들고, 이벤트만 연결해 둠
let dc;

// 유틸: 로깅
const log = (...args) => console.log('[client]', ...args);

// === 2) onnegotiationneeded 핸들러 (offer를 만드는 표준 타이밍) ===
// - 오늘은 "두 번째 입장자만" 최초 offer를 만들도록 gate를 둡니다.
// - 추후 재협상(새로고침 복구 등)은 STEP 2에서 여기에 자연스럽게 얹습니다.
async function onNegotiationNeeded() {
  try {
    makingOffer = true;
    // gate: 최초에는 "입장자(impolite=false)가 먼저 offer"만 허용
    // (양쪽 다 새로고침 난타 등은 다음 단계에서 해결)
    if (polite === false) {
      log('onnegotiationneeded: I am impolite(=caller), creating offer...');
      await pc.setLocalDescription(await pc.createOffer());
      send({ type: 'signal', data: { sdp: pc.localDescription } });
    } else {
      // polite=true(대기자)는 최초엔 offer를 만들지 않음
      log('onnegotiationneeded: I am polite(=callee). Skip initial offer.');
    }
  } catch (err) {
    console.error(err);
  } finally {
    makingOffer = false;
  }
}

// === 3) 원격 sdp/candidate 처리 ===
// - 상대가 보낸 sdp 또는 ICE를 pc에 적용
// - glare/rollback은 다음 단계에서 안전장치 추가
async function handleSignal({ sdp, candidate }) {
  try {
    if (sdp) {
      log("rx sdp", sdp.type);

      // offer/answer 에 따라 분기
      const desc = sdp;
      const readyForOffer =
        !makingOffer && (pc.signalingState === "stable" || isSettingRemoteAnswerPending);
      const offerCollision = desc.type === "offer" && !readyForOffer;

      // STEP 1에서는 glare 최소화만: polite=false(입장자)가 offer를 먼저 보낼테니
      // 대기자(polite=true)는 여기서 answer만 생성하는 경로로 갑니다.
    }
  } catch (err) {

  }
}
