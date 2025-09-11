export default class PerfectNegotiator {
  constructor(pc, { polite }) {
    this.pc = pc;
    this.polite = !!polite;
    this.dc = null;

    // 아직 offer 생성/rollback 안 함. 훅만 연결
    this.pc.onnegotiationneeded = async () => {
      console.log('[STEP 1] onnegotiationneeded 발생 - 다음 단계에서 처리할 예정');
    };

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.onLocalIce?.(e.candidate);
      };
    };
  };

  setDataChannel(dc) {
    this.dc = dc;
    dc.onopen = () => console.log('[DC] open');
    dc.onmessage = (e) => console.log('[DC] message:', e.data);
    dc.onclose = () => console.log('[DC] close');
  };
};
