// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
// const ws = new WebSocket(WS_URL);

// ------------------------------------------------------------
// 이 파일은 "한 방(room)에 2명"만 들어와 데이터채널로 텍스트를 주고받는
// 최소 뼈대를 제공합니다.
// - Perfect Negotiation 패턴의 핵심 변수들(makingOffer, ignoreOffer, polite)을 포함
// - 두 번째 입장자가 dataChannel을 만들어 offer를 촉발
// - 충돌(동시에 offer 만드는 상황) 방지 로직을 간단/안전하게 구현
// ------------------------------------------------------------

// ------------------------------------------------------------
// 변경 요약:
// - isSettingRemoteAnswerPending 도입 (MDN Perfect Negotiation 패턴 보강)  // [NEW]
// - impolite 쪽의 createDataChannel 시 아주 짧은 랜덤 지연 50~150ms         // [NEW]
// - onnegotiationneeded 가드: 원격 Answer 세팅 중이면 내 오퍼 생성 금지     // [NEW]
// - 나머지는 서버 비용을 늘리지 않는 범위에서만 수정
// ------------------------------------------------------------



// 일반 공개 STUN 서버(구글). 실제 서비스에선 TURN도 필요할 수 있습니다.
const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export async function joinRoom(roomId, {
  onConnected = () => {},
  onMessage = (text) => { console.log('[DC message]', text); },
  onLog = (msg) => { console.log('[RTC]', msg); },
} = {}) {

  // 1) 시그널링(WebSocket) 연결
  const ws = new WebSocket(WS_URL);

  // WebRTC 상태 보관 변수들
  let pc;                    // RTCPeerConnection
  let dc;                    // DataChannel
  let polite = true;         // 서버가 'role'로 내려줍니다. (첫 입장자: true, 두 번째: false)
  let makingOffer = false;   // 내가 지금 offer를 "만드는 중"인가?
  let ignoreOffer = false;   // (impolite일 때) 충돌 상황이면 상대 offer를 "무시"할지?
  let isSettingRemoteAnswerPending = false; // 원격 Answer를 setRemoteDescription 중?
  const pendingCandidates = [];// remoteDescription 전에 온 candidate를 잠시 보관

  // 유틸: 안전하게 addIceCandidate (remote가 아직 없으면 큐에 적재)
  async function safeAddIceCandidate(candidate) {
    try {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(candidate);
      } else {
        pendingCandidates.push(candidate);
      }
    } catch (err) {
      onLog('addIceCandidate error: ' + err?.message);
    }
  }

  function flushPendingCandidates() {
    if (!pc.remoteDescription) return;
    while (pendingCandidates.length) {
      const c = pendingCandidates.shift();
      pc.addIceCandidate(c).catch(err => onLog('flush candidate error: ' + err?.message));
    }
  }

  // 2) RTCPeerConnection 생성 + 이벤트 바인딩
  function makePeer(createDataChannelFirst = false) {
    pc = new RTCPeerConnection(RTC_CONFIG);

    // (필수) Perfect Negotiation 핵심 핸들러: onnegotiationneeded
    pc.onnegotiationneeded = async () => {
      // [NEW] 원격 Answer를 적용 중이면 내 오퍼 생성 금지 → glare 확률↓
      if (isSettingRemoteAnswerPending) {
        onLog('skip onnegotiationneeded (remote answer pending)'); // [NEW]
        return;
      }

      // 이 이벤트는 "내가 새로운 협상(offer)이 필요"할 때 자동 발생합니다.
      // ex) 내가 먼저 dataChannel을 만들면, 여기로 들어오게 됩니다.
      try {
        onLog('onnegotiationneeded');
        makingOffer = true;

        // 나의 현 상태를 로컬SDP로 만들고
        await pc.setLocalDescription(await pc.createOffer());
        // 시그널 서버를 통해 상대에게 전달
        ws.send(JSON.stringify({ type: 'description', description: pc.localDescription }));
      } catch (err) {
        onLog('onnegotiationneeded error: ' + err?.message);
      } finally {
        makingOffer = false;
      }
    };

    // ICE 후보가 생길 때마다 서버로 전달
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        ws.send(JSON.stringify({ type: 'candidate', candidate: ev.candidate }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      onLog('iceConnectionState: ' + pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected') {
        onConnected();
      }
    };

    // 상대가 만든 DataChannel을 내가 "수신"하는 경우
    pc.ondatachannel = (ev) => {
      dc = ev.channel;
      wireDataChannel(dc);
      onLog('ondatachannel (recipient)');
    };

    // 이 사람이 "offer 유발자"라면, 먼저 채널을 하나 만들어 협상을 촉발합니다.
    if (createDataChannelFirst) {
      // [NEW] 아주 짧은 랜덤 지연으로 동시 새로고침 glare/서버부하를 자연스럽게 낮춤
      const jitterMs = 50 + Math.floor(Math.random() * 100); // 50~150ms
      setTimeout(() => {
        dc = pc.createDataChannel('chat');
        wireDataChannel(dc);
        onLog(`createDataChannel (initiator) after ${jitterMs}ms jitter`);
      }, jitterMs); // [NEW]
    }
  }

  // DataChannel에 메시지 핸들러 연결
  function wireDataChannel(channel) {
    channel.onopen = () => onLog('[DC] open');
    channel.onclose = () => onLog('[DC] close');
    channel.onmessage = (ev) => onMessage(String(ev.data));
  }

  // 외부에서 쓸 수 있도록 간단 전송 API도 같이 내보냅니다.
  function send(text) {
    if (dc && dc.readyState === 'open') {
      dc.send(text);
    } else {
      onLog('DataChannel not open');
    }
  }

  // 3) 시그널링(WebSocket) 메시지 수신 처리
  ws.onopen = () => {
    // 방 참가
    ws.send(JSON.stringify({ type: 'join', room: roomId }));
  };

  ws.onmessage = async (ev) => {
    let msg = {};
    try { msg = JSON.parse(ev.data); } catch { return; }

    // (A) 서버가 내려주는 "역할" 통지
    if (msg.type === 'role') {
      polite = !!msg.polite;
      // 두 번째 입장자는 createDataChannel=true => 먼저 DataChannel을 만들어 offer를 유발
      makePeer(!!msg.createDataChannel);
      return;
    }

    // (B) 상대의 SDP(offer/answer) 수신
    if (msg.type === 'description' && msg.description) {
      const desc = msg.description;

      const readyForOffer = pc.signalingState === 'stable' || (pc.signalingState === 'have-local-offer' && !makingOffer);
      const offerCollision = desc.type === 'offer' && (makingOffer || pc.signalingState !== "stable");

      // 충돌 처리 규칙:
      // - impolite(false): 충돌이면 "상대 offer 무시"
      // - polite(true): 충돌이면 "내 것 롤백" 후 상대 offer 수용
      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) {
        // 무시(impolite 쪽이 이미 오퍼 만드는 중이라면, 내 오퍼를 계속 진행)
        onLog('offer ignored (impolite & collision)');
        return;
      }

      try {
        if (offerCollision) {
          // polite인 경우: 내 로컬 오퍼를 롤백하여 충돌을 해소
          await pc.setLocalDescription({ type: 'rollback' });
        }

        if (desc.type === "answer") {
          // 원격 answer를 세팅할 동안은 onnegotiationneeded를 막고 싶다
          isSettingRemoteAnswerPending = true;
          await pc.setRemoteDescription(desc);
          isSettingRemoteAnswerPending = false;
          flushPendingCandidates();
          return;
        }

        if (desc.type === 'offer') {
          await pc.setRemoteDescription(desc);
          flushPendingCandidates();
          await pc.setLocalDescription(await pc.createAnswer());
          ws.send(JSON.stringify({ type: 'description', description: pc.localDescription }));
          return;
        }
      } catch (err) {
        onLog('description handling error: ' + err?.message);
      }
      return;
    }

    // (C) 상대 ICE 후보 수신
    if (msg.type === 'candidate' && msg.candidate) {
      await safeAddIceCandidate(msg.candidate);
      return;
    }
  };

  ws.onclose = () => {
    // 이 단계에서는 단순 로그만 남깁니다.
    // 다음 단계에서 "새로고침에 강한 재연결"과 "서버 작업 최소화"를 더 단단히 만들겠습니다.
    console.log('[WS] closed');
  };

  // 외부에서 쓸 수 있게 간단한 인터페이스 반환
  return {
    send,                       // 데이터채널로 문자열 전송
    get pc() { return pc; },    // 필요 시 디버깅용
  };
}
