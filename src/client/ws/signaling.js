export function createSignaling(room) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${process.env.RTC_HOST}:${process.env.RTC_PORT}`;
  const ws = new WebSocket(`${proto}://${url}/ws?room=${encodeURIComponent(room)}`);

  const handlers = new Set();
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handlers.forEach(h => h(msg));
    } catch (error) {}
  });

  return {
    ws,
    onMessage(fn) { handlers.add(fn); return () => handlers.delete(fn) },
    send(obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
    waitOpen() {
      return new Promise((res, rej) => {
        if (ws.readyState === WebSocket.OPEN) return res();
        ws.addEventListener('open', () => res(), { once: true });
        ws.addEventListener('error', (e) => rej(e), { once: true });
      });
    },
  };
};
