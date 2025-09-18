import {createSignaling} from '../../../ws/signaling.js';

const room = new URL(location.href).searchParams.get('room') || 'test';
log(`[STEP 3] room=${room} 웹소켓 연결 시도`);

const signaling = createSignaling(room);
await signaling.waitOpen();
log('[STEP 3] WS 연결됨');

signaling.onMessage(msg => {
  log(`[WS recv] ${JSON.stringify(msg)}`);
});

// 테스트 버튼 없이도, 2초 후에 한 번 메시지를 릴레이 테스트
setTimeout(() => {
  signaling.send({ping: Date.now()});
  log(`[WS send] {"ping" : ... }`);
}, 2000);

function log(s) {
  console.log(s);
  let el = document.getElementById('log');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'log';
    el.style.whiteSpace = 'pre-wrap';
    el.style.background = '#111';
    el.style.color = '#ddd';
    el.style.padding = '12px';
    el.style.height = '240px';
    el.style.overflow = 'auto';
    document.body.appendChild(el);
  }
  el.textContent += s + '\n';
  el.scrollTop = el.scrollHeight;
}
