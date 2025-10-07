import "../../../scss/common.scss";
// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import {scheduleRefresh} from "../../common/refreshScheduler.js"

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
// scheduleRefresh();

// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
const ws = new WebSocket(WS_URL);

const $ = (id)=>document.getElementById(id);
const label = $('me');

// ?room=값 없으면 demo-room-1
const ROOM = new URL(location.href).searchParams.get('room') || 'demo-room-1';

let pc;                                // 내 피어 연결 객체
let makingOffer = false;                // 내가 Offer를 만드는 중인지 표시
let ignoreOffer = false;                // (impolite) 충돌 Offer는 무시할지
let isSettingRemoteAnswerPending = false; // 원격 Answer 적용 중인지
let POLITE = false;                     // B=true, A=false (joined에서 세팅)

let dc = null; // 내 데이터채널(송신측이 만들거나, 수신측에서 ondatachannel로 받거나)

// 상태 DOM 참조
const el = {
  conn: document.getElementById('conn'),
  sig:  document.getElementById('sig'),
  ice:  document.getElementById('ice'),
  dc:   document.getElementById('dc'),
};

// 화면에 현재 상태를 그려주는 아주 작은 함수
function renderStatus(){
  if (!el.conn) return; // 상태 DOM이 없으면 스킵
  el.conn.textContent = pc?.connectionState ?? '-';      // connected/disconnected/failed...
  el.sig.textContent  = pc?.signalingState ?? '-';       // stable/have-local-offer...
  el.ice.textContent  = pc?.iceConnectionState ?? '-';   // connected/disconnected/failed...
  el.dc.textContent   = dc?.readyState ?? '-';           // open/connecting/closed/-
}

function wireDC(ch){
  ch.onopen = ()=>{
    console.log('✅ game 채널 OPEN');
    // 데모용: 열린 뒤 바로 한 번 인사 보내기
    try { ch.send('hello from ' + (POLITE ? 'polite' : 'impolite')); } catch {};
    renderStatus();
  };
  ch.onmessage = (e)=> console.log('💬 recv:', e.data);
  ch.onclose = ()=> { console.log('🔌 game 채널 CLOSED'); renderStatus(); };
}

function setupPeer(){
  // 1) 피어 연결 생성 (공용 STUN 1개만: 데모용)
  pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.l.google.com:19302' }] });

  // 2) 내 ICE 후보가 생기면 상대에게 보냄(Trickle ICE)
  pc.onicecandidate = (ev)=>{
    if(ev.candidate) sendSignal({ candidate: ev.candidate });
  };

  // 3) 연결 상태 로그(디버깅)
  pc.onconnectionstatechange = ()=>{
    const s = pc.connectionState;
    console.log('connectionState:', s);
    renderStatus(); // 화면에 즉시 반영
    if (s === 'disconnected') console.log('ℹ️ 끊김 감지 → ICE Restart 버튼을 눌러보세요.');
    if (s === 'failed' || s === 'closed') { resetPeer('conn ' + s); setupPeer(); }
  };

  pc.onsignalingstatechange     = renderStatus;  // stable/have-remote-offer 등
  pc.oniceconnectionstatechange = renderStatus;  // ICE 상태 변화

  // 4) 필요 시 협상 시작(표준 절차)
  //    - 보통 B가 DataChannel을 먼저 만들면 이 이벤트가 자동 발생합니다(다음 단계에서 트리거).
  pc.onnegotiationneeded = async ()=>{
    try{
      makingOffer = true;                               // 지금 내가 Offer 만드는 중
      await pc.setLocalDescription(await pc.createOffer());
      sendSignal({ description: pc.localDescription }); // 서버→상대에게 릴레이
    }catch(err){
      console.error('onnegotiationneeded 실패', err);
    }finally{
      makingOffer = false;
    }
  };

  // 5) (다음 단계 대비) 상대가 채널을 만들면 내가 받게 됨
  pc.ondatachannel = (ev)=>{
    console.log('📦 상대가 보낸 데이터채널 수신:', ev.channel.label);
    dc = ev.channel;
    wireDC(dc); // 공통 배선 함수로 연결
    renderStatus(); // 채널 수신 직후 상태 반영
  };

  renderStatus(); // pc를 만든 직후 한 번 그려줌
}

// ——— 원격 SDP(offer/answer) 수신 처리 ———
async function handleRemoteDescription(desc){
  // 내가 "Offer 만들고 있는 중"이 아니고,
  // 시그널링 상태가 'stable' 이거나 '원격 Answer 적용 중'이면 "ready"
  const readyForOffer =
    !makingOffer && (pc.signalingState === 'stable' || isSettingRemoteAnswerPending);

  // 상대가 보낸 게 'offer'인데, 내가 아직 준비 안 됐다면 → 충돌
  const offerCollision = desc.type === 'offer' && !readyForOffer;

  // 내가 impolite(A)이고 충돌이면 → 그냥 무시
  ignoreOffer = !POLITE && offerCollision;
  if (ignoreOffer){
    console.log('⚠️ offer 충돌 → (impolite) 무시');
    return;
  }

  // ▼▼ 핵심 추가: polite(B)이고 offer 충돌이면, 내 로컬 offer를 롤백한 뒤 상대 offer 수락
  if (desc.type === 'offer'){
    try{
      if (offerCollision && POLITE){
        await pc.setLocalDescription({ type: 'rollback' }); // 내 미완성 offer 취소
      }
      await pc.setRemoteDescription(desc);                   // 상대 offer 수락
      await pc.setLocalDescription(await pc.createAnswer()); // 내 answer 생성/적용
      sendSignal({ description: pc.localDescription });      // answer 전송
    }catch(e){
      console.error('offer 처리 실패', e);
    }
    return; // offer 분기 종료
  }

  // answer 분기 (기존대로 유지)
  isSettingRemoteAnswerPending = (desc.type === 'answer');
  try{
    await pc.setRemoteDescription(desc);
  }catch(e){
    console.error('setRemoteDescription(answer) 실패', e);
    return;
  }finally{
    isSettingRemoteAnswerPending = false;
  }
}

// ——— 원격 ICE 후보 수신 처리 ———
async function handleRemoteCandidate(cand){
  try{
    await pc.addIceCandidate(cand);
  }catch(e){
    // 충돌 중 무시한 경우라면 오류를 삼킵니다.
    if (!ignoreOffer) console.error('addIceCandidate 실패', e);
  }
}

// === STEP 2C: 깨끗한 리셋 ===
function resetPeer(reason = '') {
  try { if (dc) dc.close(); } catch {}
  dc = null;
  if (pc) {
    pc.ondatachannel = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    try { pc.close(); } catch {}
  }
  pc = null;
  makingOffer = false;
  ignoreOffer = false;
  isSettingRemoteAnswerPending = false;
  console.log('🔁 resetPeer', reason);
  renderStatus(); // 리셋 후 화면 상태 초기화
}

ws.addEventListener('open',()=>{ label.textContent=`서버 연결됨 (room=${ROOM})`; });

ws.addEventListener('message', (e) => {
  let m; try{ m=JSON.parse(e.data);}catch{ return; }
  if (m.type==='joined') {
    label.textContent = `나는 ${m.slot} / polite=${m.polite} / room=${m.roomId}`;
    POLITE = m.polite; // B면 true, A면 false
    setupPeer();
    // ✅ 내가 "두 번째 입장"이면(=상대가 이미 있음) → 협상 트리거 1줄!
    if (m.otherReady) {
      dc = pc.createDataChannel('game'); // 이 한 줄이 Offer를 시작하게 만듭니다.
      wireDC(dc);                        // 아래 (C)에서 정의: 이벤트 배선
    }
    return;
  }
  else if (m.type==='room-full') { label.textContent='방이 가득 찼습니다.'; ws.close(); }
  else if (m.type==='peer-joined') label.textContent += ' | 상대 입장';
  else if (m.type==='peer-left') {
    label.textContent += ' | 상대 퇴장 → 재대기';
    resetPeer('peer-left');
    setupPeer(); // 새 상대가 들어오면(후입장자) 그쪽이 DC를 만들며 협상 재개
  }
  else if (m.type==='signal') {
    const p = m.payload;
    if (p?.description)      handleRemoteDescription(p.description); // SDP 수신 처리
    else if (p?.candidate)   handleRemoteCandidate(p.candidate);     // ICE 후보 처리
    return;
  }
});

ws.addEventListener('close',()=>{
  if(!/가득/.test(label.textContent)) label.textContent='연결 종료됨';
});

ws.addEventListener("error", () => {
  label.textContent='오류: 서버에 연결되지 않았습니다.';
});

window.sendSignal = (payload) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'signal', payload }));
};

// === STEP 2E: ICE Restart — 경로만 다시 찾기 (전체 리셋 없음) ===
async function iceRestart(){
  if (!pc) { console.log('pc 없음 → 새로 준비'); setupPeer(); }
  if (!pc) return;

  try {
    console.log('🔄 ICE Restart 시작');
    makingOffer = true; // 내가 offer 만드는 중 표시(충돌 감지용)
    await pc.setLocalDescription(await pc.createOffer({ iceRestart: true })); // 새 ICE로 offer
    sendSignal({ description: pc.localDescription }); // 상대에게 전송 → answer 받으면 새 경로 확정
  } catch (e) {
    console.error('ICE Restart 실패', e);
  } finally {
    makingOffer = false;
  }
}

const btn = document.getElementById('iceRestart');
if (btn) btn.onclick = () => iceRestart();      // 클릭 시 ICE 재시도
// 콘솔에서도 사용 가능하게
window.iceRestart = () => iceRestart();

// 재협상(iceRestart 없이) — 코덱/파라미터 갱신 등 필요 시 수동 트리거
async function renegotiate(){
  if (!pc) { setupPeer(); if (!pc) return; }
  try{
    makingOffer = true;                     // 충돌 감지를 위한 플래그
    await pc.setLocalDescription(await pc.createOffer()); // 일반 offer
    sendSignal({ description: pc.localDescription });     // 상대에게 전송
  }catch(e){
    console.error('renegotiate 실패', e);
  }finally{
    makingOffer = false;
    renderStatus();
  }
}

// 버튼/콘솔 연결
const btnRe = document.getElementById('renegotiate');
if (btnRe) btnRe.onclick = () => renegotiate();
window.renegotiate = renegotiate; // 콘솔에서 호출용
