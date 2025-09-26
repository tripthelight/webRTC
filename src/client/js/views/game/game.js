import {Signaling} from '../../../ws/signaling.js';
import {createManualPeer} from '../../../rtc/manualPeer.js';
import {createPeer} from '../../../rtc/peerPN.js';

// 최소한의 clientId 생성기(crypto.randomUUID()우선)
function makeClientId() {
  // 1) 가능하면 표준 UUID
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  // 2) 안전한 난수 16바이트
  const bytes = new Uint8Array(16);

  // 핵심: 메서드 분리 호출 금지! 반드시 객체를 통해 호출
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes); // ✅ 바인딩 OK
    // // 아래처럼 호출해도 동작합니다:
    // globalThis.crypto.getRandomValues.call(globalThis.crypto, bytes);
  } else {
    // 폴백
    for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
  }

  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

const clientId = makeClientId();
console.log('[client] my clientId:', clientId);

const SIGNALING_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
const ws = new WebSocket(SIGNALING_URL);

ws.addEventListener('open', () => {
  console.log('[client] ws open');

  // Step 2 테스트용: 간단한 hello 브로드캐스트
  ws.send(JSON.stringify({
    type: 'hello',
    from: clientId,
    t: Date.now()
  }));
});

ws.addEventListener('message', async (e) => {
  // 서버가 텍스트로 보내므로 string 보장됨(그래도 안전하게 Blob 처리)
  const text = typeof e.data === 'string' ? e.data : await e.data.text();

  // JSON 안전 파싱
  let msg;
  try { msg = JSON.parse(text); }
  catch { console.log('[client] ws message(text):', text); return; }

  // 로그 표시
  console.log('[client] ws message(json):', msg);

  // Step 2 검증 포인트:
  // - 내가 보낸 건 서버가 "보낸 사람 제외"이므로 안 돌아옴
  // - 다른 탭/브라우저에서 보내면 여기에 찍힘
});

ws.addEventListener('close', () => {
  console.log('[client] ws closed');
});

ws.addEventListener('error', (err) => {
  console.log('[client] ws error', err);
});
