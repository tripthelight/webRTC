import PerfectNegotiator from "../../common/PerfectNegotiator.js";

const servers = {
  iceServers: [
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
};

// ====== 간단 UI ======
const $ = (q) => document.querySelector(q);
const logBox = $('#log');
const roleSpan = $('#role');
const stateSpan = $('#state');
const peerSpan = $('#peer');
const input = $('#input');
const sendBtn = $('#send');

const log = (s) => {
  const line = document.createElement('div');
  line.textContent = s;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
};

// ====== 파라미터/ID ======
function getParam(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}
function getOrCreateClientId() {
  let id = localStorage.getItem('clientId');
  if (!id) {
    id = (crypto.randomUUID?.() || Math.random().toString(36).slice(2));
    localStorage.setItem('clientId', id);
  }
  return id;
}

const roomName = getParam('room') || 'demo-room';
const myClientId = getOrCreateClientId();
document.title = `room=${roomName} / me=${myClientId.slice(0,8)}`;

// ====== 역할 조회 HTTP 함수 ======
async function fetchRoleFromServer(room, clientId) {
  const res = await fetch(`/api/rooms/${encodeURIComponent(room)}/role?clientId=${encodeURIComponent(clientId)}`, {
    credentials: 'include'
  });
  if (!res.ok) throw new Error(`role http ${res.status}`);
  return res.json(); // { polite, dcOwner, peerClientId }
}

// ====== WebSocket (시그널) ======
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${wsProto}://${location.host}/ws`);

let pn = null;
let currentPeerId = null;

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'hello', roomName, clientId: myClientId }));
});

ws.addEventListener('message', async (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  if (msg.type === 'hello:ack') {
    log(`[ws] joined room=${msg.roomName} as ${msg.clientId}`);
    await initOrRefreshRole(); // 내 현재 역할 정보 로드(상대가 없으면 peer=null)
    return;
  }

  if (msg.type === 'room:members') {
    const peers = msg.members.filter((id) => id !== myClientId);
    const nextPeer = peers[0] || null; // 2인 룸 가정
    peerSpan.textContent = nextPeer ? nextPeer.slice(0, 8) : '없음';

    // 상대가 바뀌거나 새로 들어왔으면 역할 재조회 & PN 갱신
    if (nextPeer !== currentPeerId) {
      currentPeerId = nextPeer;
      await initOrRefreshRole();
    }
    return;
  }

  if (msg.type === 'signal') {
    const { payload } = msg;
    if (!pn) return;
    if (payload.kind === 'sdp') {
      await pn.onRemoteDescription(payload.data);
    } else if (payload.kind === 'ice') {
      await pn.onRemoteIceCandidate(payload.data);
    }
    return;
  }
});

// 시그널 송신 헬퍼
function sendSignal(payload) {
  if (!currentPeerId) return; // 상대 없음
  ws.send(JSON.stringify({
    type: 'signal',
    to: currentPeerId,
    payload // { kind:'sdp'|'ice', data:... }는 아래 PerfectNegotiator에서 래핑
  }));
}

// PN이 보낼 실제 포맷 어댑터
function pnSendAdapter(msg) {
  if (msg.type === 'sdp') {
    sendSignal({ kind: 'sdp', data: msg.sdp });
  } else if (msg.type === 'ice') {
    sendSignal({ kind: 'ice', data: msg.candidate });
  }
}

// 역할 정보 가져와 PN 초기화/갱신
async function initOrRefreshRole() {
  const role = await fetchRoleFromServer(roomName, myClientId);
  roleSpan.textContent = `polite=${role.polite ? 'T' : 'F'}, owner=${role.dcOwner ? 'T' : 'F'}`;

  if (!pn) {
    pn = new PerfectNegotiator({
      clientId: myClientId,
      peerClientId: role.peerClientId || currentPeerId || null,
      role,
      sendSignal: pnSendAdapter,
      rtcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
      dcLabel: 'game',
      log: (s) => { log(s); refreshState(); }
    });

    // 메시지 핸들러 연결
    const bindDcHandlers = () => {
      if (!pn?.dc) return;
      pn.dc.onmessage = (e) => log(`[받음] ${e.data}`);
    };
    // DC가 생기거나 열릴 때마다 바인딩
    const obs = new MutationObserver(() => bindDcHandlers());
    // 단순 트릭: 상태 span 변경을 트리거로 감시(실전에서는 이벤트/프로퍼티 감시 로직을 별도로 두세요)
    obs.observe(stateSpan, { characterData: true, childList: true, subtree: true });
    bindDcHandlers();
  } else {
    pn.setRole(role);
    pn.setPeer(role.peerClientId || currentPeerId || null);
  }

  refreshState();
}

function refreshState() {
  const s = pn?.pc?.connectionState || 'idle';
  const dcS = pn?.dc?.readyState || '-';
  stateSpan.textContent = `pc=${s}, dc=${dcS}`;
}

// 전송 버튼
sendBtn.addEventListener('click', () => {
  const text = input.value.trim();
  if (!text) return;
  if (!pn?.dc || pn.dc.readyState !== 'open') {
    log('❌ dataChannel이 열려있지 않습니다.');
    return;
  }
  pn.dc.send(text);
  log(`[보냄] ${text}`);
  input.value = '';
});

// 주기적 상태 표시(디버그)
setInterval(refreshState, 500);
