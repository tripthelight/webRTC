export function createSignaling(room) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${process.env.RTC_HOST}:${process.env.RTC_PORT}`;
  const ws = new WebSocket(`${proto}://${url}/ws?room=${encodeURIComponent(room)}`);
}
