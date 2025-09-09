export default class PerfectNegotiator {
  /**
   * @param {object} opts
   * @param {string} opts.clientId
   * @param {string?} opts.peerClientId
   * @param {{polite: boolean, dcOwner: boolean}} opts.role
   * @param {(msg: {type: 'sdp'|'ice',sdp?:RTCSessionDescriptionInit,candidate?:RTCIceCandidateInit}) => void} opts.sendSignal
   * @param {RTCConfiguration} [opts.rtcConfig]
   * @param {string} [opts.dcLabel='game']
   * @param {(s:string)=>void} [opts.log]
   */

  #lock;
  #runLocked;

  constructor({ clientId, peerClientId, role, sendSignal, rtcConfig, dcLabel = 'game', log = () => { } } = {}) {
    this.clientId = clientId;
    this.peerClientId = peerClientId || null;

    this.polite = !!role?.polite; // glare 규칙
    this.isDcOwner = !!role?.dcOwner; // 항상 같은 쪽이 DC 생성

    this.sendSignal = sendSignal;
    this.rtcConfig = rtcConfig || {};
    this, dcLabel = dcLabel;
    this.log = log;

    // PN 상태
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;

    // WebRTC 객체
    this.pc = null;
    this.dc = null;

    this._createAndWirePc();
    // 상대가 있어야 DC/협상 수행
    this.ensureDataChannel(); // 보장 dataChannel
  };

  setRole({ polite, dcOwner }) {
    this.polite = !!polite;
    this.isDcOwner = !!dcOwner;
    this.ensureDataChannel();
  };

  setPeer(peerClientId) {
    this.peerClientId = peerClientId || null;
    this.ensureDataChannel();
  };

  async onRemoteDescriptin(desc) {
    const pc = this.pc;
    try {
      if (desc.type === 'offer') {
        const offerCollistion = this.makingOffer || pc.signalingState !== 'stable';
        this.ignoreOffer = !this.polite && offerCollistion;
        if (this.ignoreOffer) {
          this.log('[PN] glare: impolite rollback');
          if (pc.signalingState !== 'stable') {
            await pc.setLocalDescription({ type: 'rollback' });
          };
        };
      };

      this, this.isSettingRemoteAnswerPending = desc.type === 'answer';
      await pc.setRemoteDescription(desc);
      this.isSettingRemoteAnswerPending = false;

      if (desc.type === 'offer') {
        this.ensureDataChannel(); // 소유자면 보장
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._send({ type: 'sdp', sdp: pc.localDescription });
      };
    } catch (error) {
      this.isSettingRemoteAnswerPending = false;
      this.log('[PN] onRemoteDescriptin error ' + error);
    };
  };

  async onRemoteIceCandidate(candidate) {
    try {
      if (!candidate) return;
      await this.pc.addIceCandidate(candidate);
    } catch (error) {
      this.log('[PN] addIceCandidate error ' + err);
    };
  };

  async close() {
    try { this.dc?.close(); } catch { }
    try { this.pc?.close(); } catch { }
    this.dc = null;
    this.pc = null;
  }

  // ---------- 내부 ----------
  _createAndWirePc() {
    this._teardownPcOnly();

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.pc = pc;
  }
};
