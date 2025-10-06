// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import { connect } from '../../../rtc/web_rtc_client.js';
import {scheduleRefresh} from "../../common/refreshScheduler.js"

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
scheduleRefresh();

// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
// const ws = new WebSocket(WS_URL);

connect({
  roomId: 'room-1',
  wsUrl: WS_URL,
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // 예: coturn
      {
        urls: [
          'turn:turn.example.com:3478?transport=udp',
          'turn:turn.example.com:3478?transport=tcp'
        ],
        username: 'turn-user',
        credential: 'turn-pass'
      }
    ],
    iceCandidatePoolSize: 4 // (선택) 초기 후보 수집 가속
  }
});

/* const api = connect({ roomId: "room-1", wsUrl: WS_URL });

// 내 현재 게임 상태를 제공 (예: store에서 꺼내오기)
api.setSyncProvider(() => {
  return {
    scene: window.taptapGameState?.scene ?? "lobby",
    scoreA: window.taptapGameState?.scoreA ?? 0,
    scoreB: window.taptapGameState?.scoreB ?? 0,
    // 필요 구조만 최소로
  }
})

// 상대가 보낸 상태를 반영
api.onRemoteSync((state) => {
  // 예: 내 로컬 상태와 UI를 재그리기
  window.taptapGameState = { ...window.taptapGameState, ...state }
  // reDrawPlaying(state) 같은 함수 호출 등
})
 */
