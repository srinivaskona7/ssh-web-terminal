# WebSSH Studio — Project Memory Index

- **Session Plan & Checklist**: [SESSION_PLAN.md](./SESSION_PLAN.md)
- **Honest capability matrix (source of truth for claims)**: [../docs/FEATURES.md](../docs/FEATURES.md)
- **Monorepo Modules**:
  - `design/`: Source-of-truth design tokens (`tokens.json`) and screen/component specifications.
  - `packages/ui-kit/`: Token compiler, themes, icons, self-hosted WOFF2 fonts, UI primitives.
  - `packages/protocol/`: Binary framing and control message codecs (TypeScript & Go).
  - `apps/web/`: Browser SSH studio client.
    - `vault/`, `transport/`, `terminal/`, `files/`, `prefs/`, `hosts/`: original modules.
    - `discovery/`: read-only capability model (`capabilities.ts`).
    - `recipes/`: versioned recipe schema, catalog and plan builder.
    - `jobs/`: durable detached job model (`types.ts`), remote runner, manager, IndexedDB store.
    - `session/`: `adapters.ts` normalises relay and gateway clients into `WorkspaceRemoteSession`.
    - `control/`: live metrics, processes, services and power actions (`server-control.ts`).
    - `containers/`, `kubernetes/`, `git/`, `projects/`, `automation/`: module engines.
    - `ui/`: `App.tsx` shell, `ServerModules.tsx` module screens, `CapabilityMatrixPanel.tsx`,
      `capability-matrix.ts` (claims), `app.css` (`ws-mod-*` workspace styles).
  - `apps/relay/`: Cloudflare Worker WebSocket-to-TCP SSH relay (`src/index.ts`, `src/policy.ts`, `wrangler.jsonc`).
  - `apps/gateway/`: Go WebSocket-to-SSH/SFTP gateway (`policy`, `session`, `sshbridge`, `sftpbridge`, `auth`, `audit`).
  - `e2e/`: Playwright E2E, full-screen, and accessibility tests.
  - `deploy/`: Docker and Fly.io configuration.
  - `docs/`: `DECISIONS.md`, `FEATURES.md`, `THREAT_MODEL.md`, `RUNBOOK.md`.

## Deployment and Connection Invariants
- Pages uses `.github/workflows/pages.yml`, `ubuntu-24.04`, configure-pages v6, upload-pages-artifact v5, deploy-pages v5, and `apps/web/dist/.nojekyll`; heavy browser tests remain in `ci.yml`.
- Pages defaults to `wss://webssh-studio-relay.life-magic.workers.dev/ws`; Actions variables `GATEWAY_URL` and optional `TRANSPORT_MODE` override it. `apps/web/src/transport/transport.ts` resolves endpoint and matching protocol, preserving saved user preferences.
- Cloudflare build root is `apps/relay`; build command `npm ci --include=dev && npm run build`; deploy `npx wrangler deploy`; pinned Wrangler comes from root `package-lock.json`.
- Relay auth lives in `apps/relay/src/auth.ts`; runtime secrets `SESSION_SIGNING_SECRET`, `AUTH_USERS_JSON` never enter Pages or Git. `USER_QUOTA_DO` binding and `v1` migration live in `apps/relay/wrangler.jsonc`; missing binding must block SSH.
- Run token generation before type checking, tests, and builds (root scripts already do this). Validate with `npm run lint`, `npm test`, `npm run build`; build with `VITE_BASE_PATH=/ssh-web-terminal/` for Pages. Ignore artifacts using root-anchored rules, including `/apps/relay/.wrangler/` and `/apps/relay/.dev.vars*`.
- Operational setup and target connection checks are documented in `docs/RUNBOOK.md`, section 5.
- `.npmrc` pins the public npm registry; all `package-lock.json` download URLs must use `registry.npmjs.org` so GitHub and Cloudflare runners can install without corporate network access. Keep dependency-install failures visible in CI logs.
- Relay PTY creation must wait for server acknowledgements of both `pty-req` and `shell`; `connected`/`channel_opened` must not be reported before acceptance. Production limitations of relay file tools and process resumption are recorded in `docs/RUNBOOK.md`.

## Non-negotiables

1. No fake data: missing probes render "not reported", never a zero or estimate.
2. No simulated success: disconnected actions report the disconnect, never a green status.
3. No billing code, tiers or paywalls.
4. No anonymous TCP proxy; auth, origin checks, destination validation and quotas stay in place.
5. Claims come from tests; docs/FEATURES.md distinguishes Verified from Implemented.

## Workspace additions (2026-11)
- `apps/web/src/ui/shell/`: `AppHeader.tsx`, `AppRail.tsx`, `SettingsScreen.tsx`, `WelcomeScreen.tsx`, `TurnstileWidget.tsx`, `types.ts`; extracted shell components used by `ui/App.tsx`.
- Welcome dashboard: `ui/WelcomeDashboard.tsx`, `ui/welcome-data.ts`, `ui/welcome-dashboard.css`; `ui/ide-storage.ts` reads `webssh.ide.v1` project and recent-file paths only.
- Remote I/O: `files/remote-file-io.ts` handles paged reads and chunked writes; `transport/exec-output.ts`, `remote-signer.ts`, `session-env.ts` handle bounded output, fingerprint routing and environment reports.
- Gateway helpers: `apps/gateway/cmd/gateway/env.go`, `hops.go`, `execstream.go` implement environment validation, ProxyJump credentials and bounded command streams; integration tests use `harness_test.go`.
- `apps/web/src/devops/`: `types.ts`, `exec.ts`, `logs/`, `tools/network/`, `tools/delivery/`, `tools/system/`; engine foundations, not a wired DevOps screen.
- `apps/web/src/diagrams/`: `model.ts`, `graph-index.ts`, `diff.ts`, `download.ts`, `layout/`, `sources/`, `advanced/analyse/`, `advanced/data/`; engine foundations, not a wired Diagram Studio screen. Design contract: `docs/DIAGRAMS_FEATURES.md`.
- Diagram snapshots: IndexedDB `webssh-diagrams` version 1, store `snapshots`, key path `id`, index `byEstate` on `estate`; newest 30 snapshots per estate, without `evidence.raw`. Implementation: `diagrams/advanced/data/snapshots-store.ts`.
- Generate tokens before lint/typecheck/tests/build using root npm scripts. Gates: `npm run lint`, `npm test`, `VITE_BASE_PATH=/ssh-web-terminal/ npm run build`, and `go test -race ./...` in `apps/gateway`; browser integration uses `npx playwright test` and requires local sockets.
