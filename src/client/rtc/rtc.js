// STEP 1에서는 "방 접속 → 역할 전달받기"까지만 합니다.
// 다음 단계에서 이 역할을 이용해 Perfect Negotiation 로직(onnegotiationneeded, glare 처리)을 얹습니다.

// STEP 2: Perfect Negotiation(최소 구현) + onnegotiationneeded
// - 서버는 STEP 1 그대로: join/roles/relay만 담당(작업 최소화)
// - 클라이언트는 역할(initiator/polite)에 따라 offer/answer/ICE를 주고받음
// - 두 번째 입장자(initiator=true)가 DataChannel을 만들고, onnegotiationneeded에서 offer를 전송
// - Perfect Negotiation 패턴 변수 3개로 glare(동시 offer) 안전 처리

// (1) 고정 clientId: 새로고침(F5)해도 바뀌지 않도록 localStorage에 저장
function getStableClientId() {
  let id = localStorage.getItem('clientId');
  if (!id) {
    // 간단한 UUID 생성(충분히 유니크)
    id = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
    localStorage.setItem('clientId', id);
  }
  return id;
}

// (2) WebSocket에 보낼 도우미
function wsSend(ws, obj) {
  ws.send(JSON.stringify(obj))
}

// ==== (A) RTCPeerConnection 관련 전역 상태(디버그 편의) ====
const RTC = {
  ws: null,               // WebSocket 인스턴스
  room: null,             // 방 이름
  clientId: null,         // 내 고정 ID
  role: null,             // 서버가 내려준 내 역할 {slot, initiator, polite}
  peer: null,             // 상대 역할 정보
  pc: null,               // RTCPeerConnection
  dc: null,               // DataChannel (initiator가 생성, 상대는 ondatachannel로 수신)
  // Perfect Negotiation 상태 플래그
  makingOffer: false,
  ignoreOffer: false,
  isSettingRemoteAnswerPending: false,
};

// ==== (B) 시그널 전송: 서버는 그대로 상대에게 릴레이만 함 ====
function sendSignal(data) {
  if (!RTC.ws) return;
  wsSend(RTC.ws, { type: 'signal', data });
}

// ==== (C) PeerConnection 생성 ====
function createPeerConnection({ polite }) {
  // 최소 STUN 서버(공용) — 필요시 사내/자체 STUN/TURN으로 교체 가능
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  // Perfect Negotiation 플래그 초기화
  RTC.makingOffer = false;
  RTC.ignoreOffer = false;
  RTC.isSettingRemoteAnswerPending = false;

  // (1) 내 ICE 후보가 생길 때마다 상대에게 즉시 전달(Trickle ICE)
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      // candidate를 그대로 보냄
      sendSignal({ candidate });
    }
  };

  // (2) 연결 상태 로그(디버깅용)
  pc.onconnectionstatechange = () => {
    console.log('🌐 connectionState:', pc.connectionState);
  };
  pc.onsignalingstatechange = () => {
    console.log('📶 signalingState:', pc.signalingState);
  };
  pc.oniceconnectionstatechange = () => {
    console.log('❄️ iceConnectionState:', pc.iceConnectionState);
  };

  // (3) 상대가 만든 DataChannel을 받는 쪽(= 주로 non-initiator)
  pc.ondatachannel = (ev) => {
    RTC.dc = ev.channel;
    wireDataChannel(RTC.dc, { isLocalCreator: false });
  };

  // (4) 내가 뭔가(트랙 추가, DC 생성 등) 해볼 일이 생겼을 때 자동으로 호출
  //     → initiator만 offer 생성 시도(역할 고정)
  pc.onnegotiationneeded = async () => {
    try {
      // initiator가 아닌 경우엔 offer를 만들지 않음(역할 충돌 방지)
      if (!RTC.role?.initiator) return;

      RTC.makingOffer = true;
      // setLocalDescription(null) 호출 대신 "offer 생성 + setLocalDescription"을
      // RTCPeerConnection에 위임: 그냥 setLocalDescription()만 호출하면
      // 내부적으로 offer를 만들고 로컬SDP로 설정함
      await pc.setLocalDescription();
      // 만들어진 offer를 상대에게 전송
      sendSignal({ description: pc.localDescription });
      console.log('📤 sent offer');
    } catch (err) {
      console.error('onnegotiationneeded error:', err);
    } finally {
      RTC.makingOffer = false;
    }
  };

  return pc;
}

// ==== (D) DataChannel 공통 배선(로그/메시지 핸들러) ====
function wireDataChannel(dc, { isLocalCreator }) {
  dc.onopen = () => {
    console.log(`💬 DataChannel open (${isLocalCreator ? 'local' : 'remote'})`);
    // 데모: 열린 즉시 간단한 ping 전송
    try { dc.send('hello from ' + (isLocalCreator ? 'initiator' : 'non-initiator')); } catch {}
  };
  dc.onmessage = (ev) => {
    console.log('📩 DC message:', ev.data);
  };
  dc.onclose = () => {
    console.log('💬 DataChannel closed');
  };
}

// ==== (E) 수신한 시그널 처리(Perfect Negotiation 핵심) ====
async function handleSignal({ description, candidate }) {
  const pc = RTC.pc;
  const polite = !!RTC.role?.polite;

  try {
    if (description) {
      // 1) description 수신 시(offer 또는 answer)
      const readyForOffer =
        !RTC.makingOffer &&
        (pc.signalingState === 'stable' || RTC.isSettingRemoteAnswerPending);

      const offerCollision = description.type === 'offer' && !readyForOffer;

      // 2) glare(동시 offer) 상황:
      //    - 내가 impolite이면 이번 offer는 무시
      //    - 내가 polite이면 상대 offer를 받아들이기(rollback 등)
      RTC.ignoreOffer = !polite && offerCollision;
      if (RTC.ignoreOffer) {
        console.warn('⚠️ offer ignored (impolite & collision)');
        return;
      }

      // 3) 로컬이 answer를 기다리는 중인지 표시(완료 후 false로 되돌림)
      RTC.isSettingRemoteAnswerPending = description.type === 'answer';

      // 4) 부드러운 처리: 필요 시 rollback
      if (offerCollision) {
        // 현재 내가 뭔가 로컬 변경 중이었다면 되돌림
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription(description),
        ]);
      } else {
        await pc.setRemoteDescription(description);
      }

      // 5) 상대가 offer를 보낸 경우 → 내가 answer 생성/전송
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        sendSignal({ description: pc.localDescription });
        console.log('📤 sent answer');
      }

      RTC.isSettingRemoteAnswerPending = false;
    } else if (candidate) {
      // 6) ICE 후보 수신
      //    - 이전에 이번 offer를 무시하기로 했다면 candidate도 무시
      if (RTC.ignoreOffer) return;
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        // setRemoteDescription 전에 candidate가 도착하면 addIceCandidate(null) 패턴으로
        // "끝"을 알리는 경우를 제외하고 에러가 날 수 있어, 무해한 경우는 무시
        if (!pc.remoteDescription) {
          console.warn('ICE add skipped (no remoteDescription yet).');
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    console.error('handleSignal error:', err);
  }
}

// ==== (F) 역할을 받은 순간 PeerConnection 준비 ====
function preparePeerByRole() {
  const { initiator, polite } = RTC.role;

  // 1) 새 RTCPeerConnection 생성
  RTC.pc = createPeerConnection({ polite });

  // 2) initiator는 DataChannel을 "먼저" 만든다.
  //    → onnegotiationneeded가 트리거되어 offer를 전송(서버가 정한 '두 번째 입장자 규칙' 준수)
  if (initiator) {
    RTC.dc = RTC.pc.createDataChannel('game');
    wireDataChannel(RTC.dc, { isLocalCreator: true });
    console.log('🔧 initiator created DataChannel');
  }
}

// ==== (G) 공개 API: 시그널 서버 연결 & 방 참여 ====
export function connectSignaling({ room, url = 'ws://localhost:8080' }) {
  RTC.clientId = getStableClientId();
  RTC.room = room;
  RTC.ws = new WebSocket(url);

  // 디버그 전역 노출
  window.__RTC_STATE__ = RTC;

  RTC.ws.addEventListener('open', () => {
    wsSend(RTC.ws, { type: 'join', room, clientId: RTC.clientId });
    console.log(`[WS] connected. join room="${room}" clientId="${RTC.clientId}"`);
  });

  RTC.ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'room-full') {
      console.warn(`⚠️ 방이 가득 찼습니다: ${msg.room}`);
      return;
    }

    if (msg.type === 'roles') {
      // 서버가 역할 재통지(입장/퇴장/재접속 시점 포함)
      RTC.role = msg.you;
      RTC.peer = msg.peer || null;

      console.clear();
      console.log('🧩 ROOM:', msg.room);
      console.table({
        you: { clientId: RTC.role.clientId, slot: RTC.role.slot, initiator: RTC.role.initiator, polite: RTC.role.polite },
        peer: RTC.peer ? { clientId: RTC.peer.clientId, slot: RTC.peer.slot, initiator: RTC.peer.initiator, polite: RTC.peer.polite } : null,
      });

      // (중요) PeerConnection이 없거나, 상대 퇴장 후 재입장 등으로 "다시 준비"가 필요하면 생성
      // - 새로고침(F5) 시에도 여기서 새 pc를 만들어서 자연스러운 재협상 경로로 복귀
      if (!RTC.pc || RTC.pc.connectionState === 'closed') {
        preparePeerByRole();
      }
      // 상대가 없다면(1명만 방에 있을 때) 여기까지만. 상대가 들어오면 자동 협상 진행.
      return;
    }

    if (msg.type === 'signal') {
      // 서버가 릴레이해 준 시그널(description/ICE)
      await handleSignal(msg.data);
      return;
    }
  });

  RTC.ws.addEventListener('close', () => {
    console.log('[WS] closed');
    // 필요시 재접속 로직을 여기에 넣을 수 있지만,
    // 이 튜토리얼에선 브라우저 F5 시 자연스레 새 연결을 맺는 흐름으로 둡니다.
  });

  RTC.ws.addEventListener('error', (e) => {
    console.error('[WS] error', e);
  });

  return RTC.ws;
}
