export function createManualPeer({signaling, log}) {
  const pc = new RTCPeerConnection({
    iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
  });

  let dc = null;

  // 수동: 내가 먼저 call() 할 때, 채널 생성
  function ensureDataChannel() {
    if (dc) return dc;
    dc = pc.createDataChannel('chat');
    wireDC(dc, log);
    return dc;
  }

  pc.ondatachannel = e => {
    if (!dc) {
      dc = e.channel;
      wireDC(dc, log);
    }
  };

  pc.onicecandidate = ({candidate}) => {
    signaling.send({type: 'signal', data: {candidate}});
  };

  pc.onconnectionstatechange = () => {
    log(`pc.connectionState=${pc.connectionState}`);
  };

  function wireDC(channel, log) {
    channel.onopen = () => log('[dc] open');
    channel.onclose = () => log('[dc] close');
    channel.onmessage = e => log(`[dc] recv: ${e.data}`);
  }

  // --- 수동 호출(offer 시작)
  async function call() {
    try {
      ensureDataChannel();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signaling.send({type: 'signal', data: {description: pc.localDescription}});
      log('sent offer');
    } catch (error) {
      log('call() error: ' + error?.message);
    }
  }

  // --- 수동 신호 처리 ---
  async function handleSignal({description, candidate}) {
    try {
      if (description) {
        if (description.type === 'offer') {
          await pc.setRemoteDescription(description);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          signaling.send({type: 'signal', data: {description: pc.localDescription}});
          log('got offer -> sent answer');
        } else if (description.type === 'answer') {
          await pc.setRemoteDescription(description);
          log('got answer');
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (error) {
          log('addIceCandidate error: ' + error?.message);
        }
      }
    } catch (error) {
      log('handleSignal error: ' + error?.message);
    }
  }

  function send(text) {
    if (dc?.readyState === 'open') dc.send(text);
    else log(`[dc] not open (state=${dc?.readystate})`);
  }

  return {pc, call, handleSignal, send};
}
