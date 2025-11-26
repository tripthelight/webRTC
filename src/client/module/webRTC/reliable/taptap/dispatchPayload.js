// -------------------- [핵심] 게임 이벤트 라우터 --------------------
// 컨벤션: payload = { type: '네임스페이스/이벤트', ... } 형태 권장
// 예) 'ROUND/START', 'ACTION/RAISE', 'STATE/SNAPSHOT', 'UI/EMOTE' 등

// 1) 개별 핸들러들(필요한 것만 먼저 구현하고 점진 확장)
const Handlers = {
  // --- 라운드/턴 제어(신뢰) ---
  'ROUND/START': (payload, meta) => {
    // payload: { type:'ROUND/START', seed:number, ante:number }
    // TODO: 라운드 시작 UI/상태 초기화
    console.log('[ROUND/START]', payload, meta);
  },
  'ROUND/END': (payload, meta) => {
    console.log('[ROUND/END]', payload, meta);
  },
  'TURN/SET': (payload, meta) => {
    // payload: { player:'A'|'B' }
    console.log('[TURN/SET]', payload, meta);
  },

  // --- 행동/베팅(신뢰) ---
  'ACTION/CHECK': (payload, meta) => {
    console.log('[ACTION/CHECK]', payload, meta);
  },
  'ACTION/CALL': (payload, meta) => {
    console.log('[ACTION/CALL]', payload, meta);
  },
  'ACTION/RAISE': (payload, meta) => {
    // payload: { amount:number }
    console.log('[ACTION/RAISE]', payload, meta);
  },
  'ACTION/FOLD' : (payload, meta) => {
    console.log('[ACTION/FOLD]', payload, meta);
  },

  // --- 카드/씨드(신뢰) ---
  'DECK/COMMIT': (payload, meta) => {
    // payload: { hash:string }
    console.log('[DECK/COMMIT]', payload, meta);
  },
  'DECK/REVEAL': (payload, meta) => {
    // payload: { seed:string }
    console.log('[DECK/REVEAL]', payload, meta);
  },
  'DEAL/CARD': (payload, meta) => {
    // payload: { to:'A'|'B', masked:string }
    console.log('[DEAL/CARD]', payload, meta);
  },

  // --- 칩/포트(신뢰) ---
  'POT/UPDATE': (payload, meta) => {
    // payload: { pot:number }
    console.log('[POT/UPDATE]', payload, meta);
  },
  'CHIPS/CHANGE': (payload, meta) => {
    // payload: { player:'A'|'B', delta:number, after:number }
    console.log('[CHIPS/CHANGE]', payload, meta);
  },

  // --- 스냅샷/동기화(신뢰 권장) ---
  'STATE/SNAPSHOT': (payload, meta) => {
    // payload: { ...게임 전체 상태... }
    // TODO: applyGameSnapshot(payload)
    console.log('[STATE/SNAPSHOT]', payload, meta);
  },

  // --- UI/연출/미리보기(비신뢰) ---
  'UI/TICK': (payload, meta) => {
    // payload: { remainMs:number }
    // 비신뢰 최신값 반영
    console.log('[UI/TICK]', payload, meta);
  },
  'UI/EMOTE': (payload, meta) => {
    // payload: { kind:'wow'|'smile'|... }
    console.log('[UI/EMOTE]', payload, meta);
  },
};

// 2) 등록/확장 유틸(원하면 동적으로 핸들러 추가 가능)
export function registerHandler(type, fn) {
  if (Handlers[type]) console.warn('Overriding handler for', type);
  Handlers[type] = fn;
}

// 3) 디스패처(이 함수가 deliverToGame에서 호출됩니다)
export function dispatchPayload(payload, meta) {
  // 안전 가드
  if (!payload || typeof payload.type !== 'string') {
    console.warn('Unknown payload (no type):', payload, meta);
    return;
  }
  const handler = Handlers[payload.type];
  if (!handler) {
    console.warn('No handler for type:', payload.type, payload, meta);
    return;
  }
  try {
    handler(payload, meta);
  } catch (err) {
    console.error('Handler error for', payload.type, err);
  }
}
