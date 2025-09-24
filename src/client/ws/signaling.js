export class Signaling {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = new Map(); // type -> Set<fn>
    this.connected = false;

    // 자동 재연결
    this._reconnectTimer = null;
    this._backoff = 500; // 0.5s 시작
    this._backoffMax = 15000; // 최댓값 15s
    this._wantClose = false; // 사용자가 의도적으로 닫았는지

    // 하트비트(선택)
    this._hbTimer = null;

    // 재합류에 필요
    this._lastRoom = null;

    // 송신 큐 (WS 닫혀있을 때 임시 보관)
    this._sendQueue = [];
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  };

  emitLocal(type, payload) {
    this.handlers.get(type)?.forEach(fn => fn(payload));
  };

  async connect() {
    if (this.ws) return;
    this._wantClose = false;

    await this._open();
  };

  async _open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => { this.connected = true; resolve(); });
      this.ws.addEventListener('error', reject);
    });

    // 이벤트
    this.ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        this.emitLocal(msg.type, msg);
      } catch (e) {
        console.error("Invalid message", ev.data, e);
      };
    });

    this.ws.addEventListener("close", () => {
      this.connected = false;
      this.emitLocal('close', {});
      this.ws = null;
      this._stopHeartbeat();
      if (!this._wantClose) this._scheduleReconnect();
    });

    // 하트비트(선택)
    this._startHeartbeat();

    // 재연결 직후 큐 비우기 + 방 재합류
    this._flushQueue();
    if (this._lastRoom) {
      // 서버는 join만 다시 받으면 됩니다
      this.join(this._lastRoom);
      this.emitLocal('reconnected', { room: this._lastRoom });
    }

    // 성공했으므로 백오프 초기화
    this._backoff = 500;
  };

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const wait = this._backoff;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this._open();
      } catch (e) {
        // 실패 시 백오프 증가
        this._backoff = Math.min(this._backoff * 2, this._backoffMax);
        this._scheduleReconnect();
      }
    }, wait);
  }

  close() {
    this._wantClose = true;
    this._stopHeartbeat();
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.connected = false;
  }

  _startHeartbeat() {
    if (this._hbTimer) return;
    this._hbTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        } catch {}
      }
    }, 10000); // 10s마다 핑
  }

  _stopHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
  }

  _enqueue(obj) {
    this._sendQueue.push(obj);
  }

  _flushQueue() {
    if (!this.connected) return;
    while (this._sendQueue.length) {
      const obj = this._sendQueue.shift();
      this._rawSend(obj);
    }
  }

  _rawSend(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._rawSend(obj)
    } else {
      this._enqueue(obj)
    }
  };

  join(room) {
    this._lastRoom = room;
    this.send({ type: "join", room });
  };

  signal(toRoom, payload) {
    this.send({ type: "signal", room: toRoom, payload })
  };
};
