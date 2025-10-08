import "../../../scss/common.scss";
// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import {scheduleRefresh} from "../../common/refreshScheduler.js"

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
scheduleRefresh();

// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
// const ws = new WebSocket(WS_URL);

// 목표:
// 1) 같은 ICE 후보를 중복 전송/적용하지 않음(네트워크/WS 재연결 시 중복 방지)
// 2) ICE 수집 완료 신호(EOC)를 교환하여, 후보 전송이 끝났다는 사실을 서로 명확히 인지
//
// 유지 사항:
// - STEP 2: Perfect Negotiation (polite/impolite + glare 방지)
// - STEP 3: 끊김 감지 + soft reset
// - STEP 4: WS 자동 재연결 + 자동 재가입
//
// 서버는 오직 "라우팅"만 담당합니다.

const roomId = new URL(location.href).searchParams.get('room') || 'demo';

let ws = null;

// [NEW] WS 지수 백오프 파라미터
let wsReconnectAttempts = 0;
const WS_BACKOFF_BASE = 200;   // 시작 지연(ms)
const WS_BACKOFF_MAX = 5000;   // 최대 지연(ms)
let wsReconnectTimer = null;

// [NEW] WS 열리기 전에 보내야 하는 메시지 임시 큐
const wsQueue = [];

// 브라우저 간 P2P 연결 객체
let pc = null;
// 상대에게 보낼 DataChannel(offer 쪽에서 생성)
let dc = null;
// 내 peerId / 상대 peerId
let myId = null;
let remoteId = null;

// [NEW] Perfect Negotiation 상태 변수들
let polite = false;                // 나는 정중한가?(=충돌 시 수락/rollback)
let makingOffer = false;           // 지금 내가 offer 생성 중인가?
let ignoreOffer = false;           // 이번 들어온 offer를 무시해야 하나?
let pendingCandidates = [];      // remoteDescription 전까지 받은 ICE 후보 보관

// [NEW] 끊김 감시 타이머(일시 끊김과 완전 실패 구분)
let disconnectTimer = null;
const DISCONNECT_GRACE_MS = 1500; // 'disconnected'가 잠깐 뜰 수 있어 약간 기다렸다 복구

// [NEW] ICE 중복 억제 & EOC 상태
let sentLocalCandidates = new Set();       // 내가 이미 '보낸' 후보 키 집합
let receivedRemoteCandidates = new Set();  // 내가 이미 '적용'한 원격 후보 키 집합
let sentEOC = false;                       // 로컬 EOC(수집 완료) 알림을 이미 보냈는지
let gotRemoteEOC = false;                  // 상대 쪽에서 EOC를 받았는지

// 가급적 무료 STUN(테스트용). 실제 서비스에서는 TURN도 구성 권장.
const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

/* -------------------------------------------
 * [NEW] WS 연결/재연결 유틸
 * -----------------------------------------*/
/** JSON 안전 송신 (열리기 전이면 큐에 적재) */
function sendWS(msg) {
  const payload = JSON.stringify(msg);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(payload);
  } else {
    wsQueue.push(payload); // 열리면 한꺼번에 전송
  }
}

// [NEW] ICE 후보를 "문자열 키"로 표준화하여 중복 판단
// - candidate 문자열 자체 + sdpMid + sdpMLineIndex를 묶어 유일키로 사용
function iceKey(c) {
  // 일부 브라우저는 sdpMid/sdpMLineIndex 중 하나가 undefined일 수 있으니 안전 처리
  const mid = c.sdpMid ?? '';
  const midx = c.sdpMLineIndex ?? '';
  const cand = c.candidate ?? '';
  return `${cand}|${mid}|${midx}`;
}

/** WS 연결 시도 */
function connectWS() {
  // 혹시 이전 타이머 있으면 정리
  clearTimeout(wsReconnectTimer);

  try { if (ws) ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null; } catch {}
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[ws] open');
    // 성공 → 백오프 리셋
    wsReconnectAttempts = 0;

    // [NEW] 재가입: 항상 현재 room으로 join
    sendWS({ type: 'join', roomId });

    // [NEW] 열리기 전에 쌓였던 메시지 비우기 (순서 보존)
    while (wsQueue.length) {
      const p = wsQueue.shift();
      try { ws.send(p); } catch {}
    }
  };

  ws.onmessage = (ev) => {
    // 메시지 핸들러를 함수로 분리해 재사용
    const msg = JSON.parse(ev.data);
    handleWSMessage(msg);
  };

  ws.onerror = (e) => {
    console.warn('[ws] error', e);
    // 에러 발생 시 close로 이어질 수 있음
  };

  ws.onclose = () => {
    console.warn('[ws] close');
    // [NEW] 지수 백오프 재연결 스케줄
    const delay = Math.min(WS_BACKOFF_BASE * (2 ** wsReconnectAttempts), WS_BACKOFF_MAX);
    wsReconnectAttempts++;
    wsReconnectTimer = setTimeout(connectWS, delay);
  };
}

/** --------------------
 * RTCPeerConnection 준비/리셋
 * --------------------
 */
// [NEW] 안전 종료
function safeClosePeer() {
  try { if (dc) { dc.onopen = dc.onmessage = dc.onclose = null; dc.close(); } } catch {}
  try { if (pc) { pc.onicecandidate = pc.ondatachannel = pc.onconnectionstatechange = pc.onnegotiationneeded = null; pc.close(); } } catch {}
  dc = null;
  pc = null;
  // 후보 큐도 초기화 (이전 세션 잔재 제거)
  pendingCandidates = [];
  // makingOffer/ignoreOffer는 "세션" 변수이므로 리셋
  makingOffer = false;
  ignoreOffer = false;
}

/** 재가입 직후 "항상" 깨끗한 상태에서 시작 */
// [NEW] 재초기화(깨끗한 PC를 만들고 기다림)
// - 역할(polite)은 유지
// - remoteId는 유지하지 않습니다. 상대가 재입장하면 새 from으로 자연 갱신됩니다.
function resetPeerConnection(reason = '') {
  console.log('[reset] resetPeerConnection:', reason);
  safeClosePeer();
  preparePeerConnection();
}

// RTCPeerConnection 공통 준비
function preparePeerConnection() {
  pc = new RTCPeerConnection(rtcConfig);

  // [NEW] 표준 Perfect Negotiation 핸들러
  pc.onnegotiationneeded = async () => {
    // 이 콜백은 "협상이 필요할 때" 브라우저가 호출합니다.
    // - 예: caller가 DataChannel을 만들면 여기로 들어옵니다.
    try {
      makingOffer = true;

      // remoteId가 아직 없다면(상대가 누군지 모를 때) 협상하지 않습니다.
      // - 보통 caller는 'start-offer'에서 remoteId가 먼저 설정된 뒤 DataChannel을 만들어 들어옵니다.
      if (!remoteId) {
        console.log('[negotiation] skipped: no remoteId yet');
        return;
      }

      // setLocalDescription()에 인자 없이 호출하면
      // 브라우저가 알아서 적절한 offer를 만들어 LocalDescription에 채웁니다.
      await pc.setLocalDescription();
      // 만들어진 localDescription(=offer)을 상대에게 전송
      sendWS({
        type: 'signal',
        roomId,
        to: remoteId,
        payload: { kind: 'sdp', desc: pc.localDescription }
      });
    } catch (err) {
      console.warn('[negotiation] failed:', err);
    } finally {
      makingOffer = false;
    }
  };

  // 내 ICE 후보가 생길 때마다 상대에게 전달
  // [NEW] ICE 후보 전송(중복 억제) + EOC 전송
  pc.onicecandidate = (e) => {
    if (e.candidate && remoteId) {
      // 후보 키 생성 후, 이미 보냈던 후보라면 무시
      const key = iceKey(e.candidate);
      if (sentLocalCandidates.has(key)) {
        return; // 중복 전송 방지
      }
      sentLocalCandidates.add(key);

      sendWS({
        type: 'signal',
        roomId,
        to: remoteId,
        payload: { kind: 'ice', candidate: e.candidate },
      });
    }

    // candidate === null 이면 로컬 ICE 수집 완료(EOC)
    if (!e.candidate && remoteId && !sentEOC) {
      sentEOC = true; // 한 번만 보냄
      sendWS({
        type: 'signal',
        roomId,
        to: remoteId,
        payload: { kind: 'eoc' }, // end-of-candidates 통지
      });
    }
  };

  // 얼음 수집 상태 로그
  pc.onicegatheringstatechange = () => {
    console.log("[pc.iceGatheringState]", pc.iceGatheringState);
  }

  // 상대가 먼저 DataChannel을 만들었을 때(= 나는 answerer일 때)
  pc.ondatachannel = (e) => {
    // 채널 수신
    dc = e.channel;
    wireDataChannel(dc);
  };

  // 연결 상태 확인용 로그(디버깅)
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log('[pc.state]', s);

    // [NEW] 일시 끊김: 잠깐 기다렸다가 여전히 회복이 안 되면 리셋
    if (s === 'disconnected') {
      clearTimeout(disconnectTimer);
      disconnectTimer = setTimeout(() => {
        if (pc && pc.connectionState === 'disconnected') {
          resetPeerConnection('disconnected_timeout');
        }
      }, DISCONNECT_GRACE_MS);
    } else {
      // 'connected' 등으로 회복되면 타이머 취소
      clearTimeout(disconnectTimer);
    }

    // [NEW] 완전 실패: 즉시 리셋
    if (s === 'failed' || s === 'closed') {
      resetPeerConnection('state_failed_or_closed');
    }
  };
}

// 공통 DataChannel 이벤트 바인딩
function wireDataChannel(channel) {
  channel.onopen = () => {
    console.log('[dc] open');
    // 간단한 핑 메시지 (연결 확인)
    channel.send('hello from ' + myId);
  };
  channel.onmessage = (e) => {
    console.log('[dc] message:', e.data);
  };
  channel.onclose = () => console.log('[dc] close');
}

// [NEW] caller(두 번째 입장자)만 호출: "DataChannel 생성만" 수행
// 실제 offer 생성/송신은 onnegotiationneeded가 대신 처리합니다.
// caller(두 번째 입장자)만 호출: DataChannel 생성 → onnegotiationneeded 유발
function createCallerDataChannel() {
  // 중복 생성을 피하기 위해 이미 열려 있으면 스킵
  if (dc && (dc.readyState === 'open' || dc.readyState === 'connecting')) {
    console.log('[dc] already exists, skip create');
    return;
  }
  dc = pc.createDataChannel('game');
  wireDataChannel(dc);
}

/* -------------------------------------------
 * WS 메시지 처리 (재사용 가능 형태로 분리)
 * -----------------------------------------*/
async function handleWSMessage(msg) {
  switch (msg.type) {
    case 'joined': {
      // 내가 방에 들어옴
      myId = msg.peerId;
      // [NEW] polite 규칙: 1번째(waiter)=polite=true, 2번째(caller)=polite=false
      polite = (msg.role === 'waiter');
      console.log(`[ws] joined room=${msg.roomId} as ${myId}, role=${msg.role}, polite=${polite}`);

      // 재가입/최초가입과 무관하게 항상 깨끗한 상태로 시작
      // - remoteId 비워두면 이후 'start-offer' 또는 상대의 'signal'에서 갱신
      remoteId = null;
      resetPeerConnection("ws_joined"); // 내부에서 preparePeerConnection() 호출
      break;
    }

    case 'peer-joined': {
      // 디버깅용(상대 입장 알림)
      console.log('[ws] peer-joined:', msg.peerId);
      break;
    }

    case 'start-offer': {
      // 서버가 "네가 두 번째(caller)니까 시작해"라고 지시.
      // [변경] 예전엔 직접 offer를 만들었지만,
      //        이제는 DataChannel만 만들고 나머지는 onnegotiationneeded에 맡깁니다.
      remoteId = msg.targetPeerId;
      console.log('[ws] start-offer to', remoteId);
      createCallerDataChannel();
      break;
    }

    case 'signal': {
      const { from, payload } = msg;

      // [NEW] 재접속 대비:
      // 상대가 새 peerId로 재입장하면 from이 달라집니다.
      // 이미 remoteId가 있는데 달라졌다면 "새 상대"로 갱신합니다.
      if (!remoteId || remoteId !== from) {
        console.log(`[ws] remoteId update: ${remoteId} -> ${from}`);
        remoteId = from;
      }

      if (payload.kind === 'sdp') {
        const desc = payload.desc;

        // [NEW] glare(충돌) 판정:
        // - 내가 offer를 만드는 중(makingOffer) 이거나
        // - 내 signalingState가 'stable'이 아니라면 (이미 협상 중)
        //   → 들어온 'offer'는 충돌 상황으로 봅니다.
        const offerCollision =
          desc.type === 'offer' &&
          (makingOffer || pc.signalingState !== 'stable');

        // impolite(=caller)는 충돌 시 무시, polite(=waiter)는 수락 쪽으로 처리
        ignoreOffer = !polite && offerCollision;
        if (ignoreOffer) {
          console.log('[perfect-negotiation] ignore remote offer (impolite + collision)');
          return;
        }

        try {
          if (desc.type === "offer") {
            // 내 상태가 안정적이지 않다면(이미 local offer 보유 등) 먼저 롤백
            if (pc.signalingState !== 'stable') {
              console.log('[perfect-negotiation] rollback before accepting offer');
              await pc.setLocalDescription({ type: 'rollback' });
            }
            await pc.setRemoteDescription(desc);            // 원격 offer 수락
            const answer = await pc.createAnswer();         // answer 생성
            await pc.setLocalDescription(answer);           // 내 로컬에 설정
            sendWS({                                        // answer 전송
              type: 'signal',
              roomId,
              to: remoteId,
              payload: { kind: 'sdp', desc: pc.localDescription },
            });

            // [NEW] 대기해둔 ICE 후보(상대 설명 수락 이후 적용)
            while (pendingCandidates.length) {
              const c = pendingCandidates.shift();
              try { await pc.addIceCandidate(c); } catch (e) { console.warn('addIceCandidate (deferred) failed:', e); }
            }

            // [NEW] EOC를 먼저 받았던 경우, remoteDescription 설정 후에 null 후보로 마무리
            if (gotRemoteEOC) {
              try { await pc.addIceCandidate(null); } catch {}
              gotRemoteEOC = false;
            }
          } else {
            // desc.type === 'answer'
            await pc.setRemoteDescription(desc);            // 내 offer에 대한 answer 수신
            // answer 수락 후에도 대기 후보가 있다면 반영(안전)
            while (pendingCandidates.length) {
              const c = pendingCandidates.shift();
              try { await pc.addIceCandidate(c); } catch (e) { console.warn('addIceCandidate (deferred) failed:', e); }
            }

            // 상대가 EOC를 먼저 보냈다면 여기서 마무리
            if (gotRemoteEOC) {
              try { await pc.addIceCandidate(null); } catch {};
              gotRemoteEOC = false;
            }
          }
        } catch (err) {
          console.warn('[perfect-negotiation] sdp handling failed:', err);
          // [NEW] SDP 처리 중 오류가 반복될 경우 세션 꼬임 방지용으로 리셋
          resetPeerConnection('sdp_error');
        }
      } else if (payload.kind === 'ice') {
        // [NEW] 수신 후보 중복 억제
        const key = iceKey(payload.candidate);
        if (receivedRemoteCandidates.has(key)) {
          // 이미 적용한 후보면 무시
          return;
        }
        receivedRemoteCandidates.add(key);

        // remoteDescription이 아직 없으면 보류 큐에 넣고,
        // 수락 이후에 순차 적용합니다
        if (pc.remoteDescription) {
          try { await pc.addIceCandidate(payload.candidate); }
          catch (e) { console.warn('addIceCandidate failed:', e); }
        } else {
          pendingCandidates.push(payload.candidate);
        }
      } else if(payload.kind === "eoc") {
        // 상대가 EOC를 보냈음 -> remoteDescription 설정 후 null 후보로 마무리
        if (pc.remoteDescription) {
          try { await pc.addIceCandidate(null); } catch {}
        } else {
          // 아직 원격 설명이 없다면, 표시만 해두었다가 나중에 처리
          gotRemoteEOC = true;
        }
      }

      break;
    }

    case 'peer-left': {
      console.log('[ws] peer-left:', msg.peerId);
      // 여기서는 과도한 정리 없이 "로그만".
      // 이유: 재입장 시 새 from(peerId)로 signal이 오면 위에서 remoteId 갱신 후 그대로 협상 진행 가능.
      // (필요하면 다음 단계에서 보다 적극적인 reset 로직을 추가하겠습니다.)
      if (remoteId === msg.peerId) {
        // 상대가 나갔다면, 다음 재입장을 위해 일단 끊긴 상대 표시만 해둡니다.
        remoteId = null;
      }
      resetPeerConnection('peer_left');
      break;
    }
  }
}

/* -------------------------------------------
 * 부팅: WS 연결 시작
 * -----------------------------------------*/
connectWS();
