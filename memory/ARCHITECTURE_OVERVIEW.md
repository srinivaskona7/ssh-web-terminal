# Architecture Overview — WebSSH Studio

**One-line summary:** Browser-based SSH terminal + SFTP workspace. Monorepo with Preact client, Go gateway, and Cloudflare Worker relay. Private keys never leave the browser.

## System Diagram

```
Browser (apps/web)
  UI Shell (13 screens) → Terminal (xterm.js) / SFTP / Editor / Workspace modules
  Vault (WebCrypto non-extractable) ┐
  Transport (binary framing)        ┘
         │ wss:// binary frames
         ▼
┌────────────────────┬────────────────────────┐
│ Go Gateway         │ Cloudflare Relay       │
│ (apps/gateway)     │ (apps/relay)           │
│ WS + OIDC + Origin │ JWT + Turnstile        │
│ SSRF policy guard  │ Destination validation │
│ SSH dial / SFTP    │ cloudflare:sockets     │
└────────────────────┴────────────────────────┘
         ▼ TCP 22 / ProxyJump
     Target SSH Host
```

Mermaid source: `README.md` Architecture section.

## Dual Transport

| Mode | Value in `transport.ts` | Who speaks SSH-2.0 | SFTP / Editor / Tunnels / Resume |
|------|-------------------------|-------------------|-----------------------------------|
| `go-gateway` | `go-gateway` | Gateway terminates SSH, browser signs challenges | Full features |
| `cloudflare-relay` | `cloudflare-relay` | Browser implements RFC 4251-4254 natively via `browser-ssh-client.ts`, Worker bridges raw bytes | PTY + exec verified; SFTP via shell commands (not production-ready — see `docs/RUNBOOK.md` §5) |

Pages defaults to `wss://webssh-studio-relay.life-magic.workers.dev/ws`. `GATEWAY_URL` / `TRANSPORT_MODE` Actions variables override it. `transport.ts` resolves endpoint and preserves saved prefs.

## Top-Level Layout

```
design/           tokens.json + COMPONENT_SPECS.md (source of truth)
packages/
  protocol/       15-byte framing + control codecs (TS + Go)
  ui-kit/         token compiler, 9 themes, fonts, icons, primitives
apps/
  web/            Vite + Preact + TS strict client
  gateway/        Go 1.23 WebSocket-to-SSH/SFTP
  relay/          Cloudflare Worker WebSocket-to-TCP
e2e/              Playwright + axe
deploy/           docker/ ec2/ fly/
docs/             DECISIONS, FEATURES, THREAT_MODEL, RUNBOOK, DIAGRAMS_FEATURES
scripts/          build-tokens, lint-tokens, verify-build, check-eol
.github/workflows ci, pages, gateway-release, security
memory/           this folder
```

## Key Flows

1. **Connect (gateway):** `transport.ts` → WS `/ws` → `hello` → `connect` → gateway dials SSH → `hostkey_prompt` → browser TOFU check → `hostkey_decision` → `sign_request`/`sign_response` loop → `open_channel` → `pty-req` + `shell` acks → `channel_opened` → PTY data.
2. **Connect (relay):** `browser-ssh-client.ts` does key exchange (`ecdh-sha2-nistp256`), host-key verify, auth (password / PEM / WebCrypto), then `pty-req` + `shell`. Worker only relays bytes after JWT + Turnstile + destination checks.
3. **SFTP:** `transfer-engine.ts` 256 KiB chunks, SHA-256, `.part` atomic rename, offset resume. Editor refuses overwrite when remote changed since load; saves chunked >3 MiB.
4. **Resume (gateway):** 4 MiB per-session ring buffer, `resume` with session id/token + last seq. Client pending input capped at 64 KiB. Backoff 500 ms → 30 s ±25% jitter.
5. **Workspace modules:** All go through `session/adapters.ts` → `WorkspaceRemoteSession` (`exec`, `readFile`, `writeFile`). One contract for both transports — no fixtures.

## Design Decisions (ADR summary)

- **ADR-001 Stitch fallback:** `design/` + `packages/ui-kit/tokens.json` is the swappable token source.
- **ADR-002 Preact + nanostores:** Lightweight, decoupled domain vs `ui/` layer. No runtime CSS-in-JS.
- **ADR-003 Vault:** Ed25519 first, ECDSA P-256 fallback. Non-extractable `CryptoKey`; AES-GCM-256 wrap via Argon2id/PBKDF2. IEEE-P1363 → SSH `mpint` conversion in `vault/ssh-wire.ts`.
- **ADR-004 Framing:** `[type:u8][channel:u16][seq:u64][len:u32][payload]` BE, 15-byte header, 4 MiB max frame, credit flow control.
- **ADR-005 testsshd:** Embedded Go SSH server for deterministic integration tests without Docker.
- **ADR-006 Dual transport:** Evaluated `@microsoft/dev-tunnels-ssh`, rejected — wrote zero-dep WebCrypto SSH client instead.
- **ADR-007 No fixtures:** Modules talk only to server via `WorkspaceRemoteSession`; `server-control.ts` is sole metrics source; claims from `capability-matrix.ts`.
- **ADR-008 Editor conflict check:** `saveEditorBuffer` re-reads before write; disconnected save = error, never fake success.
- **ADR-009 Memory is canonical (2026-11):** `memory/MEMORY.md` is the agent index. `CLAUDE.md`/`GEMINI.md`/`AGENTS.md` are identical copies checked by `scripts/check-memory-sync.mjs`. New module work adds a `RUNBOOK_<module>.md` and updates `docs/DECISIONS.md`.

## Non-Negotiables

1. No fake data — missing probe renders "not reported", never 0/estimate.
2. No simulated success — disconnected actions report disconnect.
3. No billing / tiers / paywalls.
4. No anonymous proxy — auth, Origin, destination validation, quotas always on.
5. Claims from tests only — `docs/FEATURES.md` Verified vs Implemented.
6. Zero CDN (except Turnstile widget), zero hardcoded design values, strict CSP `default-src 'self'`.

## See Also

- [MODULE_MAP.md](./MODULE_MAP.md) — every module, key files, deps
- [PROTOCOL_DATA_FLOW.md](./PROTOCOL_DATA_FLOW.md) — framing, channels, PTY lifecycle
- [SECURITY_MODEL.md](./SECURITY_MODEL.md) — vault, TOFU, SSRF, JWT, quotas
- [DEPLOYMENT_CI.md](./DEPLOYMENT_CI.md) — Pages, Worker, EC2, Fly, gates
- `docs/DECISIONS.md`, `docs/THREAT_MODEL.md`, `docs/RUNBOOK.md`
