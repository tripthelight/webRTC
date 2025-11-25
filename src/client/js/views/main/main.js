import "../../../scss/common.scss";

function init() {
  // 초기화 코드
  window.sessionStorage.clear();
  window.localStorage.clear();
}

// 🔙 아이폰 모바일은 뒤로가기 후 진입 시 이전 캐시를 가져옴
// ⭐⭐⭐ 그래서 pageshow로 init 필요
window.addEventListener('pageshow', () => {
  init();
});
