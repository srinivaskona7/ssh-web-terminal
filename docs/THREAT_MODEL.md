# WebSSH Studio — Threat Model & Security Posture

## 1. Trust Boundaries
1. **Browser Client (`apps/web`)**: Holds non-extractable WebCrypto private keys in IndexedDB, known-hosts TOFU/pinned SHA-256 fingerprints, and user preferences.
2. **WebSocket-to-SSH Gateway (`apps/gateway`)**: Terminates `wss://`, validates OIDC Bearer tokens and `Origin` headers, enforces SSRF destination policy and per-user rate limits, holds an in-memory 4 MiB output ring buffer per active session during the reconnect grace period, and dials SSH targets. **The gateway never possesses private keys.**
3. **Target SSH Hosts**: Authenticate the user via SSH `publickey` challenges signed remotely by the browser.

## 2. Key Threats & Mitigations

| Threat | Mitigation | Verification |
|---|---|---|
| **Private Key Exfiltration (XSS / Gateway Compromise)** | Keys are generated or imported as WebCrypto `CryptoKey` objects with `extractable: false`. Metadata is wrapped with AES-256-GCM derived via a memory-hard KDF. The gateway only receives signatures over single-session SSH auth challenges (`sign_request` -> `sign_response`). | `apps/web/src/vault/vault.test.ts`, `apps/gateway/internal/sshbridge/sshbridge_test.go` |
| **Server-Side Request Forgery (SSRF) via Gateway** | `internal/policy` resolves hostnames and validates every resolved IP immediately prior to dialing. Loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), cloud metadata (`169.254.169.254`), multicast, unspecified, and RFC1918 private ranges are blocked by default unless explicitly allowlisted via `DEST_ALLOWLIST`. | `apps/gateway/internal/policy/policy_test.go` |
| **Man-in-the-Middle (MITM) on SSH Hop** | Gateway sends `hostkey_prompt` with the host's SHA-256 public key fingerprint before completing the SSH handshake. Browser verifies against `KnownHostsStore`. Any key change triggers a blocking red warning requiring explicit user override. | `apps/web/src/vault/vault.test.ts`, `e2e/webssh.spec.ts` |
| **Cross-Site WebSocket Hijacking (CSWSH)** | `internal/auth` enforces strict `Origin` allowlisting (`ALLOWED_ORIGINS`) and OIDC token validation before upgrading `/ws`. The relay applies the same origin check to the guest `POST /auth/ticket` endpoint. | `apps/gateway/internal/auth/auth_test.go`, `apps/relay/src/relay.test.ts` |
| **Automated abuse of guest connections** | Guest mode holds no account, so access is gated by Cloudflare Turnstile verified server-side (`TURNSTILE_SECRET_KEY`). A pass buys a 5-minute HS256 ticket whose signed claims pin `dst`/`dpt` to one host and port; reuse elsewhere returns `403 ERR_TICKET_SCOPE` before DNS or TCP. Quotas key on `guest:<CF-Connecting-IP>` through the same `USER_QUOTA_DO`. Turnstile proves a human, **not** an identity: destination validation and SSH authentication still apply. | `apps/relay/src/relay.test.ts` |
| **Memory Exhaustion (Browser or Gateway DoS)** | Protocol enforces a 4 MiB max frame size, per-channel credit-based flow control, a 64 KiB client pending-input cap, a 4 MiB gateway ring buffer, and a browser `StorageGuard` (32 MiB default in-flight buffer, 256 MiB local storage cap). | `packages/protocol/src/protocol.test.ts`, `apps/web/src/files/files.test.ts` |
| **Sensitive Data Leakage in Logs** | `internal/audit` emits structured JSON events containing only metadata (`timestamp`, `event`, `user_id`, `session_id`, `target_host`, `target_port`, `bytes_rx`, `bytes_tx`) and redacts forbidden keys (`password`, `privateKey`, `passphrase`, `payload`, `token`). | `apps/gateway/internal/audit/audit_test.go` |

## 3. Accepted Risks & Constraints

| Risk | Status | Constraint |
|---|---|---|
| **Guest ticket appears in the `/ws` query string** | Accepted — inherited transport contract | The client passes the ticket as `?token=` (and the subprotocol header), so edge request logs can capture it. Mitigations: 5-minute (max 1-hour) expiry, single host/port scope enforced before DNS/TCP, no account or long-lived authority attached, and an IP-keyed quota. Moving the token to the subprotocol header alone is a separate transport change. |
| **Turnstile is an external script** | Accepted — the one deliberate exception to the zero-CDN rule | The Turnstile widget loads from `https://challenges.cloudflare.com` (`script-src` and `frame-src` in `apps/web/index.html`). No other external origin is allowed; all product fonts, icons and styles stay self-hosted. The guest flow degrades to account mode if the widget cannot load. |
| **Recipe values reach `sh -c` argv** | Latent — no catalog recipe sets `sensitive: true` today | Job scripts are base64-encoded and passed as a single `sh -c` argument (`apps/web/src/jobs/remote-job-runner.ts`), so anyone able to read `ps` on the target can see the decoded command. `recipes/engine.ts` redacts sensitive values for display only. **Before any field is marked `sensitive: true`, write the job script through SFTP (mode 0700) instead of passing it in argv**, and keep the value out of `variables` in job history. |
