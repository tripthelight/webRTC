export default class PerfectNegotiator {
  constructor(pc, { polite, sendSignal }) {
    this.pc = pc;
    this.polite = !!polite;
    this.dc = null;
    this.isMakingOffer = false;
    this.sendSignal = sendSignal; // (ws를 통해) 신호 보내느 함수 주입
    this.ready = false; // 'paired' 수신 전까지는 협상 금지

    // negotiationneeded: stable 일 때만 offer 생성
    this.pc.onnegotiationneeded = async () => {
      try {
        if (!this.ready) {
          console.log('[STEP 02] 아직 paried 아님 -> offer 생성 금지');
          return;
        };
        if (this.pc.signalingState !== 'stable') {
          console.log('[STEP 2] signalingState != stable -> offer 생성 보류');
          return;
        };
        this.isMakingOffer = true;
        console.log('[STEP 2] createOffer 시작');
        await this.pc.setLocalDescription(await this.pc.createOffer());
        this._send({ sdp: this.pc.localDescription });
        console.log('[STEP 2] offer 전송 완료');
      } catch (error) {
        console.warn('[STEP 2] onnegotiationneeded error : ', error);
      } finally {
        this.isMakingOffer = false;
      };
    };

    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.ready) {
        this._send({ ice: e.candidate });
      };
    };
  };

  markReady() { this.ready = true; };

  setDataChannel(dc) {
    this.dc = dc;
    dc.onopen = () => console.log('[DC] open');
    dc.onmessage = (e) => console.log('[DC] message:', e.data);
    dc.onclose = () => console.log('[DC] close');
  };

  // 신호 수신 처리 (game.js에서 msg.payload를 이 메서드로 넘겨주세요)
  async receiveSignal(payload) {
    try {
      if (payload.sdp) {
        const desc = payload.sdp;

        if (desc.type === 'offer') {
          console.log('[STEP 2] offer 수신 -> setRemote -> createAnswer -> setLocalDescription -> 전송');
          await this.pc.setRemoteDescription(desc);
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          this._send({ sdp: this.pc.localDescription });
        } else if (desc.type === 'answer') {
          console.log('[STEP 2] answer 수신 -> setRemote');
          await this.pc.setRemoteDescription(desc);
        };
        return;
      };

      if (payload.ice) {
        try {
          console.log('[STEP 2] candidate 통신 -> addIceCandidate');
          await this.pc.addIceCandidate(payload.ice)
        } catch(error) {
          // setRemoteDescription이 아직 없는 타이밍 등에서 발생 가능
          console.warn('[STEP 2] addIceCandidate 경고 : ', error);
        };
      };
    } catch (error) {
      console.warn('[STEP 2] receiveSignal error : ', error);
    };
  };

  _send(obj) {
    this.sendSignal?.(obj);
  };
};
