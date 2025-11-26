import { ackUntil, handleReliableReceive, rawSend } from "../../connectSignaling.js"
import deliverToGame from "./deliverToGame.js"

export default function handleEnvelope(env) {
  if (!env || env.v !== 1 || !env.t) return;

  // 상대가 동봉해 온 ack를 처리 (outbox 정리)
  if (typeof env.ack === 'number') {
    ackUntil(env.ack);
  }

  // ✅ [패치] 타입 분기 전에: seq가 있다면 "신뢰/순서 보장"으로 우선 처리
  if (typeof env.seq === 'number' && env.t !== 'ACK') {
    // ACK 자체는 제어 신호라 제외
    return handleReliableReceive(env); // 내부에서 deliverToGame(env.payload, {reliable:true, seq}) 호출
  }

  switch (env.t) {
    case 'ACK': {
      // 단독 ACK 타입도 지원(현재는 MSG에 동봉 ack로 충분)
      if (typeof env.seq === 'number') ackUntil(env.seq);
      break;
    }
    case 'PING': {
      // PING 수신 → 곧바로 PONG 회신(내 ack 포함)
      rawSend({ v: 1, t: 'PONG', ts: Date.now() });
      break;
    }
    case 'PONG': {
      // PONG → RTT 측정
      if (LAST_PING_TS) {
        LAST_RTT_MS = Date.now() - LAST_PING_TS;
        log(`RTT ~ ${LAST_RTT_MS} ms`);
      }
      break;
    }
    case 'HELLO': {
      // 새 세션 인사: 필요하면 내 상태 스냅샷 전달
      // rawSend({ v:1, t:'STATE', payload:getCurrentGameSnapshot() });
      break;
    }
    case 'STATE': {
      // 전체 상태 스냅샷 수신 → 로컬 UI/상태 갱신
      // applyGameSnapshot(env.payload);
      break;
    }
    case 'MSG': {
      // --- 신뢰/순서 보장 수신 ---
      /* if (typeof env.seq === 'number') {
        handleReliableReceive(env);
      } else {
        // 비신뢰/무순서 수신(예: 단순 입력) → 즉시 전달
        deliverToGame(env.payload, { unreliable: true });
      } */
      // 여기까지 온 MSG는 seq가 없으므로 "비신뢰" 취급
      deliverToGame(env.payload, { unreliable: true });
      break;
    }
  }
}
