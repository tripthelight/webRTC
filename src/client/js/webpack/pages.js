import FILE from './JSON/file.json' with { type: 'json' };
import GAME_LIST from './JSON/gameList.json' with { type: 'json' };
// import PAGES from '@/client/js/webpack/JSON/file' with { type: 'json' };
// const { default: PAGES } = await import("../../JSON/file.json", {
//   assert: {
//     type: "json",
//   },
// });
const OBJ = {...FILE, ...GAME_LIST}
const PAGES = {
  js: [...OBJ.js, ...OBJ.gameList],
  html: [...OBJ.html, ...OBJ.gameList],
};


export default PAGES;
