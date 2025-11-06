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

const ICE_SERVERS = [
  // 공개 STUN 예시(실서비스는 TURN 필요)
  { urls: 'stun:stun.l.google.com:19302' },
];

// ———————————————————————————————————————————————————



// ———————————————————————————————————————————————————

const IPT = document.querySelector(".ipt");
const BTN = document.querySelector(".btn");
BTN.addEventListener("click", () => {
  if (!STATE.dc) {
    log("DataChannel is not open.");
    return;
  }
  IPT.value !== "" && STATE.dc.send(IPT.value);
  IPT.value = "";
});
