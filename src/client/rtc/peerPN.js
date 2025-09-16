export function createPeerPN({ polite, signaling, log }) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  // PN 핵심 상태
  let makingOffer = false;
  let isSettingRemoteAnswerPending = false;

  // 데이터채널 (impolite 가 먼저 만든다)
  let dc = null;
  if (!polite) {
    dc = pc.createDataChannel('chat');
    wireDC(dc, log);
  };
  pc.ondatachannel = (e) => {
    if (!dc) {
      dc = e.channel;
      wireDC(dc, log);
    };
  };

  pc.onconnectionstatechange = () => log(`pc.connectionState=${pc.connectionState}`);

  // (다음 단계에서 채울 곳)
  pc.onnegotiationneeded = async () => {
    log("[PN] onnegotiationneeded (다음 단계에서 구현)");
  };

  pc.onicecandidate = ({ candidate }) => {
    signaling.send({ type: "signal", data: { candidate } });
  };

  // 원격 신호 처리(다음 단계에서 PN 규칙 적용)
  async function handleSignal({ description, candidate }) {
    if (description) {
      log(`[PN] got description type=${description} (다음 단계에서 구현)`);
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate); }
      catch (e) { log("addIceCandidate error(무시 가능): " + e?.message); }
    };
  };

  function send(text) {
    if (dc?.readyState === "open") dc.send(text);
    else log(`[dc] not open (state=${dc?.readyState})`);
  };

  function wireDC(channel, log) {
    channel.onopen = () => log("[dc] open");
    channel.onclose = () => log("[dc] close");
    channel.onmessage = (e) => log(`[dc] recv: ${e.data}`);
  };

  return {
    pc,
    polite,
    // PN에서 쓰는 내부 상태(디버깅용 노출)
    get makingOffer() { return makingOffer; },
    get isSettingRemoteAnswerPending() { return isSettingRemoteAnswerPending; },
    handleSignal,
    send,
  };
};
