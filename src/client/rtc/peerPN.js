export function createPeer({role, sendSignal, log, onNeedHardReset}) {
  const polite = role === 'polite';

  // ===== 내부 상태 =====
  let pc = null;
  let dc = null;

  // Perfect Negotiation 상태 플래그
  let makingOffer = false;
  let ignoreOffer = false;
  let isSettingRemoteAnswerPending = false;

  // DataChannel (impolite가 먼저 만드는 패턴을 기본으로)
  // 만약 충돌을 최소화하고 싶다면 impolite만 생성하도록 해도 되고,
  // 여기서는 양쪽 모두 ondatachannel을 수신하도록 둡니다.
  const sendQueue = [];
  let sending = false;
  const MAX_CHUNK = 16 * 1024; // 16KB (브라우저/네트워크 별 안전치)
  const MAX_BUFFERED = 4 * 1024 * 1024; // 4MB 이상이면 일시정지
  const RESUME_BUFFERED = 512 * 1024;   // 512KB 미만으로 내려가면 재개

  // threshold 설정: 낮을수록 빨리 재개됨
  const BUFFERED_LOW_THRESHOLD = RESUME_BUFFERED;
  // onopen 이후 설정 예정

  // ===== 자동 복구(autopilot) 상태 =====
  let autoTrying = false;
  let backoffMs = 500; // 초기 백오프(0.5s)
  const backoffMax = 15_000; // 최대 15s
  let autoTimer = null;
  let waitingDisconnectedTimer = null;
  let failCycles = 0; // 자동 복구 라운드 실패 누적
  const HARD_RESET_THRESHOLD = 3; // 3회 연속 실패 시 하드 리셋 권고

  // getStats 모니터링
  let statsTimer = null;

  // ===== RTCPeerConnection 생성/와이어링 =====
  function buildPC() {
    pc = new RTCPeerConnection({
      iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
    });

    pc.ondatachannel = (ev) => {
      if (dc) return; // 이미 있음
      dc = ev.channel;
      wireDC(dc, log);
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal({ candidate });
    };

    pc.onsignalingstatechange = () => log(`pc.signalingState = ${pc.signalingState}`);
    pc.oniceconnectionstatechange = () => {
      log(`pc.iceConnectionState = ${pc.iceConnectionState}`);
      handleIceState(pc.iceConnectionState);
    };
    pc.onconnectionstatechange = () => {
      log(`pc.connectionState = ${pc.connectionState}`);
      handleConnState(pc.connectionState);
    }

    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        sendSignal({ sdp: pc.localDescription });
        log('[negotiationneeded] localDescription 보냄 ->', pc.localDescription.type);
      } catch (e) {
        log('onnegotiationneeded error:', e.message);
      } finally {
        makingOffer = false;
      }
    };
  }

  // 최초 1회 생성
  buildPC();

  // ===== DC 유틸 =====
  function wireDC(channel) {
    dc = channel;
    dc.onopen = () => {
      dc.bufferedAmountLowThreshold = RESUME_BUFFERED;
      log('DataChannel open');
      pumpQueue();
    };
    dc.onclose = () => { log('DataChannel close'); };
    dc.onmessage = (ev) => { log(`DataChannel <= ${ev.data}`); };
    dc.onbufferedamountlow = () => { pumpQueue(); };
  }

  function enqueueSend(text) {
    // 큰 메시지는 청크로 분할
    const str = String(text);
    if (str.length <= MAX_CHUNK) {
      sendQueue.push(str);
    } else {
      for (let i = 0; i < str.length; i += MAX_CHUNK) {
        sendQueue.push(str.slice(i, i + MAX_CHUNK));
      }
    }
    pumpQueue();
  };

  function pumpQueue() {
    if (!dc || dc.readyState !== 'open') return;
    if (sending) return;
    sending = true;
    try {
      while (sendQueue.length) {
        if (dc.bufferedAmount > MAX_BUFFERED) break;
        const chunk = sendQueue.shift();
        dc.send(chunk);
      }
    } catch (e) {
      log('pumpQueue send error:', e.message);
    } finally {
      sending = false;
    }
  }

  // ===== 시그널 처리 =====
  async function handleSignal({ sdp, candidate }) {
    try {
      if (sdp) {
        const offerCollision =
          sdp.type === 'offer' &&
          (makingOffer || pc.signalingState !== 'stable' || isSettingRemoteAnswerPending);

        ignoreOffer = !polite && offerCollision;
        log(`수신 SDP: ${sdp.type}, offerCollision=${offerCollision}, ignoreOffer=${ignoreOffer}`);

        if (ignoreOffer) {
          // impolite이고 충돌이면 이 offer는 무시
          return;
        }

        if (polite && offerCollision) {
          // polite는 충돌 시 롤백 후 상대 offer 수용
          log('polite: rollback()');
          await Promise.allSettled([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(sdp)
          ]);
        } else {
          await pc.setRemoteDescription(sdp);
        }

        if (sdp.type === 'offer') {
          await pc.setLocalDescription();
          sendSignal({ sdp: pc.localDescription });
          log('answer 전송');
        } else {
          // answer 수신 처리 중에는 isSettingRemoteAnswerPending 보호
          isSettingRemoteAnswerPending = true;
          // (일부 브라우저 호환성 이슈 대응 자리 – 예시는 단순화)
          isSettingRemoteAnswerPending = false;
        };

        // sdp 교환이 정상적이면 백오프 초기화
        resetBackoff();
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
          log('원격 ICE 추가');
        } catch (err) {
          if (!ignoreOffer) throw err; // 무시 중이 아니면 에러 던짐
          // ignore 상황이면 무시
        }
      }
    } catch (e) {
      log('handleSignal error:', e.message);
      scheduleAutoRecovery(); // 시그널 처리 에러 시에도 회복 시도
    }
  };

  // ===== 자동 복구 로직 =====
  function handleIceState(state) {
    if (state === 'disconnected') {
      // 순간적인 네트워크 흔들림일 수 있으니 짧게 기다렸다 복구 시도
      if (waitingDisconnectedTimer) clearTimeout(waitingDisconnectedTimer);
      waitingDisconnectedTimer = setTimeout(() => {
        log('[auto] disconnected 지속 → restartIce() 시도');
        tryRestartIce();
      }, 1200); // 1.2s 정도 대기 후
    } else if (state === 'failed') {
      // 보다 강력한 복구 필요
      log('[auto] ICE failed → 지수 백오프 기반 복구 스케줄');
      scheduleAutoRecovery(true);
    } else if (state === 'connected' || state === 'completed') {
      // 연결 회복: 백오프 초기화
      resetBackoff();
      if (waitingDisconnectedTimer) {
        clearTimeout(waitingDisconnectedTimer);
        waitingDisconnectedTimer = null;
      }
    }
  };

  function handleConnState(state) {
    if (state === 'failed' || state === 'closed') {
      log(`[auto] connectionState=${state} → 복구 스케줄`);
      scheduleAutoRecovery(true);
    } else if (state === 'connected') {
      resetBackoff();
    }
  };

  function tryRestartIce() {
    try {
      pc.restartIce();
      log('pc.restartIce() 호출(자동)');
    } catch (e) {
      log('restartIce error:', e.message);
    }
  };

  function scheduleAutoRecovery(force = false) {
    if (autoTrying && !force) return;
    if (autoTimer) clearTimeout(autoTimer);

    autoTrying = true;
    const wait = backoffMs;
    log(`[auto] ${wait}ms 후 복구 시도 예정`);
    autoTimer = setTimeout(async () => {
      autoTimer = null;
      try {
        // 1) 우선 restartIce()
        tryRestartIce();

        // 2) 여전히 signalingState가 stable이 아니거나,
        //    경로가 비정상으로 보이면 재협상 한 번 유도
        if (pc.signalingState === 'stable') {
          // 필요할 때만 offer 생성: 트랙/채널 변경 없더라도 링크 갱신 도움
          await pc.setLocalDescription();
          sendSignal({ sdp: pc.localDescription });
          log('[auto] 재협상 offer 전송');
        }
      } catch (e) {
        log('[auto] 복구 시도 중 에러:', e.message);
      } finally {
        // 실패 라운드 누적
        failCycles += 1;
        log(`[auto] 누적 실패 라운드: ${failCycles}`);
        if (failCycles >= HARD_RESET_THRESHOLD) {
          log('[auto] 자동 복구 반복 실패 → 하드 리셋 권고');
          onNeedHardReset?.(); // 외부(Main)에서 pc를 통째로 새로 만들도록 요청
          // 내부적으로는 backoff를 리셋하고 더 시도하지 않음
          resetBackoff(false);
          return;
        }
        // 백오프 증가 (최대 제한)
        backoffMs = Math.min(backoffMs * 2, backoffMax);
        // 다음 라운드도 준비 (연결 회복되면 resetBackoff가 해제)
        autoTrying = false;
      }
    }, wait);
  }

  function resetBackoff() {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    autoTrying = false;
    backoffMs = 500;
    if (resetFail) failCycles = 0;
    log('[auto] 백오프 초기화');
  };

  // ===== 외부 노출 API =====
  // 상대가 들어왔을 때(=count===2)에만 호출
  function start() {
    // impolite만 초기 DataChannel 생성 → onnegotiationneeded 유도
    if (!polite && !dc) {
      dc = pc.createDataChannel('chat', { ordered: true });
      wireDC(dc);
      log('(impolite) DataChannel 생성 → onnegotiationneeded 유도');
    }
  }

  // 수동 재협상: 현재 상태를 기준으로 새 offer 생성/전송
  async function renegotiate() {
    try {
      log('수동 재협상 시작');
      await pc.setLocalDescription();           // 필요 시 offer 생성
      sendSignal({ sdp: pc.localDescription });
      log('수동 재협상: localDescription 전송 완료');
    } catch (e) {
      log('renegotiate error:', e.message);
    }
  };

  // ICE 재시작: candidate 재수집과 경로 재탐색 시도
  function restartIce() {
    try {
      pc.restartIce();
      log('pc.restartIce() 호출(수동)');
      // 필요하면 수동 재협상과 함께 써도 좋음
    } catch (e) {
      log('restartIce error:', e.message);
    }
  };

  // 외부에서 메시지 보내기 위해 노출
  function send(text) {
    if (!dc || dc.readyState !== 'open') return false;
    enqueueSend(text);
    return true;
  };

  // 안전 정리 (탭 닫힘/방 나감 시)
  function close() {
    try { dc?.close(); } catch {}
    pc.getSenders().forEach(s => { try { pc.removeTrack(s); } catch {} });
    try { pc.close(); } catch {}
    if (autoTimer) clearTimeout(autoTimer);
    if (waitingDisconnectedTimer) clearTimeout(waitingDisconnectedTimer);
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    log('peer closed');
  };

  // 하드 리셋(내부 PC 재생성) - 필요 시 Main에서 새 인스턴스를 만드는 쪽을 권장
  function hardResetInside() {
    log('[HARD] 내부 하드 리셋: RTCPeerConnection 재생성');
    close();
    // 플래그/큐는 유지, 새 PC를 만들어 재와이어링
    // (보수적으로는 새 인스턴스를 만들도록 Main에 맡기는 게 안전)
    makingOffer = false;
    ignoreOffer = false;
    isSettingRemoteAnswerPending = false;
    buildPC();
  }

  // getStats 모니터링
  function startStats(intervalMs = 3000) {
    if (statsTimer) return;
    statsTimer = setInterval(async () => {
      try {
        const stats = await pc.getStats();
        // 선정된 candidate pair에서 RTT 등 확인
        let rtt = null, availableOut = null, bytesSent = 0, bytesRecv = 0, packetsLost = 0;

        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
            rtt = report.currentRoundTripTime;
            availableOut = report.availableOutgoingBitrate;
          }
          if (report.type === 'data-channel') {
            // 참고용: datachannel 상태/라벨 등
          }
          if (report.type === 'transport') {
            // 참고용
          }
          if (report.type === 'outbound-rtp') {
            if (typeof report.bytesSent === 'number') bytesSent += report.bytesSent;
            if (typeof report.packetsLost === 'number') packetsLost += report.packetsLost;
          }
          if (report.type === 'inbound-rtp') {
            if (typeof report.bytesReceived === 'number') bytesRecv += report.bytesReceived;
            if (typeof report.packetsLost === 'number') packetsLost += report.packetsLost;
          }
        });

        log(`[stats] rtt=${rtt ?? '-'}s, outBw≈${availableOut ? Math.round(availableOut/1000) + 'kbps' : '-'}, bytesSent=${bytesSent}, bytesRecv=${bytesRecv}, packetsLost=${packetsLost}`);
      } catch (e) {
        log('[stats] error: ' + e.message);
      }
    }, intervalMs);
    log(`[stats] ${intervalMs}ms 주기로 모니터링 시작`);
  }

  function stopStats() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; log('[stats] 중지'); }
  }

  return {
    // 기존 API
    handleSignal, start, renegotiate, restartIce, send, close,
    // 추가 API
    hardResetInside, startStats, stopStats
  };
};
