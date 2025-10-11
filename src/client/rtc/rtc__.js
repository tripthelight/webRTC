let pc = null;
let dc = null;

// signaling 송신 함수
let sendSignal = null;

// perfect negotiation용 상태
let isPolite = false; // 내 역할
let remoteId = null; // 상대 id(처음 받은 메시지에서 확정)
let isSettingRemoteAnswerPending = false;
let localId = null; // ★ 이번 단계: 내 id 주입용
// --- Heartbeat 상태 ---
let hbTimer = null;
let hbWatchdog = null;
let lastPongAt = 0;
const HEARTBEAT_INTERVAL_MS = 5000; // 5초마다 ping
const HEARTBEAT_TIMEOUT_MS  = 12000; // 12초 내 pong 없으면 ICE 재시작

const $ = (sel) => document.querySelector(sel);
const log = (msg) => {
  const el = $('#log');
  el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  el.scrollTop = el.scrollHeight;
};

export function setSignaling(sendFn) {
  sendSignal = sendFn;
}

// ★ 내 id를 주입 받아서, 상대 id를 처음 볼 때 역할을 '명확하게' 결정
export function setLocalId(id) {
  localId = String(id);
}

// 브라우저 기본 STUN 만으로는 외부 네트워크에서 안 잡힐 수 있어, 공개 STUN 1개 추가
function makePeer() {
  return new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
}

export function createPeer() {
  if (pc) return pc;

  // 브라우저 기본 STUN 서버만 사용(아직 ICE 서버 지정 안 함)
  pc = makePeer();

  // Perfect Negotiation에서 자주 쓰는 보조 플래그들 (지금은 '보기만')
  pc._makingOffer = false;
  pc._ignoreOffer = false;

  pc.onnegotiationneeded = async () => {
    log('[rtc] onnegotiationneeded → (이번 단계) 내가 offer를 만듭니다');
    if (!sendSignal) {
      log('[rtc] sendSignal 미설정: ws 연결 먼저 해주세요');
      return;
    }
    try {
      pc._makingOffer = true;
      // stable일 때만 제안 시도(충돌 예방)
      if (pc.signalingState !== 'stable') {
        log('[rtc] signalingState!=stable → offer 생략');
        return;
      }
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Trickling: 후속 ICE는 onicecandidate에서 따로 보냄
      sendSignal({ kind: 'sdp', description: pc.localDescription });
      log('[rtc] offer 보냄');
    } catch (err) {
      log(`[rtc] offer 실패: ${err.message ?? err}`);
    } finally {
      pc._makingOffer = false;
    }
  };

  // 상대가 보낸 dataChannel을 수락할 때 발생
  pc.ondatachannel = (ev) => {
    dc = ev.channel;
    log('[rtc] ondatachannel (상대가 연 채널 수신)');
    wireDataChannel(dc);
  };

  // ICE 상태 변화 관찰만 (네트워크 감을 익히기 위함)
  pc.oniceconnectionstatechange = () => {
    log(`[rtc] iceConnectionState=${pc.iceConnectionState}`);
  };

  pc.onconnectionstatechange = () => {
    log(`[rtc] connectionState=${pc.connectionState}`);
  };

  // ★ ICE 후보 나올 때마다 신호로 전송
  pc.onicecandidate = (ev) => {
    if (ev.candidate && sendSignal) {
      sendSignal({ kind: 'ice', candidate: ev.candidate });
    }
  };

  return pc;
}

// 내가 먼저 여는 dataChannel (버튼 클릭 시 한 번만 생성)
export function openMyDataChannel() {
  if (!pc) createPeer();
  if (dc && dc.readyState !== 'closed') {
    log('[rtc] dataChannel already exists');
    return dc;
  }
  dc = pc.createDataChannel('chat');
  log('[rtc] createDataChannel("chat") 호출됨 → 곧 onnegotiationneeded');
  wireDataChannel(dc);
  return dc;
}

function wireDataChannel(channel) {
  channel.onopen = () => {
    log('[rtc] dataChannel open');
    startHeartbeat();
  };
  channel.onclose = () => {
    log('[rtc] dataChannel close');
    stopHeartbeat();
  };
  channel.onmessage = (ev) => {
    const msg = String(ev.data ?? '');
    // ping/pong 프로토콜 (아주 단순)
    if (msg.startsWith('ping:')) {
      // 상대가 보낸 ping → 즉시 pong으로 응답
      channel.readyState === 'open' && channel.send(`pong:${msg.slice(5)}`);
      return;
    }
    if (msg.startsWith('pong:')) {
      lastPongAt = Date.now();
      return;
    }
    log(`[rtc] dataChannel message: ${msg}`);
  };
}

// --- Heartbeat 유틸 ---
function startHeartbeat() {
  stopHeartbeat(); // 중복 방지
  lastPongAt = Date.now();
  // 5초마다 ping
  hbTimer = setInterval(() => {
    if (!dc || dc.readyState !== 'open') return;
    const ts = Date.now();
    dc.send(`ping:${ts}`);
  }, HEARTBEAT_INTERVAL_MS);
  // pong 감시
  hbWatchdog = setInterval(async () => {
    const since = Date.now() - lastPongAt;
    if (since > HEARTBEAT_TIMEOUT_MS) {
      log(`[rtc] heartbeat 타임아웃(${since}ms) → ICE 재시작 시도`);
      lastPongAt = Date.now(); // 중복 연속 트리거 방지
      await safeIceRestart();
    }
  }, Math.min(HEARTBEAT_INTERVAL_MS, 2000)); // 2~5초 간격으로 점검
}

function stopHeartbeat() {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  if (hbWatchdog) { clearInterval(hbWatchdog); hbWatchdog = null; }
}

// --- 안전한 ICE 재시작(Perfect Negotiation 규칙과 호환) ---
async function safeIceRestart() {
  try {
    if (!sendSignal || !pc) return;
    if (pc.signalingState !== 'stable') {
      log('[rtc] signalingState!=stable → ICE 재시작 보류');
      return;
    }
    pc._makingOffer = true;
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    sendSignal({ kind: 'sdp', description: pc.localDescription });
    log('[rtc] ICE restart offer 보냄');
  } catch (err) {
    log(`[rtc] ICE 재시작 실패: ${err.message ?? err}`);
  } finally {
    pc._makingOffer = false;
  }
}

// ----- Perfect Negotiation 핵심 처리 -----
export async function onSignalMessage(msg) {
  if (!pc) createPeer();

  // 상대 id를 처음 본 순간 역할 확정: "id 큰 쪽이 polite"
  if (!remoteId && msg.from) {
    remoteId = msg.from;
    // ★ 이제는 양쪽이 동일 규칙으로 결정: "문자열 비교로 더 큰 쪽이 polite"
    //    (양측 모두 동일한 setLocalId 호출로 일관성 확보)
    if (localId) {
      // 문자열 비교: 예) 'a3f' > '9bc' 는 true (사전식 비교)
      isPolite = String(localId) > String(remoteId);
    } else {
      // 혹시라도 주입이 늦었다면, 이전 단계와 동일하게 보수적 시작
      isPolite = false;
    }
    log(`[rtc] localId=${localId}, remoteId=${remoteId}, isPolite=${isPolite}`);
  }

  if (msg.kind === 'sdp') {
    const desc = msg.description;
    try {
      const readyForOffer = !pc._makingOffer && (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);
      const offerCollision = desc.type === 'offer' && !readyForOffer;

      // 충돌이면: impolite는 무시, polite는 rollback 후 수용
      pc._ignoreOffer = !isPolite && offerCollision;

      if (pc._ignoreOffer) {
        log('[rtc] (impolite) 충돌 offer 무시');
        return;
      }

      if (offerCollision && isPolite) {
        log('[rtc] (polite) 충돌 발생 → rollback 후 상대 offer 수락');
        await pc.setLocalDescription({ type: 'rollback' });
      }

      isSettingRemoteAnswerPending = desc.type === 'answer';
      await pc.setRemoteDescription(desc);
      isSettingRemoteAnswerPending = false;

      if (desc.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal && sendSignal({ kind: 'sdp', description: pc.localDescription });
        log('[rtc] (polite/impolite 공통) offer 수락 -> answer 보냄');
      } else if (desc.type === 'answer') {
        log('[rtc] answer 수신 처리 완료');
      }
    } catch (err) {
      log(`[rtc] sdp 처리 실패: ${err.message ?? err}`);
    }
    return;
  }

  if (msg.kind === 'ice' && msg.candidate) {
    try {
      await pc.addIceCandidate(msg.candidate);
      // 일부 브라우저는 연결 중간에도 후보가 계속 들어옵니다.
    } catch (err) {
      // 연결이 아직 준비 전이면 addIceCandidate 실패할 수 있음 (무해)
      log(`[rtc] addIceCandidate 경고: ${err.message ?? err}`);
    }
    return;
  }
}
