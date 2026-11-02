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
