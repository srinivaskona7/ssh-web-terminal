# WebSSH Studio — Project Memory Index

- **Session Plan & Checklist**: [SESSION_PLAN.md](./SESSION_PLAN.md)
- **Monorepo Modules**:
  - `design/`: Source-of-truth design tokens (`tokens.json`) and screen/component specifications.
  - `packages/ui-kit/`: Token compiler, themes, icons, self-hosted WOFF2 fonts, UI primitives.
  - `packages/protocol/`: Binary framing and control message codecs (TypeScript & Go).
  - `apps/web/`: Browser SSH studio client (`vault`, `transport`, `terminal`, `files`, `prefs`, `hosts`, `ui`).
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
