// Capacity ramp harness (J06). Opens N gateway WebSocket connections against
// a running gateway (default http://127.0.0.1:8080) and records setup latency
// + close reasons. Usage: GATEWAY_WS=ws://127.0.0.1:8080/ws node scripts/capacity-ramp.mjs 20
// Uses the global WebSocket (Node 22+) — no extra deps.

const n = Number(process.argv[2] ?? '20');
const url = process.env.GATEWAY_WS ?? 'ws://127.0.0.1:8080/ws';
const lat = [];
let ok = 0, fail = 0;
const started = Date.now();
await Promise.allSettled(Array.from({ length: n }, (_, i) => new Promise((resolve) => {
  const t0 = Date.now();
  const ws = new WebSocket(url);
  const timer = setTimeout(() => { fail++; ws.close(); resolve(); }, 10000);
  ws.addEventListener('open', () => { clearTimeout(timer); lat.push(Date.now() - t0); ok++; ws.close(); resolve(); });
  ws.addEventListener('error', () => { clearTimeout(timer); fail++; resolve(); });
})));
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? 0;
console.log(JSON.stringify({ target: n, ok, fail, p50: pct(0.5), p95: pct(0.95), durationMs: Date.now() - started }));
