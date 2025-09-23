export function createPeerPN({polite, signaling, log}) {
  const pc = new RTCPeerConnection({
    iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
  });
}
