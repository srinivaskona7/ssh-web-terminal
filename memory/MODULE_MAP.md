# Module Map — WebSSH Studio

## design/

| File | Purpose |
|------|---------|
| `design/tokens.json` | Spacing, radius, studio palette, elevation, motion, density, typography, 9 themes (dark, light, high-contrast + 6 more in ui-kit) with 16-color ANSI per theme |
| `design/COMPONENT_SPECS.md` | Screen/component specs |
| `scripts/build-tokens.mjs` | `tokens.json` → `tokens.css` + TS defs |
| `scripts/lint-tokens.mjs` | Enforces zero hardcoded design values |

## packages/protocol/

- `src/index.ts` — TS framing, control message schema, sequence replay, credit flow control
- `src/protocol.test.ts` — frame encode/decode, property tests
- Go counterpart in `apps/gateway/internal/protocol/`
- Header: `[type:u8][channel:u16][seq:u64][len:u32][payload]`, 15 bytes BE, 4 MiB max

## packages/ui-kit/

- `tokens.json` — compiler input (synced from design)
- `src/primitives.tsx` — accessible UI primitives
- `src/icons.tsx` — 1.5px line icons
- `src/contrast.ts` — WCAG AA contrast verification
- `src/generated/` — built token defs
- Fonts: self-hosted WOFF2 in ui-kit distribution

## apps/web — Core Domain

### vault/ — Zero-Trust Key Vault
- `vault.ts` — Ed25519 → ECDSA P-256 fallback, non-extractable `CryptoKey`, AES-GCM wrap, Argon2id/PBKDF2
- `ssh-wire.ts` — IEEE-P1363 → SSH `mpint` conversion
- `known-hosts.ts` — TOFU pinning, mismatch blocking
- `index.ts` — public API

### transport/ — Dual Transport + SFTP
- `transport.ts` — endpoint resolution (`?gateway=`, `VITE_GATEWAY_URL`, saved prefs), backoff, live session client, reconnect
- `browser-ssh-client.ts` — RFC 4251-4254 native SSH: `ecdh-sha2-nistp256`, `aes128-ctr`+`hmac-sha2-256`, password/publickey, multi-channel PTY/exec
- `sftp-client.ts` — SFTP v3 list/stat/read/write, `~` expansion, mode-preserving atomic write, `.webssh-part` resume
- `remote-signer.ts` — `sign_request`/`sign_response` routing + fingerprint checks
- `exec-output.ts`, `session-env.ts` — bounded output, env reports
- `testing/` — test helpers

### terminal/
- `TerminalPane.tsx` — one xterm per pane, WebGL→canvas→DOM fallback
- `xterm-adapter.ts` — renderer, find (`findNext`/`findPrevious`), resize, key handling
- `workspace-state.ts` — tabs, split panes, workspace presets
- `channel-output-buffer.ts` — bounded per-channel output

### files/
- `transfer-engine.ts` — queue, bounded concurrency, `StorageGuard` (32 MiB in-flight, 256 MiB cap), ZIP/ZIP64 streaming
- `remote-file-io.ts` — paged reads (until gateway size met), chunked writes, UTF-8 refusal

### prefs/ + hosts/
- `prefs/index.ts` — `PreferencesStore` (`webssh.preferences.v2`), themes, workspace preset, rail width, IDE mode
- `hosts/index.ts` — `~/.ssh/config` import, registry, JSON export/import (no keys/passwords), recent hosts

## apps/web — Workspace Modules (ADR-007)

All implement `WorkspaceRemoteSession` via `session/adapters.ts`. No fixtures.

| Module | Dir | Purpose |
|--------|-----|---------|
| discovery | `discovery/capabilities.ts` | Read-only capability model |
| recipes | `recipes/engine.ts`, `types.ts` | Versioned schema, catalog, plan/preflight, shell escaping |
| jobs | `jobs/remote-job-runner.ts`, `job-manager.ts`, `types.ts` | Durable detached jobs (`setsid`, markers), monitor/cancel/reattach, IndexedDB store, `verifyJob` |
| session | `session/adapters.ts`, `remote-session.ts`, `connection-registry.ts` | Normalizes relay vs gateway into one `exec`/`readFile`/`writeFile`; per-channel routing |
| control | `control/server-control.ts` | Live CPU/mem/disk/net deltas, processes, services, power. `sudo -n`, typed confirm, blanks missing probes |
| containers | `containers/docker-client.ts` | Docker, images, Compose |
| kubernetes | `kubernetes/kubectl-client.ts` | Pods, logs, contexts. Never reads Secrets |
| git | `git/git-client.ts` | Status, diff, stage, commit. Never force-push |
| projects | `projects/projects.ts` | Detection + deploy plan preview, exec via `startCommandJob` |
| automation | `automation/python-automation.ts` | Python detection, managed cron |
| devops | `devops/types.ts`, `exec.ts`, `logs/`, `tools/network|delivery|system/` | Engine foundations only — not wired screen |
| diagrams | `diagrams/model.ts`, `graph-index.ts`, `diff.ts`, `download.ts`, `layout/`, `sources/`, `advanced/` | Engine foundations only — design contract `docs/DIAGRAMS_FEATURES.md` |

## apps/web — UI

- `ui/App.tsx` — shell + rail, modals, connection, PTY wiring, palette, find bar, presets. Status is `opening`/`ready`/`error`, never guessed.
- `ui/shell/` — `AppHeader.tsx`, `AppRail.tsx`, `SettingsScreen.tsx`, `WelcomeScreen.tsx`, `TurnstileWidget.tsx`, `types.ts`
- `ui/ServerModules.tsx` — Overview, Software, Containers, K8s, Automations, Deployments, Activity panels
- `ui/CapabilityMatrixPanel.tsx` + `capability-matrix.ts` — generated claims (source of truth for honest UI)
- `ui/LightIde.tsx`, `ide-editing.ts`, `ide-storage.ts` — IDE: browse/create/rename/delete, UTF-8 only, autosave 1.2s debounce, read-before-write conflict, CRLF preserve, find/replace, grep/diff/status, cmd runner
- `ui/productivity.ts` — palette v2, snippets, keybindings, asciicast v2 recording
- `ui/session-health.ts` — live health, manual reconnect
- `ui/advanced-features.ts`, `profile.ts`, `ProfileCard.tsx` — creator card, health
- `ui/WelcomeDashboard.tsx`, `welcome-data.ts` — dashboard over `webssh.ide.v1` paths only
- `ui/app.css` — `ws-mod-*` workspace styles
- `main.tsx` — startup watchdog dismissal, `#startup-shell`

## apps/gateway (Go 1.23)

- `cmd/gateway/main.go` — WS `/ws`, `/healthz`, `/metrics`, TLS + OIDC + Origin enforcement
- `cmd/gateway/env.go`, `hops.go`, `execstream.go` — env validation, ProxyJump chain dial, bounded exec streams. Tests: `harness_test.go`, `main_test.go`, `hops_test.go`
- `internal/policy/` — SSRF guard (RFC1918/loopback/link-local/metadata block, CIDR allow/deny)
- `internal/session/` — session manager, 4 MiB ring buffer, grace 15m
- `internal/sshbridge/` — SSH dial, `DialChain` for ProxyJump (8-hop cap), RemoteSigner, SFTP bridge entry
- `internal/sftpbridge/` — SFTP subsystem streaming, `.part` atomic resume
- `internal/auth/` — OIDC Bearer + `GATEWAY_AUTH_TOKEN` constant-time check
- `internal/audit/` — structured JSON audit, redacts password/privateKey/passphrase/payload/token
- `internal/protocol/` — Go framing codec
- `internal/testsshd/` — embedded OpenSSH test server

## apps/relay (Cloudflare Worker)

- `src/index.ts` — WS→TCP bridge via `cloudflare:sockets connect()`, quota enforcement, `POST /auth/session` + `POST /auth/ticket`
- `src/policy.ts` — `DESTINATION_MODE` (`allowlist`|`public`), bogon/range block, encoded-IP block, anti-rebinding DNS pinning
- `src/auth.ts` — HS256 JWT (`iss`/`aud`/`sub`/`iat`/`exp`/`jti`), `issueGuestTicket`, `AUTH_USERS_JSON`, `SESSION_SIGNING_SECRET`
- `src/relay.test.ts` — policy, DNS, JWT expiry, rate limits, e2e vs testsshd
- `scripts/typecheck.mjs` — hoisted → local → pinned `tsc` fallback
- `wrangler.jsonc` — `USER_QUOTA_DO` binding + `v1` migration, `DESTINATION_MODE="public"`

## e2e / deploy / scripts

- `e2e/webssh.spec.ts` — Playwright cross-browser + full-screen + axe (`@axe-core/playwright`)
- `deploy/docker/` — distroless non-root image + compose
- `deploy/ec2/` — systemd unit, Caddyfile, `.env.example`
- `deploy/fly/` — Fly.io config
- `scripts/` — token build/lint, build verify, EOL check
- `.github/workflows/` — `ci.yml` (heavy tests), `pages.yml`, `gateway-release.yml`, `security.yml`
