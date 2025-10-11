import "../../../scss/common.scss";
// import {Signaling} from '../../../ws/signaling.js';
// import {createManualPeer} from '../../../rtc/manualPeer.js';
// import {createPeer} from '../../../rtc/peerPN.js';
import { connectSignaling } from '../../../rtc/rtc.js';
import {scheduleRefresh} from "../../common/refreshScheduler.js"

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
// scheduleRefresh();

// ----- WebSocket signaling -----
const WS_URL = `${process.env.SOCKET_HOST}:${process.env.RTC_PORT}`;
// const ws = new WebSocket(WS_URL);

// URL ?room=값 이 있으면 사용, 없으면 데모용 기본값
const params = new URLSearchParams(location.search);
const room = params.get('room') || 'demo-room-1';
connectSignaling({ room, url: WS_URL });
