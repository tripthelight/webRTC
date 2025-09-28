let pc = null;
let dc = null;

// signaling 송신 함수
let sendSignal = null;

const $ = (sel) => document.querySelector(sel);
const log = (msg) => {
  const el = $('#log');
  el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  el.scrollTop = el.scrollHeight;
};

export function setSignaling(sendFn) {
  sendSignal = sendFn;
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
  channel.onopen = () => log('[rtc] dataChannel open');
  channel.onclose = () => log('[rtc] dataChannel close');
  channel.onmessage = (ev) => log(`[rtc] dataChannel message: ${ev.data}`);
}

// ★ 수신한 시그널 처리: SDP(offer/answer) + ICE
export async function onSignalMessage(msg) {
  if (!pc) createPeer();

  if (msg.kind === 'sdp') {
    const desc = msg.description;
    try {
      if (desc.type === 'offer') {
        log('[rtc] offer 수신 → answer 생성');
        await pc.setRemoteDescription(desc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal && sendSignal({ kind: 'sdp', description: pc.localDescription });
        log('[rtc] answer 보냄');
      } else if (desc.type === 'answer') {
        log('[rtc] answer 수신 → setRemoteDescription');
        await pc.setRemoteDescription(desc);
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
