export class NegotiationManager {
  constructor({ createPeerConnection, onLog = () => {} }) {
    this.createPeerConnection = createPeerConnection;
    this.onLog = onLog;
    this.current = null; // { attemptId, pc, controller, dc }
    this.candidateBuffer = new Map(); // attemptId -> ICE[] (plain object)
    this.openDC = null; // ✅ 마지막으로 open 상태가 된 DataChannel (attempt 교체 후에도 유지)
    this.onMessageHandler = null; // 사용자 지정 메시지 핸들러
  }

  log(...args) { this.onLog('[NEG]', ...args); }

  startNewAttempt(attemptId) {
    if (this.current) this.abortAttempt('newer attempt incoming');
    const controller = new AbortController();
    const pc = this.createPeerConnection();
    this.current = { attemptId, pc, controller, dc: null };
    this.log('start attempt', attemptId);

    // 상태 로그 보강
    pc.onconnectionstatechange = () => this.log('conn', pc.connectionState);
    pc.oniceconnectionstatechange = () => this.log('ice', pc.iceConnectionState);
    pc.onsignalingstatechange = () => this.log('sig', pc.signalingState);

    return this.current;
  }

  abortAttempt(reason = 'abort') {
    const cur = this.current;
    if (!cur) return;
    this.log('abort attempt', cur.attemptId, reason);
    try { cur.controller.abort(); } catch {}
    try { if (cur.dc) { cur.dc.onopen = cur.dc.onclose = cur.dc.onmessage = null; cur.dc.close(); } } catch {}
    try { cur.pc.getSenders().forEach(s => s.track && s.track.stop()); } catch {}
    try { cur.pc.close(); } catch {}
    this.current = null;
  }

  isStaleAttempt(incomingAttemptId) {
    return this.current && incomingAttemptId < this.current.attemptId;
  }

  ensureLatest(incomingAttemptId) {
    if (!this.current || incomingAttemptId > this.current.attemptId) {
      this.startNewAttempt(incomingAttemptId);
    }
    return this.current && incomingAttemptId === this.current.attemptId;
  }

  bufferCandidate(attemptId, candidateObj) {
    let arr = this.candidateBuffer.get(attemptId);
    if (!arr) this.candidateBuffer.set(attemptId, (arr = []));
    arr.push(candidateObj);
  }

  async flushCandidates(attemptId, pc) {
    const arr = this.candidateBuffer.get(attemptId) || [];
    for (const c of arr) {
      try {
        const ice = (typeof RTCIceCandidate !== 'undefined') ? new RTCIceCandidate(c) : c;
        await pc.addIceCandidate(ice);
      } catch (err) { this.log('addIceCandidate error', err); }
    }
    this.candidateBuffer.delete(attemptId);
  }

  // --- DataChannel 유틸 ---
  _wireDataChannel(dc) {
    // 공통 배선: open/close/message
    dc.onopen = () => {
      this.log('DC open', dc.label, dc.id);
      this.openDC = dc;              // ✅ 시도 교체 이후에도 사용 가능하도록 보관
      if (this.current) this.current.dc = dc; // 현재 시도에도 연결
    };
    dc.onclose = () => {
      this.log('DC close', dc.label, dc.id);
      if (this.current && this.current.dc === dc) this.current.dc = null;
      if (this.openDC === dc) this.openDC = null;
    };
    dc.onmessage = (e) => {
      this.log('DC msg', e.data);
      if (typeof this.onMessageHandler === 'function') {
        try { this.onMessageHandler(e.data); } catch {}
      }
    };
  }

  attachDataChannel(dc) {
    if (!this.current) return;
    this.current.dc = dc;
    this._wireDataChannel(dc);
  }

  getOpenDataChannel() {
    // 우선순위: 현재 시도의 dc가 open → openDC(이전 시도에서 열린 채널)
    const prefer = (this.current && this.current.dc && this.current.dc.readyState === 'open')
      ? this.current.dc
      : (this.openDC && this.openDC.readyState === 'open') ? this.openDC : null;
    return prefer;
  }

  send(text) {
    const dc = this.getOpenDataChannel();
    if (!dc) {
      this.log('send skipped: no open DataChannel');
      throw new Error('DataChannel not open');
    }
    dc.send(text);
  }

  onMessage(fn) { this.onMessageHandler = fn; }
}