import { dispatchPayload } from "./dispatchPayload.js";

export default function deliverToGame(payload, meta) {
  // meta 예: { reliable:true, seq:12 } | { unreliable:true }
  // 여기선 오직 '무슨 이벤트인가'만 판단 → 라우터로 위임
  dispatchPayload(payload, meta);
};
