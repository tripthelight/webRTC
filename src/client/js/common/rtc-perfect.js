export function createPeer({ polite, sendSignal, log }) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] },
    ],
  });

  let makingOffer = false;
  let ignoreOffer = false;
  let isSettingRemoteAnswerPending = false;

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal({ candidate });
  };

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      sendSignal({ description: pc.localDescription });
      log?.('[negotiation] sent', pc.localDescription?.type);
    } catch (err) {
      console.error('[onnegotiationneeded]', err);
    } finally {
      makingOffer = false;
    }
  };

  pc.onconnectionstatechange = () => log?.('[pc] connectionState:', pc.connectionState);
  pc.onsignalingstatechange  = () => log?.('[pc] signalingState:', pc.signalingState);
  pc.oniceconnectionstatechange = () => log?.('[pc] iceConnectionState:', pc.iceConnectionState);
  pc.onicegatheringstatechange  = () => log?.('[pc] iceGatheringState:', pc.iceGatheringState);

  // 내가 먼저 하나 생성 → onnegotiationneeded 트리거
  const dc = pc.createDataChannel('chat');
  dc.onopen = () => log?.('[dc] open');
  dc.onclose = () => log?.('[dc] close');
  dc.onmessage = (e) => log?.('[dc] msg:', e.data);

  // 상대가 먼저 만든 채널 수신
  pc.ondatachannel = (ev) => {
    const ch = ev.channel;
    ch.onopen = () => log?.('[dc:remote] open');
    ch.onmessage = (e) => log?.('[dc:remote] msg:', e.data);
    ch.onclose = () => log?.('[dc:remote] close');
  };

  async function onSignal({ description, candidate }) {
    try {
      if (description) {
        const readyForOffer = (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);
        const offerCollision = (description.type === 'offer' && !readyForOffer);

        ignoreOffer = !polite && offerCollision;
        if (ignoreOffer) {
          log?.('[signal] ignore remote offer (impolite & collision)');
          return;
        }

        if (offerCollision && polite) {
          log?.('[signal] polite rollback');
          await pc.setLocalDescription({ type: 'rollback' });
        }

        isSettingRemoteAnswerPending = (description.type === 'answer');
        await pc.setRemoteDescription(description);
        log?.('[signal] setRemoteDescription:', description.type);

        if (description.type === 'offer') {
          await pc.setLocalDescription();
          sendSignal({ description: pc.localDescription });
          log?.('[signal] reply with answer');
        }

        isSettingRemoteAnswerPending = false;
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error('[onSignal]', err);
    }
  }

  return {
    pc,
    dc,
    onSignal,
    state: {
      get polite() { return polite; },
      get makingOffer() { return makingOffer; },
      get ignoreOffer() { return ignoreOffer; },
      get isSettingRemoteAnswerPending() { return isSettingRemoteAnswerPending; },
    }
  };
}