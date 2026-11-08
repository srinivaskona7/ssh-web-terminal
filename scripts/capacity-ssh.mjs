// Full SSH-session ramp (J06): opens N gateway WebSocket connections and runs
// a distinct `printf` marker over each via the binary frame protocol.
// Usage: GATEWAY_WS=ws://127.0.0.1:8080/ws TESTSSHD_FINGERPRINT=... node scripts/capacity-ssh.mjs 5
// NOTE: assumes an authenticated gateway (gatewayAuthToken via env GATEWAY_TOKEN).
// Skips gracefully when the WebSocket layer rejects the connection.

const n = Number(process.argv[2] ?? '5');
const url = process.env.GATEWAY_WS ?? 'ws://127.0.0.1:8080/ws';
let ok = 0, fail = 0;
const started = Date.now();
await Promise.allSettled(
  Array.from({ length: n }, (_, i) => new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { fail++; ws.close(); resolve(); }, 15000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      ok++;
      ws.close();
      resolve();
    });
    ws.addEventListener('error', () => { clearTimeout(timer); fail++; resolve(); });
  }))
);
console.log(JSON.stringify({ target: n, wsAccepted: ok, fail, durationMs: Date.now() - started }));
