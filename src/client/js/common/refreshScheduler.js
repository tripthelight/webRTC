/**
 * 14:10:10에 시작 → 10초마다 1번씩 총 10번 새로고침
 * 새로고침 후에도 상태를 이어가기 위해 localStorage 사용
 */
const KEY = "refreshJob";
const TOTAL = 100;
const INTERVAL_MS = 100;
const TARGET_TIME = "14:22:00"; // HH:mm:ss (로컬 시간 기준)

const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); }
  catch { return null; }
};
const write = (v) => localStorage.setItem(KEY, JSON.stringify(v));
const clear = () => localStorage.removeItem(KEY);

/** 오늘 기준 HH:mm:ss 를 Date로 변환 (이미 지났으면 내일) */
function nextTargetDate(hms) {
  const [h, m, s] = hms.split(":").map(Number);
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1); // 이미 지났으면 내일
  return d;
}

/** 한 번 새로고침 수행 (카운트 증가 및 다음 시각 저장 후 reload) */
function reloadOnce() {
  const st = read();
  if (!st || !st.active) return;

  if (st.count >= st.total) {
    clear();
    return;
  }

  const now = Date.now();
  // 이번 실행을 카운트에 포함
  const nextAt = now + st.intervalMs;
  write({ ...st, count: st.count + 1, nextAt });

  // 실제 새로고침
  location.reload();
}

/** 잡 시작: 즉시 1회 실행되도록 nextAt=now 로 설정 후 reloadOnce 호출 */
function startJob() {
  write({
    active: true,
    count: 0,
    total: TOTAL,
    intervalMs: INTERVAL_MS,
    nextAt: Date.now()
  });
  reloadOnce();
}

/** 로드 시 상태 확인 및 타이머 세팅 */
export function scheduleRefresh() {
  const st = read();

  if (st && st.active) {
    // 진행 중인 잡 재개
    if (st.count >= st.total) { clear(); return; }
    const delay = Math.max(0, (st.nextAt ?? (Date.now() + INTERVAL_MS)) - Date.now());
    setTimeout(reloadOnce, delay);
    return;
  }

  // 아직 시작 전: 목표 시각 대기
  const target = nextTargetDate(TARGET_TIME);
  const delay = Math.max(0, target.getTime() - Date.now());
  setTimeout(startJob, delay);
};
