// import PAGES from '@/client/js/webpack/pages';
import PAGES from './pages.js';

// 공통 경로 설정
const BASE_JS_PATH = './src/client/js/';
const VIEW_PATH = `${BASE_JS_PATH}views/`;
const GAME_PATH = `${VIEW_PATH}game/`;

// JavaScript 파일 경로 매핑 자동 생성
const jsArr = PAGES.js.reduce((acc, name) => {
  acc[name] =
    name === 'index' ? `${VIEW_PATH}main/main.js` :
    name === 'selectGame' ? `${VIEW_PATH}selectGame/selectGame.js` :
    `${GAME_PATH}/${name}.js`; // 기본적으로 게임 폴더 내 파일로 처리
  return acc;
}, {});

const multipleJsPlugins = jsArr;

export default multipleJsPlugins;
