# WebSSH Studio — Agent Instructions

Synchronized with `memory/MEMORY.md` and `memory/SESSION_PLAN.md`.

Start every session by reading `memory/MEMORY.md` and then the relevant file in `memory/`.

## Architecture & Module Tree
- `design/`: Design tokens (`tokens.json`) and screen/component specs (`COMPONENT_SPECS.md`).
- `packages/ui-kit/`: Design token pipeline (`tokens.json` → `tokens.css` & TypeScript definitions), theme presets, font stacks (no font files ship; system fallbacks), 1.5px line icons, and accessible UI primitives.
- `packages/protocol/`: Binary framing (`[type:u8][channel:u16][seq:u64][len:u32][payload]`), control message schema, credit-based flow control, and sequence replay helpers for TypeScript and Go.
- `apps/web/`: Vite + Preact + TypeScript strict client.
  - Core: `src/vault`, `src/transport`, `src/terminal`, `src/files`, `src/prefs`, `src/hosts`, `src/ui`.
  - Workspace modules: `src/discovery` (read-only capabilities), `src/recipes` (versioned recipes + plans), `src/jobs` (durable detached jobs), `src/session` (`adapters.ts` transport normalisation), `src/control` (live metrics/services/power), `src/containers`, `src/kubernetes`, `src/git`, `src/projects`, `src/automation`.
  - UI: `src/ui/App.tsx` (shell + rail), `src/ui/ServerModules.tsx` (module screens), `src/ui/CapabilityMatrixPanel.tsx` + `capability-matrix.ts` (claims).
- `apps/relay/`: Cloudflare Worker WebSocket-to-TCP SSH relay (`src/index.ts`, `src/policy.ts`, `wrangler.jsonc`) using `cloudflare:sockets` `connect()`.
- `apps/gateway/`: Go 1.22+ WebSocket-to-SSH/SFTP gateway (`internal/policy`, `internal/session`, `internal/sshbridge`, `internal/sftpbridge`, `internal/auth`, `internal/audit`).
- `e2e/`: Playwright cross-browser E2E, full-screen, and `@axe-core/playwright` accessibility suites.
- `deploy/`: Distroless non-root Docker config (`deploy/docker`) and Fly.io configuration (`deploy/fly`).

## Invariants
1. **Zero Hardcoded Design Values**: All UI components consume CSS variables generated from `packages/ui-kit/tokens.json`. Verified via `npm run lint:tokens`.
2. **Non-Extractable Keys & Remote Signer**: Private keys remain inside browser WebCrypto/IndexedDB; the Go gateway authenticates via `sign_request` / `sign_response` over the control channel.
3. **Zero CDN Dependencies**: All fonts, icons, scripts, and styles are self-hosted for strict CSP (`default-src 'self'`).
4. **Dev/Preview Server Config**: Vite servers always configure `host: true`, `allowedHosts: true`, and `cors: true`.
5. **No Fabricated Data or Success**: missing probes render "not reported"; disconnected actions report the disconnect. No simulated metrics, feature counts, or green statuses. Claims live in `docs/FEATURES.md` and must name a test before being marked Verified. A screen that no navigation path reaches is an orphan, not a feature: every shipped screen needs a rail or palette entry and a test that opens it.
6. **No Billing**: no payments, subscriptions, tiers or feature paywalls anywhere in the product.
7. **No Anonymous Proxy**: relay and gateway keep authentication, origin checks, destination validation, quotas and connection limits.
8. **No Unknown CSS Properties**: stylesheets use the kebab-case spelling (`overflow-wrap`). The camelCase form parses but is dropped by browsers, so the rule silently does nothing. Verified via `npm run lint:css`.
9. **No Known Vulnerable Dependencies**: `npm audit --omit=dev --audit-level=high` and `govulncheck ./...` must both be clean. Transitive pins that the upstream package holds back (for example `dompurify` under `monaco-editor`) are corrected with an npm `overrides` entry, not by waiting for an upstream release.

## Deployment and Connection Invariants
- Pages uses `.github/workflows/pages.yml`, `ubuntu-24.04`, configure-pages v6, upload-pages-artifact v5, deploy-pages v5, and `apps/web/dist/.nojekyll`; heavy browser tests remain in `ci.yml`.
- Pages defaults to `wss://webssh-studio-relay.life-magic.workers.dev/ws`; Actions variables `GATEWAY_URL` and optional `TRANSPORT_MODE` override it. `apps/web/src/transport/transport.ts` resolves endpoint and matching protocol, preserving saved user preferences.
- Cloudflare build root is `apps/relay`; build command `npm ci --include=dev && npm run build`; deploy `npx wrangler deploy`; pinned Wrangler comes from root `package-lock.json`.
- Relay auth lives in `apps/relay/src/auth.ts`; runtime secrets `SESSION_SIGNING_SECRET`, `AUTH_USERS_JSON` never enter Pages or Git. `USER_QUOTA_DO` binding and `v1` migration live in `apps/relay/wrangler.jsonc`; missing binding must block SSH.
- Run token generation before type checking, tests, and builds (root scripts already do this). Validate with `npm run lint`, `npm test`, `npm run build`; build with `VITE_BASE_PATH=/ssh-web-terminal/` for Pages. Ignore artifacts using root-anchored rules, including `/apps/relay/.wrangler/` and `/apps/relay/.dev.vars*`.
- Operational setup and target connection checks are documented in `docs/RUNBOOK.md`, section 5.
- `.npmrc` pins the public npm registry; all `package-lock.json` download URLs must use `registry.npmjs.org` so GitHub and Cloudflare runners can install without corporate network access. Keep dependency-install failures visible in CI logs.
- CI pins Go `1.27.4` (the first release with the `net/http` fix for GO-2026-6859) and `govulncheck` `v1.9.0` (pinned, not `@latest`, so the scanner cannot drift past the toolchain). Raise the Go pin before raising the scanner.
- Relay PTY creation must wait for server acknowledgements of both `pty-req` and `shell`; `connected`/`channel_opened` must not be reported before acceptance. Production limitations of relay file tools and process resumption are recorded in `docs/RUNBOOK.md`.

## Workspace additions (2026-11)
- `apps/web/src/ui/shell/`: `AppHeader.tsx`, `AppRail.tsx`, `SettingsScreen.tsx`, `WelcomeScreen.tsx`, `TurnstileWidget.tsx`, `types.ts`; extracted shell components used by `ui/App.tsx`.
- Welcome dashboard: `ui/WelcomeDashboard.tsx`, `ui/welcome-data.ts`, `ui/welcome-dashboard.css`; `ui/ide-storage.ts` reads `webssh.ide.v1` project and recent-file paths only.
- Remote I/O: `files/remote-file-io.ts` handles paged reads and chunked writes; `transport/exec-output.ts`, `remote-signer.ts`, `session-env.ts` handle bounded output, fingerprint routing and environment reports.
- Gateway helpers: `apps/gateway/cmd/gateway/env.go`, `hops.go`, `execstream.go` implement environment validation, ProxyJump credentials and bounded command streams; integration tests use `harness_test.go`.
- `apps/web/src/devops/`: `types.ts`, `exec.ts`, `logs/`, `tools/network/`, `tools/delivery/`, `tools/system/`; engine foundations, not a wired DevOps screen.
- `apps/web/src/diagrams/`: `model.ts`, `graph-index.ts`, `diff.ts`, `download.ts`, `layout/`, `sources/`, `advanced/analyse/`, `advanced/data/`; engine foundations, not a wired Diagram Studio screen. Design contract: `docs/DIAGRAMS_FEATURES.md`.
- Diagram snapshots: IndexedDB `webssh-diagrams` version 1, store `snapshots`, key path `id`, index `byEstate` on `estate`; newest 30 snapshots per estate, without `evidence.raw`. Implementation: `diagrams/advanced/data/snapshots-store.ts`.
- Generate tokens before lint/typecheck/tests/build using root npm scripts. Gates: `npm run lint` (tokens, CSS properties, line endings, memory sync, typecheck), `npm test`, `npm run test:coverage`, `VITE_BASE_PATH=/ssh-web-terminal/ npm run build`, `npm audit --omit=dev --audit-level=high`, and `go test -race ./...` in `apps/gateway`; browser integration uses `npx playwright test` and requires local sockets.
