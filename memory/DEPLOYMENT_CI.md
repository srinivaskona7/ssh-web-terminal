# Deployment & CI

## Surfaces

| Surface | Stack | Where | Notes |
|---------|-------|-------|-------|
| Pages | GitHub Pages (static) | `.github/workflows/pages.yml` | `ubuntu-24.04`, configure-pages v6, upload-pages-artifact v5, deploy-pages v5, `apps/web/dist/.nojekyll`. `VITE_BASE_PATH=/ssh-web-terminal/` |
| Relay | Cloudflare Worker | `apps/relay` (build root) | `npm ci --include=dev && npm run build` + `npx wrangler deploy`. Pinned Wrangler from root `package-lock.json`. `apps/relay/scripts/typecheck.mjs` fallback |
| Gateway | Go distroless Docker + Fly.io + EC2 | `deploy/docker`, `deploy/fly`, `deploy/ec2` | EC2: systemd + Caddy TLS, `t4g/t3.small` Ubuntu 24.04. Fly: non-root distroless |
| E2E | Playwright + axe | `e2e/webssh.spec.ts`, `playwright.config.ts` | Cross-browser, full-screen, `@axe-core/playwright` |

Pages default `wss://webssh-studio-relay.life-magic.workers.dev/ws`. Override via Actions variables `GATEWAY_URL` + optional `TRANSPORT_MODE` (`go-gateway`/`cloudflare-relay`). `transport.ts` resolves endpoint + protocol.

## Env & Secrets

### Gateway (`apps/gateway`)
`LISTEN_ADDR :8080`, `ALLOWED_ORIGINS`, `GATEWAY_AUTH_TOKEN`, `REQUIRE_TLS`, `TLS_CERT_FILE`/`TLS_KEY_FILE`, `OIDC_ISSUER`/`OIDC_CLIENT_ID`, `DEST_ALLOWLIST`/`DEST_DENYLIST`, `SESSION_GRACE 15m`, `RING_BUFFER_BYTES 4MiB`, `MAX_SESSIONS_PER_USER 10`, `RATE_LIMITS 100`.

### Relay (`apps/relay/wrangler.jsonc`)
- Secrets (Cloudflare dashboard, never Git/Pages): `SESSION_SIGNING_SECRET`, `AUTH_USERS_JSON`, `TURNSTILE_SECRET_KEY`, optional `RELAY_AUTH_TOKEN` (only if `ENABLE_ADMIN_SHARED_TOKEN=1`).
- Vars: `DESTINATION_MODE public`, `ALLOWED_ORIGINS https://srinivaskona7.github.io`, `ALLOWED_SSH_PORTS 22,2222`, `ALLOWED_SSH_TARGETS ""` (public mode), `MAX_CONCURRENT_SESSIONS_PER_USER 5`, `MAX_CONNECTION_ATTEMPTS_PER_MIN 20`, `MAX_TICKET_ATTEMPTS_PER_MIN 10`, `GUEST_TICKET_TTL_SECONDS 300`, `TURNSTILE_VERIFY_URL`.
- `USER_QUOTA_DO` binding + `v1` migration. Missing binding blocks SSH.
- Pages build var: `VITE_TURNSTILE_SITE_KEY` (public). Runtime override `window.__WEBSSH_TURNSTILE_SITE_KEY__`.

## Gates (run before typecheck/test/build)

```
tokens:build  (auto in root scripts: pretest, prebuild, typecheck)
npm run lint        = lint:tokens + lint:eol + typecheck
npm test            = vitest run (65 files, ~834 tests)
VITE_BASE_PATH=/ssh-web-terminal/ npm run build
cd apps/gateway && go test -race ./...
npx playwright test (needs local sockets / disposable host)
```

- `.npmrc` pins `registry.npmjs.org` — all lockfile URLs must match so CI works without corporate net.
- Artifact ignores root-anchored: `/apps/relay/.wrangler/`, `/apps/relay/.dev.vars*`, `apps/web/dist/`, `dist-types/`.
- Heavy browser tests stay in `ci.yml`, not `pages.yml`.

## Local Dev

```bash
npm install && npm run tokens:build
# Terminal 1
cd apps/gateway && ALLOWED_ORIGINS="http://localhost:4173" go run ./cmd/gateway
# Terminal 2
npm run dev   # Vite at http://localhost:4173
```

Health: `curl https://<gw>/healthz` → `{"status":"ok","activeSessions":N,"tlsEnabled":bool,"authRequired":bool}`. `/metrics` Prometheus text.

## EC2 / Firewall Caveats

- Workers have no single fixed egress IPv4 — don't allowlist HTTP proxy CIDRs for TCP 22.
- Pattern: key-only OpenSSH (`PasswordAuthentication no`, non-22 port) or single-IP bastion gateway with Elastic IP.
- `deploy/ec2/` + `docs/RUNBOOK.md` §2 (EC2), §4 (Worker), §5 (Pages/relay wiring), §6 (terminal verify).

## Relay Production Limits

- PTY + exec verified vs EC2 OpenSSH. `sftpOp` relay is shell-fixture — use gateway for real SFTP/binary/editor.
- No remote process resume across new relay connection (browser buffer only). No local TCP listener for relay tunnels.
