// --- RTC config (외부 주입 가능)
const DEFAULT_RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let RTC_CONFIG = DEFAULT_RTC_CONFIG;

export function connect({ roomId = 'room-1', wsUrl = 'ws://localhost:8080', rtcConfig }) {
  RTC_CONFIG = rtcConfig ?? DEFAULT_RTC_CONFIG;

  let ws;
  let pc;
  let dc;

  // Perfect Negotiation flags
  let isPolite = true;                 // 서버에서 role 통지로 덮어씀
  let shouldOffer = false;             // 서버에서 role 통지로 덮어씀
  let makingOffer = false;
  let ignoreOffer = false;
  let isSettingRemoteAnswerPending = false;

  // ICE 재시작 관리
  let iceRestartTimer = null;
  let lastIceRestart = 0;
  const ICE_RESTART_COOLDOWN = 5000; // ms, 너무 자주 재시작하지 않도록 쿨다운

  // --- WebSocket reconnect ---
  let reconnectAttempt = 0;
  const RECONNECT_BASE = 500;   // ms
  const RECONNECT_MAX  = 5000;  // ms
  let reconnectTimer = null;    // ← [추가] 예약된 재접속 타이머

  // --- DataChannel send queue (최소 구현) ---
  let sendQueue = [];      // { payload: string, tries: number }
  let flushing = false;
  const SEND_TIMEOUT = 1500;      // ms, open 대기 타임아웃
  const RETRY_LIMIT  = 3;         // 전송 재시도 횟수
  const BACKOFF_BASE = 200;       // ms, 재시도 백오프
  const DRAIN_LOW    = 64 * 1024; // 64KB, backpressure 임계치

  // --- Rejoin 감지 & 상태 도익화 ---
  let selfId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random());
  let getSyncState = null; // () => any : 내 현재 게임상태를 반환
  let applyRemoteSync = null; // (state) => void : 상대 상태를 반영

  function setSyncProvider(fn) { getSyncState = fn; }; // 앱 코드에서 등록
  function onRemoteSync(fn) { applyRemoteSync = fn; }; // 앱 코드에서 등록

  function sendText(text) { enqueueSend(String(text)); }
  function sendJSON(obj)  { enqueueSend(obj); };

  // --- Early ICE queue ---
  let earlyIce = [];

  // --- Negotiation debounce ---
  let negTimer = null;
  let needsNegotiation = false;
  const NEG_DEBOUNCE = 120; // ms: 너무 작게/크게 잡지 마세요

  // --- Session epoch: 한 탭(세션) 식별자
  let epoch = 0;          // 내 세션 번호
  let remoteEpoch = null; // 상대 세션 번호(처음 수신 시 고정)

  // --- ICE candidate batch ---
  let candBatch = [];
  let candTimer = null;
  const CAND_BATCH_MS = 30; // 너무 크면 연결 느려짐, 너무 작으면 효과 약함

  // --- DataChannel keepalive ---
  let kaTimer = null;
  let lastSeen = 0;
  const KA_INTERVAL = 2500; // ms, 핑 주기
  const KA_IDLE    = 8000;  // ms, 이 시간 이상 응답 없으면 유휴로 간주

  // --- Reliable messaging (ack/seq) ---
  let txSeq = 1;
  const pendingRel = new Map();  // seq -> { env, tries, timer }
  const REL_BASE = 400;          // ms
  const REL_MAX  = 4000;         // ms
  const REL_RETRY = 5;           // 최대 재전송 횟수
  const rxSeen = new Set();      // 중복 수신 방지
  const rxOrder = [];
  const RX_KEEP = 256;           // 최근 256개만 유지
  let onReliableHandler = null;  // 앱 콜백

  // --- Chunking (MTU-safe over DataChannel) ---
  const CHUNK_CHARS = 12000;     // 조각 크기(문자 기준). 너무 크게 잡지 마세요.
  const CHUNK_THRESHOLD = 12000; // 이 이상이면 청크 전송 사용
  const reassemble = new Map();  // mid -> { type, total, parts: [], count }
  let midSeq = 1;                // 메시지 ID 시퀀스

  function log(...args) { console.log('[RTC]', ...args); };

  function connectWS() {
    // 기존 소켓 있으면 정리
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try { ws.close(); } catch {}
    }
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      reconnectAttempt = 0; // 성공 시 시도 횟수 리셋
      ws.send(JSON.stringify({ type: 'join', roomId }));
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'role') {
        handleRole(msg);               // 역할 재통지 → 항상 새 RTCPeerConnection으로 재시작
      } else if (msg.type === 'signal') {
        handleSignal(msg.payload);
      } else if (msg.type === 'peer-left') {
        if (dc) { try { dc.close(); } catch {} dc = null; }
        log('Peer left. Waiting for rejoin...');
      }
    });

    const scheduleReconnect = () => {
      // 이미 예약된 타이머가 있으면 취소
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

      // 오프라인이면 타이머 예약 대신 'online' 이벤트를 1회 대기
      if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) {
        log('WS offline: wait for online event to reconnect.');
        window.addEventListener('online', () => {
          log('WS online: reconnect now');
          connectWS();
        }, { once: true });
        return;
      }

      const delay = Math.min(RECONNECT_BASE * (2 ** reconnectAttempt), RECONNECT_MAX);
      reconnectAttempt++;
      log(`WS reconnect in ${delay}ms`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWS();
      }, delay);
    };

    ws.addEventListener('close', scheduleReconnect);
    ws.addEventListener('error', scheduleReconnect);
  }

  function sendSignal(payload) {
    ws?.send(JSON.stringify({ type: 'signal', payload: { ...payload, __epoch: epoch } }));
  }

  function attachDataChannel(channel) {
    dc = channel;
    dc.bufferedAmountLowThreshold = DRAIN_LOW;   // [추가] backpressure 임계치
    dc.onopen = () => {
      log('DataChannel open');
      flushSendQueue();
      startKeepalive();
      // 재입장/최초연결 모두에서 상대에게 존재 알림
      sendJSON({ type: 'hello', id: selfId, t: Date.now(), epoch }); // [epoch 추가]

      // ✅ 미확인 중요 메시지 즉시 재전송
      for (const [seq, item] of pendingRel) {
        if (item.timer) { clearTimeout(item.timer); item.timer = null; }
        item.tries = 0;
        // 최신 epoch로 래핑해서 전송
        item.env = makeEnv(item.env.type, item.env.data, seq);
        sendEnv(item.env);
        scheduleRetry(seq);
      }
    };
    dc.onmessage = (e) => {
      let data = e.data;
      try { data = JSON.parse(data); } catch { /* 문자열이면 기존 로그 유지 */ };
      lastSeen = Date.now();

      // ✅ Reliable 프레이밍 처리 (ack/seq)
      if (data && data.v === 1) {
        if (data.kind === 'ack' && typeof data.ack === 'number') {
          const it = pendingRel.get(data.ack);
          if (it) { if (it.timer) clearTimeout(it.timer); pendingRel.delete(data.ack); }
          return;
        }
        if (data.kind === 'r' && typeof data.seq === 'number') {
          sendAck(data.seq);                 // 수신 확인(기존)
          if (!markSeen(data.seq)) return;   // 중복 차단(기존)

          // ✅ 청크 프레이밍 처리
          if (data.type === 'chunk' && data.data && typeof data.data.mid === 'string') {
            const { mid, type: origType, idx, total, part } = data.data;
            let rec = reassemble.get(mid);
            if (!rec) {
              rec = { type: origType, total, parts: [], count: 0 };
              reassemble.set(mid, rec);
            }
            if (rec.parts[idx] == null) {
              rec.parts[idx] = part;
              rec.count++;
            }
            if (rec.count >= rec.total) {
              const text = rec.parts.join('');
              reassemble.delete(mid);
              let obj = text;
              try { obj = JSON.parse(text); } catch {}
              if (typeof onReliableHandler === 'function') {
                onReliableHandler({ type: rec.type, data: obj });
              }
            }
            return; // 청크는 여기서 종료
          }

          if (typeof onReliableHandler === 'function') {
            onReliableHandler({ type: data.type, data: data.data });
          }
          return;
        }
      }

      // --- keepalive 프로토콜 ---
      if (data && data.type === 'ka-ping') {    // 핑 받으면 퐁
        sendJSON({ type: 'ka-pong', t: Date.now() });
        return;
      }
      if (data && data.type === 'ka-pong') {    // 퐁 받으면 타임스탬프만 갱신
        return;
      }

      // --- 동기화 프로토콜 ---
      if (data && data.type === 'hello') {
        if (remoteEpoch === null && typeof data.epoch !== 'undefined') remoteEpoch = data.epoch;
        // 항상 polite 측만 초기 상태를 1회 전송 (중복 방지의 간단한 규칙)
        if (isPolite && typeof getSyncState === 'function') {
          const state = getSyncState();
          // null/undefined면 전송 생략
          if (state !== undefined) sendJSON({ type: 'sync', state, t: Date.now() });
        }
        return;
      }
      if (data && data.type === 'sync') {
        if (typeof applyRemoteSync === 'function') {
          applyRemoteSync(data.state);
        } else {
          log('Sync received:', data.state);
        }
        return;
      }

      // --- 기존 일반 메시지 처리 ---
      log('DataChannel message:', data);
    };
    dc.onclose = () => {
      log('DataChannel closed');
      stopKeepalive();
    }
  }

  function newPeerConnection() {
    if (pc) try { pc.close(); } catch {}
    pc = new RTCPeerConnection(RTC_CONFIG);

    earlyIce = []; // ← 새 PC마다 초기화

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        candBatch.push(candidate);
        if (!candTimer) {
          candTimer = setTimeout(() => {
            candTimer = null;
            flushCandBatch();
          }, CAND_BATCH_MS);
        }
      } else {
        // null: gathering complete → 남은 배치 즉시 전송
        if (candTimer) { clearTimeout(candTimer); candTimer = null; }
        flushCandBatch();
        // (선택) 완료 신호를 보내고 싶으면 다음 한 줄을 켜세요.
        // sendSignal({ iceGatheringComplete: true });
      }
    };

    pc.ondatachannel = (e) => {
      if (!dc) attachDataChannel(e.channel);
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      log('state:', st);

      if (st === 'failed') {
        clearTimeout(iceRestartTimer);
        iceRestartTimer = null;
        // 즉시 ICE 재시작 시도
        maybeIceRestart('failed');
      } else if (st === 'disconnected') {
        // 짧은 글리치면 자연 회복될 수 있으므로 2초 대기 후 재시작
        clearTimeout(iceRestartTimer);
        iceRestartTimer = setTimeout(() => maybeIceRestart('disconnected-2s'), 2000);
      } else if (st === 'connecting' || st === 'connected') {
        // 회복 중/완료 → 타이머 정리
        clearTimeout(iceRestartTimer);
        iceRestartTimer = null;
      }
    };

    pc.onnegotiationneeded = async () => {
      requestNegotiation('onnegotiationneeded');
    };

    pc.onsignalingstatechange = () => {
      // stable로 돌어왔고 보류 중이라면 한 번 더 시도
      if (pc.signalingState === "stable" && needsNegotiation) {
        requestNegotiation("stable-retry")
      }
    }
  }

  async function handleSignal({ description, candidate, candidates, __epoch /*, iceGatheringComplete */ }) {
    // --- epoch 필터 (없으면 호환 위해 통과)
    if (typeof __epoch !== 'undefined') {
      if (remoteEpoch === null) remoteEpoch = __epoch;
      else if (__epoch !== remoteEpoch) { log('Drop stale signal from epoch', __epoch, 'expect', remoteEpoch); return; }
    }

    try {
      if (description) {
        const readyForOffer =
          !makingOffer && (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);
        const offerCollision = description.type === 'offer' && !readyForOffer;

        // impolite(=제안자)는 glare시 상대 offer를 무시 -> polite가 롤백·수용
        ignoreOffer = !isPolite && offerCollision;
        if (ignoreOffer) {
          log('Glare: ignoring remote offer (impolite).');
          return;
        }

        // ✅ 추가: polite는 충돌이면 먼저 rollback
        if (isPolite && offerCollision) {
          try {
            await pc.setLocalDescription({ type: 'rollback' });
            log('Performed rollback (polite) before applying remote offer.');
          } catch (e) {
            console.warn('rollback failed (polite)', e);
          }
        }

        isSettingRemoteAnswerPending = (description.type === 'answer');
        await pc.setRemoteDescription(description);
        isSettingRemoteAnswerPending = false;

        if (description.type === 'offer') {
          // 상대가 offer를 줬다면 answer
          await pc.setLocalDescription(await pc.createAnswer());
          sendSignal({ description: pc.localDescription });
        }

        // ✅ 원격 SDP가 설정된 뒤에 Early ICE 비우기
        if (pc.remoteDescription && earlyIce.length) {
          const queued = earlyIce;
          earlyIce = [];
          for (const c of queued) await safeAddIce(c);
        }
      } else if (Array.isArray(candidates) && candidates.length) {
        // ✅ 배치 후보 처리
        for (const c of candidates) {
          if (!pc.remoteDescription || isSettingRemoteAnswerPending) {
            earlyIce.push(c);
          } else {
            if (ignoreOffer) continue;
            await safeAddIce(c);
          }
        }
        return;

      } else if (candidate) {
        // (단일 후보: 과거 호환)
        if (!pc.remoteDescription || isSettingRemoteAnswerPending) { earlyIce.push(candidate); return; }
        if (ignoreOffer) return;
        await safeAddIce(candidate);
      }
    } catch (err) {
      console.error('handleSignal error', err);
    }
  }

  function handleRole({ isPolite: polite, shouldOffer: offerNow, peerReady }) {
    // 새 접속/재접속 시마다 새 RTCPeerConnection으로 깔끔히 시작
    isPolite = polite;
    shouldOffer = offerNow;

    epoch = (epoch + 1) >>> 0;  // 새로고침/재-join 시 내 세션 번호 증가
    remoteEpoch = null;         // 상대 세션 번호는 처음 시그널 받을 때 채움

    newPeerConnection();

    if (!isPolite && shouldOffer) {
      // 두 번째(impolite, offer 담당)가 진입하면 DataChannel을 열어
      // negotiationneeded 이벤트를 트리거 → offer 생성
      const channel = pc.createDataChannel('game');
      attachDataChannel(channel);
    }

    // 첫 번째는 대기. 상대가 들어오면 ondatachannel로 채널을 받습니다.
    if (!dc && peerReady && !shouldOffer) {
      // (선택) 필요시 여기서도 안전하게 준비 로그만 남김
      log('Peer ready; waiting for remote offer/datachannel...');
    }
  }

  async function maybeIceRestart(reason) {
    // 항상 초기 제안자(shouldOffer=true)만 재시작을 시도 → 시그널링 충돌 방지
    if (!shouldOffer) return;
    if (!pc) return;
    if (pc.connectionState === 'connected') return;
    if (makingOffer || isSettingRemoteAnswerPending) return;
    if (pc.signalingState !== 'stable') return;

    const now = Date.now();
    if (now - lastIceRestart < ICE_RESTART_COOLDOWN) return;
    lastIceRestart = now;

    try {
      log('ICE restart:', reason);
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      sendSignal({ description: pc.localDescription });
    } catch (e) {
      console.error('ICE restart failed', e);
    }
  }

  function waitForOpen(timeout = SEND_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (dc && dc.readyState === 'open') return resolve();
      const t = setTimeout(() => reject(new Error('dc open timeout')), timeout);
      const onOpen = () => { clearTimeout(t); dc.removeEventListener('open', onOpen); resolve(); };
      if (!dc) return reject(new Error('no datachannel'));
      dc.addEventListener('open', onOpen, { once: true });
    });
  }

  function waitForDrain() {
    return new Promise((resolve) => {
      if (!dc) return resolve();
      if (dc.bufferedAmount <= DRAIN_LOW) return resolve();
      const handler = () => {
        if (dc.bufferedAmount <= DRAIN_LOW) {
          dc.removeEventListener('bufferedamountlow', handler);
          resolve();
        }
      };
      dc.addEventListener('bufferedamountlow', handler);
    });
  }

  async function flushSendQueue() {
    if (flushing) return;
    flushing = true;
    try {
      while (sendQueue.length) {
        // DC가 없거나 닫힘 → 나중에 onopen에서 재시도
        if (!dc || dc.readyState !== 'open') {
          try {
            await waitForOpen();
          } catch {
            break; // open 실패 -> 현재 while 루프만 종료. 채널이 다시 열리면 onopen 에서 flush 재개
          }
        }
        if (!dc || dc.readyState !== 'open') break;

        // backpressure: 버퍼가 높으면 조금 기다림
        if (dc.bufferedAmount > DRAIN_LOW) await waitForDrain();

        const item = sendQueue[0];
        try {
          dc.send(item.payload);
          sendQueue.shift(); // 성공 시 제거
        } catch (e) {
          // 전송 실패 → 재시도 스케줄
          if ((item.tries ?? 0) >= RETRY_LIMIT) {
            console.warn('send drop after retries', e);
            sendQueue.shift(); // 포기
          } else {
            item.tries = (item.tries ?? 0) + 1;
            const delay = BACKOFF_BASE * (2 ** (item.tries - 1));
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
    } finally {
      flushing = false;
    }
  }

  function enqueueSend(raw) {
    const payload = (typeof raw === 'string') ? raw : JSON.stringify(raw);
    sendQueue.push({ payload, tries: 0 });
    // 가능하면 즉시 flush 시도
    flushSendQueue();
  }

  async function safeAddIce(candidate) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      if (!ignoreOffer) console.error('addIceCandidate failed', err);
    }
  }

  function requestNegotiation(reason = 'onnegotiationneeded') {
    if (!shouldOffer) return;          // 초기 제안자만 협상 주도
    needsNegotiation = true;
    if (negTimer) clearTimeout(negTimer);
    negTimer = setTimeout(doNegotiation, NEG_DEBOUNCE);
  }

  async function doNegotiation() {
    if (!shouldOffer) return;
    if (!pc) return;
    // 안정 상태가 아니면 건너뛰되, needsNegotiation 플래그는 유지 → stable 시 재시도
    if (makingOffer || isSettingRemoteAnswerPending || pc.signalingState !== 'stable') return;

    try {
      makingOffer = true;
      needsNegotiation = false;
      await pc.setLocalDescription(await pc.createOffer());
      sendSignal({ description: pc.localDescription });
    } catch (e) {
      console.error('doNegotiation error', e);
    } finally {
      makingOffer = false;
    }
  }

  function flushCandBatch() {
    if (!candBatch.length) return;
    // 배열로 한 번에 전송
    sendSignal({ candidates: candBatch });
    candBatch = [];
  }

  function startKeepalive() {
    if (kaTimer) clearInterval(kaTimer);
    lastSeen = Date.now();
    kaTimer = setInterval(() => {
      // 핑 전송
      if (dc && dc.readyState === 'open') {
        sendJSON({ type: 'ka-ping', t: Date.now() });
      }
      // 유휴 감지 → 초기 제안자만 ICE 재시작 시도
      const idleFor = Date.now() - lastSeen;
      if (idleFor > KA_IDLE) {
        log(`DataChannel idle for ${idleFor}ms`);
        // shouldOffer=true (초기 제안자)에서만 재시작 시도 → 충돌 최소화
        maybeIceRestart?.('dc-idle');
        lastSeen = Date.now(); // 과도한 반복 방지
      }
    }, KA_INTERVAL);
  }
  function stopKeepalive() {
    if (kaTimer) { clearInterval(kaTimer); kaTimer = null; }
  }

  function makeEnv(type, payload, seq) {
    return { v: 1, kind: 'r', type, seq, data: payload, epoch, t: Date.now() };
  }
  function sendEnv(env) { sendJSON(env); }

  function scheduleRetry(seq) {
    const item = pendingRel.get(seq);
    if (!item) return;
    if (item.tries >= REL_RETRY) { pendingRel.delete(seq); return; }
    const delay = Math.min(REL_BASE * (2 ** item.tries), REL_MAX);
    item.tries++;
    item.timer = setTimeout(() => {
      // 최신 epoch 반영해 재전송
      const env = makeEnv(item.env.type, item.env.data, seq);
      item.env = env;
      sendEnv(env);
      scheduleRetry(seq);
    }, delay);
  }

  function sendReliable(type, payload) {
    const seq = txSeq++;
    const env = makeEnv(type, payload, seq);
    pendingRel.set(seq, { env, tries: 0, timer: null });
    sendEnv(env);
    scheduleRetry(seq);
  }

  function onReliable(fn) { onReliableHandler = fn; }

  function sendAck(seq) {
    sendJSON({ v: 1, kind: 'ack', ack: seq, epoch });
  }

  function markSeen(seq) {
    if (rxSeen.has(seq)) return false;
    rxSeen.add(seq);
    rxOrder.push(seq);
    if (rxOrder.length > RX_KEEP) {
      const old = rxOrder.shift();
      rxSeen.delete(old);
    }
    return true;
  }

  function sendLargeReliable(type, payload) {
    const text = (typeof payload === 'string') ? payload : JSON.stringify(payload);
    const total = Math.ceil(text.length / CHUNK_CHARS);
    const mid = `${epoch}-${txSeq}-${midSeq++}`;

    for (let i = 0; i < total; i++) {
      const part = text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
      // 청크 자체도 기존 신뢰 전송(ack/seq) 위에서 전송
      sendReliable('chunk', { mid, type, idx: i, total, part });
    }
  }

  // 크기에 따라 자동 선택 (작으면 기존 reliable, 크면 청크)
  function sendAutoReliable(type, payload) {
    const text = (typeof payload === 'string') ? payload : JSON.stringify(payload);
    if (text.length > CHUNK_THRESHOLD) return sendLargeReliable(type, payload);
    return sendReliable(type, payload);
  }

  connectWS();

  // connect(...) 내부 최하단 근처, connectWS() 호출 이후 아무 곳에 추가
  window.addEventListener('beforeunload', () => {
    try { ws?.close(1000, 'refresh'); } catch {}
    try { pc?.close(); } catch {}
  });

  // (선택) 모바일 사파리 등 대비
  window.addEventListener('pagehide', () => {
    try { ws?.close(1000, 'pagehide'); } catch {}
    try { pc?.close(); } catch {}
  });

  // 오프라인 되면 대기 중인 재접속 타이머를 취소 (불필요 트래픽/로그 억제)
  window.addEventListener('offline', () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    log('WS offline: cancel pending reconnect timer');
  });

  // 온라인 되면 즉시 재연결 시도 (이미 scheduleReconnect에서 online 대기 중일 수도 있음)
  window.addEventListener('online', () => {
    if (ws?.readyState !== WebSocket.OPEN && !reconnectTimer) {
      log('WS online: try reconnect immediately');
      connectWS();
    }
  });

  return {
    sendText, sendJSON,
    setSyncProvider, onRemoteSync,
    sendReliable, onReliable,
    sendLargeReliable, sendAutoReliable   // ← 추가
  };
};
