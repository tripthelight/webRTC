export default class PerfectNegotiator {
  /**
   * @param {object} opts
   * @param {(msg: any) => void} opts.send - 시그널 서버로 메시지 전송 함수
   * @param {RTCConfiguration} [opts.rtcConfig]
   * @param {(msg: string) => void} [opts.onData] - 데이터채널 메시지 수신 콜백
   * @param {() => void} [opts.onOpen] - 데이터채널 open 콜백
   * @param {(state: RTCPeerConnection) => void} [opts.onConnStateChange]
   */

  #lock;
  #runLocked;

  constructor({ send, rtcConfig, onData, onOpen, onConnStateChange } = {}) {
    if (typeof send !== 'function') throw new Error('send 함수가 필요합니다.');
    this.send = send;

    // Perfect Negotiation 관련 상태
    this.polite = null; // 서버로부터 role 수신 후 설정
    this.makingOffer = false; // createOffer / setLocalDescription 중인지
    this.ignoreOffer = false; // impolite가 충돌 offer를 무시할 지
    this.remoteDescSet = false; // 원격 SDP가 세팅되었는지
    this.candidateBuffer = []; // 원격 SDP 전 도착한 ICE 버퍼

    // 초소형 뮤텍스(동시에 하나만 처리) - SDP 경합 줄이기(권장)
    this.#lock = Promise.resolve();
    this.#runLocked = (task) => {
      const next = this.#lock.then(task).catch((e) => { throw e; });
      // 체인 유지(오류로 끊기지 않게)
      this.#lock = next.catch(() => {});
      return next;
    };

    // RTCPeerConnection
    this.pc = new RTCPeerConnection(rtcConfig);
    this.dc = null; // dataChannel

    // 이벤트 연결
    // PeerConnection 상태에 변화를 주어 SDP를 새로 만들어야 할 때 발생
    this.pc.onnegotiationneeded = () => this.#runLocked(async () => {
      try {
        this.makingOffer = true;
        // (로컬 트랙/데이터채널이 준비되면) 로컬 SDP 생성 -> 전송
        await this.pc.setLocalDescription(); // signalingState : have-local-offer
        const localPeer = sessionStorage.getItem('localPeer') || null;

        // console.log('STEP 3' + ' ' + this.polite + ' ' + peer);
        // console.log('this.pc : ', this.pc);
        // console.log('this.dc : ', this.dc);

        this.send({
          type: 'description',
          signal: this.pc.localDescription,
          to: localPeer
        });
      } finally {
        this.makingOffer = false;
      };
    });

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ type: 'candidate', candidate });
    };

    this.pc.ondatachannel = (ev) => {
      this.#wireDataChannel(ev.channel, onData, onOpen);
    };

    this.pc.onconnectionstatechange = () => {
      onConnStateChange?.(this.pc.connectionState);
    };

    // 데이터채널 핸들러 저장
    this._onData = onData;
    this._onOpen = onOpen;
  };

  /** 서버가 내려주는 role 수신 */
  setPolite(polite) {
    this.polite = !!polite;

    // impolite(false)만 주도적으로 채널 생성 (항상 한쪽만 생성)
    if (!this.polite && !this.dc) {
      // 기다리고 있는 peer
      // 첫번째 접속 peer
      // 새로고침 당한 peer
      this.dc = this.pc.createDataChannel('chat');
      this.#wireDataChannel(this.dc, this._onData, this._onOpen);
    };
  };

  /** 서버에서 온 모든 메시지를 그대로 젛어주면 됩니다. */
  handleSignal(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'role') {
      sessionStorage.setItem('localPeer', msg.you || '');
      this.setPolite(!!msg.polite);
      return;
    };

    // 두번째 접속 peer B(polite)가 보냄
    // 첫번째 접속 peer A(impolite)가 받고 offer 생성해서 peer B(polite)에게 보냄
    if (msg.type === 'peer-joined') {
      sessionStorage.setItem('peer', msg.peer || '');
      return;
    };

    if (msg.type === 'description') {
      const { signal, from } = msg;
      console.log('signal.type : ', signal.type);

      this.#onRemoteDescription(signal, from);
      return;
    };
  };

  /** 데이터 전송 */
  sendData(text) {};

  /** 정리 */
  close() {};

  // ----------------- 내부 구현 -----------------
  #wireDataChannel(dc, onData, onOpen) {
    this.dc = dc;
    dc.onopen = () => { onOpen?.(); };
    dc.onmessage = (e) => { onData?.(e.data); };
    dc.onclose = () => { /* 필요 시 지시도 로직 */ };
  };

  #onRemoteDescription(signal, from) {
    // from -> 나
    const localPeer = sessionStorage.getItem('localPeer') || null;
    if (localPeer === from) return;

    // SDP 처리(충돌 판단/롤백 포함)는 직렬화해서 안전하게
    this.#runLocked(async () => {
      const pc = this.pc;

      // 아직 role을 못받은 상태라면(이례적) 잠시 대기할 수도 있지만
      // 여기선 단순히 진행(실전에서는 role 미수신 방지 코드를 권장)
      const polite = !!this.polite;

      // 내가 offer를 만들고 있는데, offer를 받음
      // 내가 offer나 answer를 만들고 있었는데, offer를 받음
      const offerCollision = signal.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');

      // impolite + 충돌 -> 롤백 후 상대 오퍼 수락
      this.ignoreOffer = !polite && offerCollision;
      if (this.ignoreOffer) {
        // 조용히 무시
        return;
      };

      // polite + 충돌 -> 롤백 후 상대 오퍼 수락
      if (offerCollision) {
        try { await pc.setLocalDescription({ type: 'rollback' }); } catch {}
      };
    })
  };

  async #onRemoteCandidate(candidate) {};
};
