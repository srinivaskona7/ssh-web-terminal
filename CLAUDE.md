# WebSSH Studio — Agent Instructions

Synchronized with `memory/MEMORY.md` and `memory/SESSION_PLAN.md`.

## Architecture & Module Tree
- `design/`: Design tokens (`tokens.json`) and screen/component specs (`COMPONENT_SPECS.md`).
- `packages/ui-kit/`: Design token pipeline (`tokens.json` → `tokens.css` & TypeScript definitions), theme presets, self-hosted WOFF2 fonts, 1.5px line icons, and accessible UI primitives.
- `packages/protocol/`: Binary framing (`[type:u8][channel:u16][seq:u64][len:u32][payload]`), control message schema, credit-based flow control, and sequence replay helpers for TypeScript and Go.
- `apps/web/`: Vite + Preact + TypeScript strict client (`src/vault`, `src/transport`, `src/terminal`, `src/files`, `src/prefs`, `src/hosts`, `src/ui`).
- `apps/gateway/`: Go 1.22+ WebSocket-to-SSH/SFTP gateway (`internal/policy`, `internal/session`, `internal/sshbridge`, `internal/sftpbridge`, `internal/auth`, `internal/audit`).
- `e2e/`: Playwright cross-browser E2E, full-screen, and `@axe-core/playwright` accessibility suites.
- `deploy/`: Distroless non-root Docker config (`deploy/docker`) and Fly.io configuration (`deploy/fly`).

## Invariants
1. **Zero Hardcoded Design Values**: All UI components consume CSS variables generated from `packages/ui-kit/tokens.json`. Verified via `npm run lint:tokens`.
2. **Non-Extractable Keys & Remote Signer**: Private keys remain inside browser WebCrypto/IndexedDB; the Go gateway authenticates via `sign_request` / `sign_response` over the control channel.
3. **Zero CDN Dependencies**: All fonts, icons, scripts, and styles are self-hosted for strict CSP (`default-src 'self'`).
4. **Dev/Preview Server Config**: Vite servers always configure `host: true`, `allowedHosts: true`, and `cors: true`.
