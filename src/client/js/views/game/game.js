// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import { scheduleRefresh } from "../../common/refreshScheduler.js"

// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
const ws = new WebSocket(WS_URL);

const roomId = "my-room-1"; // 테스트옹. 실제로는 URL/서버가 주는 값 사용

let pc;
let polite = true; // 서버에서 role 받기 전 기본값(임시)
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;

let dc = null;
const pendingCandidates = []; // ICE 후보 버퍼

function log(...a){ console.log('[RTC]', ...a); }

// [+] 통계 수집 보조 변수
let statsTimer = null;
let lastStats = null;

// [+] 통계 수집 시작/중지
function startStats() {
  stopStats();
  statsTimer = setInterval(async () => {
    if (!pc) return;
    try {
      const reports = await pc.getStats();
      let now = performance.now();

      let bytesSent = 0, bytesRecv = 0;
      let packetsRecv = 0, packetsLostIn = 0;
      let rtt = null;

      reports.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
          if (typeof r.currentRoundTripTime === 'number') rtt = r.currentRoundTripTime; // sec
        }
        if (r.type === 'outbound-rtp' && !r.isRemote) {
          if (typeof r.bytesSent === 'number') bytesSent += r.bytesSent;
        }
        if (r.type === 'inbound-rtp' && !r.isRemote) {
          if (typeof r.bytesReceived === 'number') bytesRecv += r.bytesReceived;
          if (typeof r.packetsReceived === 'number') packetsRecv += r.packetsReceived;
          if (typeof r.packetsLost === 'number')     packetsLostIn += r.packetsLost;
        }
      });

      if (lastStats) {
        const dt = (now - lastStats.ts) / 1000; // sec
        if (dt > 0.001) {
          const upKbps   = ( (bytesSent - lastStats.bytesSent) * 8 / dt ) / 1000;
          const downKbps = ( (bytesRecv - lastStats.bytesRecv) * 8 / dt ) / 1000;
          const dRecvPk  = (packetsRecv - lastStats.packetsRecv);
          const dLostPk  = (packetsLostIn - lastStats.packetsLostIn);
          const lossInPct = (dRecvPk + dLostPk) > 0 ? (dLostPk / (dRecvPk + dLostPk)) * 100 : 0;

          log(
            `STATS: up=${upKbps.toFixed(0)}kbps, down=${downKbps.toFixed(0)}kbps, ` +
            `rtt=${rtt ? (rtt * 1000).toFixed(0) + 'ms' : 'n/a'}, lossIn=${lossInPct.toFixed(1)}%`
          );
        }
      }
      lastStats = { ts: now, bytesSent, bytesRecv, packetsRecv, packetsLostIn };
    } catch (e) {
      console.warn('getStats 실패:', e);
    }
  }, 2000);
}
function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  lastStats = null;
}

// [+] ICE 재시작 보조 변수
let iceRestartTimer = null;
const ICE_RESTART_DELAY = 1200; // ms

function send(msg) {
  ws.readyState === WebSocket.OPEN
    ? ws.send(JSON.stringify(msg))
    : ws.addEventListener('open', () => ws.send(JSON.stringify(msg)), { once: true });
}

function bindDataChannel(channel) { // [+] 공통 바인딩
  dc = channel;
  dc.onopen = () => log('DataChannel open ========================== ');
  dc.onmessage = (e) => log('DataChannel msg <=', e.data);
  dc.onclose = () => log('DataChannel close');
}

// [+] 끊김 시 임폴라이트가 재시작 오퍼 1회 시도
async function tryIceRestart() {
  if (polite) { log('polite => ICE restart는 대기'); return; }
  if (!pc) return;
  if (pc.signalingState !== 'stable') {
    log('ICE restart 보류: signalingState=', pc.signalingState);
    return;
  }
  try {
    makingOffer = true;
    await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
    send({ type: 'desc', desc: pc.localDescription });
    log('impolite => ICE restart offer 전송');
  } catch (err) {
    console.error('ICE restart 실패:', err);
  } finally {
    makingOffer = false;
  }
}
function scheduleIceRestart() {                // [+]
  if (iceRestartTimer) return;
  iceRestartTimer = setTimeout(() => {
    iceRestartTimer = null;
    tryIceRestart();
  }, ICE_RESTART_DELAY);
}
function cancelIceRestart() {                  // [+]
  if (iceRestartTimer) {
    clearTimeout(iceRestartTimer);
    iceRestartTimer = null;
  }
}

function createPC() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: 'candidate', candidate: e.candidate });
    }
  };

  // [+] polite(=첫 입장)는 채널을 만들지 않고, 상대 채널을 "받기만" 한다
  pc.ondatachannel = (e) => {
    log('ondatachannel');
    bindDataChannel(e.channel);
  };

  // 핵심: Perfect Negotiation 기본 가드
  pc.onnegotiationneeded = async () => {
    try {
      // offer 시작은 impolite만(= 두 번째 입장자)
      if (polite) {
        log('polite => onnegotiationneeded 무시');
        return;
      }
      makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer());
      send({ type: 'desc', desc: pc.localDescription });
      log('impolite => offer 전송');
    } catch (err) {
      console.error(err);
    } finally {
      makingOffer = false;
    }
  };

  pc.onconnectionstatechange = () => {
    log('pc.connectionState =', pc.connectionState);
    // [+] 실패/연결끊김 시 재시작 예약, 연결되면 취소
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      scheduleIceRestart();
      stopStats(); // 끊기면 통계 중지
    } else if (pc.connectionState === 'connected' || pc.connectionState === 'completed') {
      cancelIceRestart();
      startStats(); // 연결되면 자동 통계 시작
    } else if (pc.connectionState === 'closed') {
      stopStats();
    }
  };

  // [+] iceConnectionState도 함께 관찰(브라우저별 차이 대비)
  pc.oniceconnectionstatechange = () => {
    log('pc.iceConnectionState =', pc.iceConnectionState);
    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
      scheduleIceRestart();
    } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      cancelIceRestart();
    }
  };

  return pc;
}

// --- WS 수신 처리 ---
ws.addEventListener('open', () => {
  send({ type: 'join', roomId });
});

ws.addEventListener('message', async (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === 'role') {
    polite = !!msg.polite;
    log('역할 배정:', { polite });
    if (!pc) createPC();
    return;
  }

  if (msg.type === 'ready') {
    log('상대 입장 완료: 협상 가능');
    // [+] 두 명이 모두 입장했을 때만 impolite가 DataChannel 생성 → onnegotiationneeded 트리거
    if (!polite && !dc) {
      const channel = pc.createDataChannel('game');  // ← 핵심: 이제 'ready'에서만 생성
      bindDataChannel(channel);
      dc.onopen = () => {
        log('DataChannel open ========================== ');
        dc.send('hello from impolite');
      };
    }
    return;
  }

  if (msg.type === 'candidate') {
    // remote SDP 설정 전에는 후보를 버퍼에 쌓아두었다가, 이후 일괄 적용
    if (!pc.remoteDescription) {
      pendingCandidates.push(msg.candidate);
      log("candidate 버퍼링")
    } else {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (err) {
        console.warn('addIceCandidate 경고:', err);
      }
    }
    return;
  }

  if (msg.type === 'desc') {
    const desc = msg.desc;
    const readyForOffer =
      !makingOffer &&
      (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);

    const offerCollision = desc.type === 'offer' && !readyForOffer;

    ignoreOffer = !polite && offerCollision;
    if (ignoreOffer) {
      log('임폴라이트가 동시충돌 감지 -> offer 무시');
      return;
    }

    try {
      if (desc.type === 'answer') {
        isSettingRemoteAnswerPending = true;
      }
      await pc.setRemoteDescription(desc);
      isSettingRemoteAnswerPending = false;

      // [+] remote SDP가 설정되었으니, 버퍼된 후보를 일괄 적용
      if (pendingCandidates.length) {
        for (const c of pendingCandidates.splice(0)) {
          try { await pc.addIceCandidate(c); }
          catch (err) { console.warn('버퍼 후보 적용 경고:', err); }
        }
        log('버퍼 후보 적용 완료');
      }

      if (desc.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        send({ type: 'desc', desc: pc.localDescription });
        log('polite가 offer 수신 -> answer 전송');
      }
    } catch (err) {
      console.error('setRemoteDescription 실패:', err);
    }
  }
});

// [+] 테스트용 전역 함수: 버튼에서 호출
window.__sendPing = () => {
  if (dc && dc.readyState === 'open') {
    dc.send('PING');
    log('DataChannel msg => PING');
  } else {
    log('채널이 아직 open이 아님');
  }
};

// [+] 통계 수동 제어(원하면 사용)
window.__startStats = startStats;
window.__stopStats  = stopStats;

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
// scheduleRefresh();
