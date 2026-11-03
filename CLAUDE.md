# WebSSH Studio — Agent Instructions

Synchronized with `memory/MEMORY.md` and `memory/SESSION_PLAN.md`.

## Architecture & Module Tree
- `design/`: Design tokens (`tokens.json`) and screen/component specs (`COMPONENT_SPECS.md`).
- `packages/ui-kit/`: Design token pipeline (`tokens.json` → `tokens.css` & TypeScript definitions), theme presets, self-hosted WOFF2 fonts, 1.5px line icons, and accessible UI primitives.
- `packages/protocol/`: Binary framing (`[type:u8][channel:u16][seq:u64][len:u32][payload]`), control message schema, credit-based flow control, and sequence replay helpers for TypeScript and Go.
- `apps/web/`: Vite + Preact + TypeScript strict client (`src/vault`, `src/transport`, `src/terminal`, `src/files`, `src/prefs`, `src/hosts`, `src/ui`).
- `apps/relay/`: Cloudflare Worker WebSocket-to-TCP SSH relay (`src/index.ts`, `src/policy.ts`, `wrangler.jsonc`) using `cloudflare:sockets` `connect()`.
- `apps/gateway/`: Go 1.22+ WebSocket-to-SSH/SFTP gateway (`internal/policy`, `internal/session`, `internal/sshbridge`, `internal/sftpbridge`, `internal/auth`, `internal/audit`).
- `e2e/`: Playwright cross-browser E2E, full-screen, and `@axe-core/playwright` accessibility suites.
- `deploy/`: Distroless non-root Docker config (`deploy/docker`) and Fly.io configuration (`deploy/fly`).

## Invariants
1. **Zero Hardcoded Design Values**: All UI components consume CSS variables generated from `packages/ui-kit/tokens.json`. Verified via `npm run lint:tokens`.
2. **Non-Extractable Keys & Remote Signer**: Private keys remain inside browser WebCrypto/IndexedDB; the Go gateway authenticates via `sign_request` / `sign_response` over the control channel.
3. **Zero CDN Dependencies**: All fonts, icons, scripts, and styles are self-hosted for strict CSP (`default-src 'self'`).
4. **Dev/Preview Server Config**: Vite servers always configure `host: true`, `allowedHosts: true`, and `cors: true`.

## Deployment and Connection Invariants
- Pages uses `.github/workflows/pages.yml`, `ubuntu-24.04`, configure-pages v6, upload-pages-artifact v5, deploy-pages v5, and `apps/web/dist/.nojekyll`; heavy browser tests remain in `ci.yml`.
- Pages defaults to `wss://webssh-studio-relay.life-magic.workers.dev/ws`; Actions variables `GATEWAY_URL` and optional `TRANSPORT_MODE` override it. `apps/web/src/transport/transport.ts` resolves endpoint and matching protocol, preserving saved user preferences.
- Cloudflare build root is `apps/relay`; build command `npm ci --include=dev && npm run build`; deploy `npx wrangler deploy`; pinned Wrangler comes from root `package-lock.json`.
- Relay auth lives in `apps/relay/src/auth.ts`; runtime secrets `SESSION_SIGNING_SECRET`, `AUTH_USERS_JSON` never enter Pages or Git. `USER_QUOTA_DO` binding and `v1` migration live in `apps/relay/wrangler.jsonc`; missing binding must block SSH.
- Run token generation before type checking, tests, and builds (root scripts already do this). Validate with `npm run lint`, `npm test`, `npm run build`; build with `VITE_BASE_PATH=/ssh-web-terminal/` for Pages. Ignore artifacts using root-anchored rules, including `/apps/relay/.wrangler/` and `/apps/relay/.dev.vars*`.
- Operational setup and target connection checks are documented in `docs/RUNBOOK.md`, section 5.
