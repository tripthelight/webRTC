export function createSignaling(room) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${process.env.RTC_HOST}:${process.env.RTC_PORT}`;
  const ws = new WebSocket(`${proto}://${url}/ws?room=${encodeURIComponent(room)}`);

  const handler = new Set();
  ws.addEventListener('message', ev => {
    try {
      const msg = JSON.parse(ev.data);
      handler.forEach(h => h(msg));
    } catch {}
  });

  return {
    ws,
    onMessage(fn) {
      handler.add(fn);
      return () => handler.delete(fn);
    },
    send(obj) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    waitOpen() {
      return new Promise((res, rej) => {
        if (ws.readyState === WebSocket.OPEN) return res();
        ws.addEventListener('open', () => res(), {once: true});
        ws.addEventListener('error', e => rej(e), {once: true});
      });
    },
  };
}
