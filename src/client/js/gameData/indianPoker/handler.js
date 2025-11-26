export const DATA = new Map();

export const handler = {
  get: (k) => {
    if (k === "DATA") {
      return DATA;
    }
    return window.sessionStorage.getItem(k) || null;
  },
  set: (k, v) => {
    DATA.set(k, v);
    window.sessionStorage.setItem(k, v);
  },
}
