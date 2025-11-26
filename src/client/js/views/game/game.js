/**
 * GAME: INDIAN PCKER
 */

import "../../../scss/common.scss";
import {scheduleRefresh} from "../../common/refreshScheduler.js"
import { getDeviceType } from "../../../module/isPC.js"
import { connectSignaling, sendGame } from "../../../module/webRTC/connectSignaling.js"
import deliverToGame from "../../../module/webRTC/reliable/indianPoker/deliverToGame.js";
import handleEnvelope from "../../../module/webRTC/reliable/indianPoker/handleEnvelope.js";
import { handler } from "../../gameData/indianPoker/handler.js"

// 특정 시간, 지정한 횟수만큼 브라우저 새로고침
scheduleRefresh();

// ------------------------------------------------------------
// RELOAD EVENT
function leavePage() {
  const DTA = handler.get("DATA");
  if (DTA.size > 0) {
    window.sessionStorage.setItem("gameData", JSON.stringify([...DTA]));
  }
}
function reloadDataHandler() {
  const reloadData = window.sessionStorage.getItem("gameData");
  if (reloadData !== null) {
    const gameData = JSON.parse(reloadData);
    const gameDataMap = new Map(gameData);
    for (const [k, v] of gameDataMap) {
      window.sessionStorage.setItem(k, v);
      handler.set(k, v);
    }
    window.sessionStorage.removeItem("gameData");
  }
}

// ————————————————————————————————————————————————————————————
// INIT
function init() {
  reloadDataHandler();
  // connectSignaling.js서 불러와서 사용 함수
  // sendGame - 메세지 전달 함수
  // ackUntil - seq/outbox 정리 - handleEnvelope 함수 내부에서 사용
  // handleReliableReceive - 안정 메시지 응답 시 실행 함수 - handleEnvelope 함수 내부에서 사용

  // game.js에서 생성해야되는 함수 - connectSignaling 함수 실행 시 인자로 전달해줘야 할 콜백함수
  // handleEnvelope - 메시지 응답 - 게임 메시지 응답 case 모음
  // deliverToGame - 메시지 응답 결과

  connectSignaling(false, { deliverToGame, handleEnvelope });

  setTimeout(() => {
    handler.set("k_1", "v_1");
    handler.set("k_2", "v_2");
    handler.set("k_3", "v_3");
  }, 5000);

  // ------------------------------------------------------------
  const BTN_RELIABLE = document.querySelector(".btn.reliable");
  const BTN_UNRELIABLE = document.querySelector(".btn.unreliable");
  BTN_RELIABLE.addEventListener("click", () => {
    // 신뢰 경로(기본) — 규칙/칩/턴/카드
    // sendGame({ type: 'ROUND/START', seed: 100, ante: 10 });     // reliable 기본
    sendGame({ type: 'ACTION/RAISE', amount: 5 });         // reliable 기본
    // sendGame({ type: 'DECK/COMMIT', hash });
  });
  BTN_UNRELIABLE.addEventListener("click", () => {
    // 비신뢰 경로 — UI/연출/미리보기
    sendGame({ type: 'UI/TICK', remainMs: 1000 }, { reliable: false });
    // sendGame({ type: 'UI/EMOTE', kind: 'wow' }, { reliable: false });
  });
  // ------------------------------------------------------------


  if (getDeviceType() === "PC") {
    window.addEventListener("beforeunload", () => {
      leavePage();
    });
  }
};

// ————————————————————————————————————————————————————————————
// DOCUMENT READY
window.addEventListener("pageshow", init);
