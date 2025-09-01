const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const logEl = document.getElementById('log');
function log(...args) {
  console.log(...args);
  const s = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logEl.innerText += s + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

/** 고정 ID(localStorage), 세대(epoch: sessionStorage) */
export function getOrCreatePeerId() {
  const k = 'demo.peerId';
  let v = localStorage.getItem(k);
  if (!v) {
    v = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
    localStorage.setItem(k, v);
  }
  return v;
}
export function bumpEpochAndGet() {
  const k = 'demo.peerEpoch';
  let n = Number(sessionStorage.getItem(k) || '0');
  n += 1; // 새로고침마다 증가
  sessionStorage.setItem(k, String(n));
  return n;
}

/** 시그널링 클라이언트(WebSocket) */
export class SignalingClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.ready = new Promise((res) => { this._resolveReady = res; });
    this.onMessage = () => {};
    this.onOpen = () => {};
    this.onClose = () => {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => { this._resolveReady?.(); this.onOpen(); resolve(); };
      this.ws.onclose = () => { this.onClose(); };
      this.ws.onerror = (e) => { reject(e); };
      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this.onMessage(msg);
      };
    });
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}

/** Perfect Negotiation + epoch-aware WebRTC 래퍼 */
export class PeerLink {
  /**
   * @param {{room: string, signaling: SignalingClient}} opts
   */
  constructor({ room, signaling }) {
    this.room = room;
    this.signaling = signaling;

    this.peerId = getOrCreatePeerId();
    this.epoch = bumpEpochAndGet();       // 내가 보낼 epoch
    this.remoteEpoch = -1;                // 상대 epoch 기억

    this.remoteId = null;
    this.polite = true;                   // 나중에 roster로 결정

    this.pc = null;
    this.dc = null;
    this.makingOffer = false;
    this.ignoreOffer = false;

    this.abortController = null;

    // 이벤트 콜백
    this.onStatus = (t) => log('[status]', t);
    this.onChatMessage = (text) => log(`[peer] ${text}`);

    // 바인딩
    this._onSignal = this._onSignal.bind(this);
  }

  /** 연결 시작 */
  async start() {
    await this.signaling.ready;
    // 1) 방 입장
    this.signaling.send({ type: 'join', room: this.room, peerId: this.peerId, epoch: this.epoch });

    // 2) 시그널 메시지 수신 핸들러
    this.signaling.onMessage = this._onSignal;

    // 3) RTCPeerConnection 생성
    this._resetPeerConnection();

    this.onStatus(`연결 준비 (peerId=${this.peerId}, epoch=${this.epoch})`);
  }

  /** 종료 */
  stop() {
    this.signaling?.send({ type: 'leave', room: this.room, peerId: this.peerId });
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.dc = null;
    this.pc = null;
    this.abortController?.abort();
  }

  /** 채팅 전송 */
  sendChat(text) {
    if (this.dc?.readyState === 'open') {
      this.dc.send(text);
      log(`[me] ${text}`);
    } else {
      log('[warn] DataChannel not open');
    }
  }

  /** 내부: PC/DC 리셋 */
  _resetPeerConnection() {
    // 진행 중 작업 중단
    this.abortController?.abort();
    this.abortController = new AbortController();

    // 기존 자원 정리
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.dc = null;

    // 새 PC
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    // negotiationneeded
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this._sendSignal('offer', { sdp: this.pc.localDescription });
      } catch (e) {
        log('[negotiationneeded error]', e);
      } finally {
        this.makingOffer = false;
      }
    };

    // ICE
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this._sendSignal('candidate', { candidate: ev.candidate });
      }
    };

    // 연결 상태
    this.pc.onconnectionstatechange = () => {
      this.onStatus(`pc.connectionState = ${this.pc.connectionState}`);
    };

    // 수신측 DataChannel
    this.pc.ondatachannel = (ev) => {
      this.dc = ev.channel;
      this._wireDataChannel();
    };

    // 발신측 DataChannel(초기 1개 생성 → 네고 트리거)
    // 양쪽 모두 만들어도 Perfect Negotiation이 충돌을 해결
    if (!this.dc) {
      this.dc = this.pc.createDataChannel('chat');
      this._wireDataChannel();
    }
  }

  /** DC 이벤트 */
  _wireDataChannel() {
    if (!this.dc) return;
    this.dc.onopen = () => this.onStatus(`DataChannel open (${this.dc.label})`);
    this.dc.onclose = () => this.onStatus('DataChannel closed');
    this.dc.onmessage = (ev) => this.onChatMessage(String(ev.data));
  }

  /** 시그널 송신 공통 */
  _sendSignal(type, payload) {
    this.signaling.send({
      type,
      room: this.room,
      fromId: this.peerId,
      epoch: this.epoch,
      payload
    });
  }

  /** 시그널 수신 처리 */
  async _onSignal(msg) {
    // 0) roster → remoteId/정중 여부 결정
    if (msg.type === 'roster' && msg.room === this.room) {
      const others = msg.peers.filter(p => p !== this.peerId);
      const newRemoteId = others[0] ?? null;
      const prevRemoteId = this.remoteId;
      this.remoteId = newRemoteId;

      if (this.remoteId) {
        // 고정된 규칙: 문자열 비교로 "작은 쪽이 polite"
        this.polite = this.peerId < this.remoteId;
        this.onStatus(`상대 감지: ${this.remoteId} (polite=${this.polite})`);
      } else {
        this.onStatus('상대 없음: 대기 중');
      }

      // 상대가 바뀌면(새로고침 등) 안정화를 위해 잠깐 대기
      if (prevRemoteId && prevRemoteId !== this.remoteId) {
        await sleep(50);
      }
      return;
    }

    // 1) 내 방/상대가 보낸 offer/answer/candidate
    if ((msg.type === 'offer' || msg.type === 'answer' || msg.type === 'candidate')
        && msg.room === this.room) {

      const { fromId, epoch, payload } = msg;
      if (fromId === this.peerId) return; // 내 것 echo 방지 (서버가 안보내지만 혹시 모를 대비)

      // (A) 더 큰 epoch 수신 → 즉시 리셋 후 수용 준비
      if (epoch > this.remoteEpoch) {
        this.remoteEpoch = epoch;
        this.onStatus(`상대 epoch 갱신: ${this.remoteEpoch} (상대:${fromId})`);
        // 안전 리셋: 진행중 작업 중단 + PC 재생성
        this._resetPeerConnection();
      } else if (epoch < this.remoteEpoch) {
        // 낮은 epoch → 무시
        return;
      }

      // (B) Perfect Negotiation
      try {
        if (msg.type === 'offer' || msg.type === 'answer') {
          const desc = payload.sdp;

          const offerCollision =
            (desc.type === 'offer') &&
            (this.makingOffer || this.pc.signalingState !== 'stable');

          this.ignoreOffer = !this.polite && offerCollision;
          if (this.ignoreOffer) {
            log('[ignore] impolite가 충돌 오퍼 무시');
            return;
          }

          if (this.polite && offerCollision) {
            // 정중: 내 로컬 작업 롤백 후 수용
            if (this.pc.signalingState !== 'stable') {
              try {
                await this.pc.setLocalDescription({ type: 'rollback' });
              } catch (e) {
                // 일부 브라우저는 특정 상태에서 rollback 불가 → 재생성 fallback
                log('[rollback fail → reset]', e);
                this._resetPeerConnection();
              }
            }
          }

          await this.pc.setRemoteDescription(desc);
          if (desc.type === 'offer') {
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            this._sendSignal('answer', { sdp: this.pc.localDescription });
          }
          return;
        }

        if (msg.type === 'candidate') {
          try {
            if (payload?.candidate) {
              await this.pc.addIceCandidate(payload.candidate);
            }
          } catch (e) {
            // state가 초기화 중일 수 있으니 조용히 무시
            log('[addIceCandidate error]', e?.message || e);
          }
          return;
        }
      } catch (e) {
        log('[signal handling error]', e);
      }
    }
  }
}