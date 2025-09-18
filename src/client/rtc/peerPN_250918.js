export function createPeerPN({polite, signaling, log}) {
  const pc = new RTCPeerConnection({
    iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
  });

  // PN 핵심 상태
  let makingOffer = false; // 내가 지금 offer를 만드는 중인가?
  let isSettingRemoteAnswerPending = false; // 원격 answer 적용 중인가?

  // --- 데이터채널 impolite(false)가 먼저 생성 ---
  let dc = null;
  // 상대가 만든 dataChannel을 '받는 쪽' 코드
  pc.ondatachannel = e => {
    if (!dc) {
      dc = e.channel;
      wireDC(dc, log);
    }
  };

  pc.onconnectionstatechange = () => log(`pc.connectionState=${pc.connectionState}`);

  // --- PN: onnegotiationneeded -> 내 로컬 설명 만들고 전송 ---
  pc.onnegotiationneeded = async () => {
    try {
      log('[PN] onnegotiationneeded -> create & send offer');
      makingOffer = true;
      await pc.setLocalDescription(); // (sdp 생성: type=offer)
      signaling.send({type: 'signal', data: {description: pc.localDescription}});
      log('[PN] sent localDescription (offer)');
    } catch (error) {
      log('[PN] onnegotiationneeded error : ', error?.message);
    } finally {
      makingOffer = false;
    }
  };

  // ICE 후보 생기면 상대에게 보냄
  pc.onicecandidate = ({candidate}) => {
    signaling.send({type: 'signal', data: {candidate}});
  };

  // --- 원격 신호 처리: glare(동시 혐상) 안전 ---
  async function handleSignal({description, candidate}) {
    try {
      if (description) {
        // 지금 상대 제안을 받아들일 준비가 되었는가?
        // - offer 만드는 중이 아니고(makingOffer=false)
        // - 현재 signalingState가 "stable" 이거나
        //   방금 answer를 적용 중인 상태면(ok)
        const readyForOffer = !makingOffer && (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);

        const offerCollision = description.type === 'offer' && !readyForOffer;

        if (offerCollision) {
          if (!polite) {
            // impolite: 충돌시 상대 offer 무시
            log('[PN] offer collision: impolite -> ignore remote offer');
            return;
          }
          // polite: 내가 하던 것 되돌리고(rollback) 상대 offer를 먼저 수락
          log('[PN] offer collision: polite -> rollback & accept remote offer');
          await Promise.all([pc.setLocalDescription({type: 'rollback'}), pc.setRemoteDescription(description)]);
        } else {
          // 충돌 아님 -> 정상적으로 원격 설명 적용
          await pc.setRemoteDescription(description);
        }

        if (description.type === 'offer') {
          // 상대가 offer면 -> answer 작성 후 전송
          await pc.setLocalDescription();
          signaling.send({type: 'signal', data: {description: pc.localDescription}});
          log('[PN] got offer -> sent answer');
        } else {
          // 상대가 answer면 -> 적용 중 표시만 잠깐
          if (description.type === 'answer') {
            isSettingRemoteAnswerPending = true;
            // isSettingRemoteAnswerPending 가 바로 위에서 수행했음
            queueMicrotask(() => {
              isSettingRemoteAnswerPending = false;
            });
            log('[PN] got answer');
          }
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (error) {
          // glare로 무시된 offer에서 온 candidate면 add 실패가 날 수 있음 -> 무시
          log('[PN] addIceCandidate error : ', error?.message);
        }
      }
    } catch (error) {
      log('[PN] handleSignal error : ', error?.message);
    }
  }

  // 내가 '먼저 만드는 쪽' 코드
  // 외부에서 호출: 상대가 들어온 뒤에 호출해 협상을 '지금' 시드
  function ensureNegotiationKick() {
    if (dc || polite) return; // impolite만 채널을 만든다 (polite는 ondatacahnnel로 받음)
    dc = pc.createDataChannel('chat');
    wireDC(dc, log);
    // 채널 생성 -> onnegotiationneeded 자동 발생 -> offer 전송
  }

  function send(text) {
    if (dc?.readyState === 'open') dc.send(text);
    else log(`[dc] not open (state=${dc?.readyState})`);
  }

  function wireDC(channel, log) {
    channel.onopen = () => log('[dc] open');
    channel.onclose = () => log('[dc] close');
    channel.onmessage = e => log(`[dc] recv: ${e.data}`);
  }

  function close() {
    try {
      dc?.close();
    } catch {}
    try {
      pc?.close();
    } catch {}
  }

  return {
    pc,
    polite,
    // PN에서 쓰는 내부 상태(디버깅용 노출)
    get makingOffer() {
      return makingOffer;
    },
    get isSettingRemoteAnswerPending() {
      return isSettingRemoteAnswerPending;
    },
    handleSignal,
    send,
    close,
    ensureNegotiationKick,
  };
}
