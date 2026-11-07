# Security Model

Full version: `docs/THREAT_MODEL.md`. This file is the agent-facing summary.

## Trust Boundaries

1. **Browser (`apps/web`)** — Holds non-extractable WebCrypto keys (IndexedDB), known-hosts TOFU pins, prefs. Never transmits private keys.
2. **Gateway (`apps/gateway`)** — Terminates `wss://`, validates OIDC/token + Origin, SSRF policy, rate limits, 4 MiB ring buffer. Dials SSH. **Never possesses private keys.**
3. **Relay (`apps/relay`)** — Authenticates WS, validates destination, bridges ciphertext. Never sees plaintext SSH or keys.
4. **Target host** — SSH `publickey` challenges signed remotely by browser.

## Threats → Mitigations

| Threat | Mitigation | Verified By |
|--------|------------|-------------|
| Key exfil (XSS / gateway compromise) | `extractable: false` CryptoKeys, AES-256-GCM wrap (Argon2id/PBKDF2), gateway only gets per-session signatures | `vault.test.ts`, `sshbridge_test.go` |
| SSRF via gateway/relay | Resolve-then-validate, block loopback/link-local/metadata/RFC1918/CGNAT/multicast/reserved/mapped-IPv6/encoded IPs, anti-rebinding DNS pinning (connect to validated IP) | `policy_test.go`, `relay.test.ts` |
| MITM host-key swap | `hostkey_prompt` + TOFU. Mismatch = blocking red warning, explicit override | `vault.test.ts`, `e2e/webssh.spec.ts` |
| CSWSH | Strict `ALLOWED_ORIGINS` on both gateway `/ws` and relay `POST /auth/ticket` | `auth_test.go`, `relay.test.ts` |
| Guest abuse (no account) | Cloudflare Turnstile server-verified, 5-min single-host/port HS256 ticket, per-IP quota `guest:<CF-Connecting-IP>`, `ERR_TICKET_SCOPE` before DNS/TCP | `relay.test.ts` |
| DoS / memory exhaustion | 4 MiB max frame, credit flow control, 64 KiB pending input, 4 MiB gateway ring, StorageGuard, per-user concurrent + per-min attempt limits via `USER_QUOTA_DO` | `protocol.test.ts`, `files.test.ts` |
| Log leakage | Audit emits metadata only; redacts `password`, `privateKey`, `passphrase`, `payload`, `token` | `audit_test.go` |

## Auth Flows

### Gateway
- `GATEWAY_AUTH_TOKEN` constant-time check + optional `OIDC_ISSUER` JWT verify + `ALLOWED_ORIGINS` enforcement before WS upgrade.
- `REQUIRE_TLS=1` enforces `r.TLS` / `X-Forwarded-Proto: https`.

### Relay
- **Guest (default when `VITE_TURNSTILE_SITE_KEY` set):** Turnstile token → `POST /auth/ticket` → 5-min (max 1h) ticket scoped to one `dst`+`dpt`. Quota keyed by edge IP.
- **Account/Admin (`POST /auth/session`):** `AUTH_USERS_JSON` user/pass → 15-min HS256 JWT (`iss`/`aud`/`sub`/`iat`/`exp`/`jti`) via `SESSION_SIGNING_SECRET`. Stored in `sessionStorage`, never URL.
- **Shared token (`RELAY_AUTH_TOKEN`):** Only when `ENABLE_ADMIN_SHARED_TOKEN="1"`. For admin/CI only.
- Ticket travels as `?token=` on `/ws` (transport contract) — scoped, short-lived, no account authority.

## Secrets Handling

- Never commit: `SESSION_SIGNING_SECRET`, `AUTH_USERS_JSON`, `TURNSTILE_SECRET_KEY`, `GATEWAY_AUTH_TOKEN`, `.dev.vars`.
- `/healthz` reports missing config names without values.
- `USER_QUOTA_DO` missing binding → SSH blocked.
- K8s Secrets never listed/decoded in UI. Docker `Config.Env`, Terraform sensitive attrs redacted before storage.
- Browser keys: zeroize `Uint8Array` buffers after use; strings cleared best-effort (immutable by JS design).

## Accepted Risks

- Ticket in `/ws` query string can land in edge logs → mitigated by 5-min expiry + single scope + IP quota.
- Turnstile widget is the one CDN exception (`https://challenges.cloudflare.com`, `script-src`/`frame-src`). Everything else self-hosted.
- Recipe `sensitive:true` not yet used. Before setting it, move job script to SFTP (0700) instead of `sh -c` argv. See Threat Model §3.

## Hard Rules

- No anonymous proxy, no billing code, no Secret reading, no pipe-to-shell installers, no force-push.
- Relay SFTP/editor is shell-fixture — use gateway for production file tools.
