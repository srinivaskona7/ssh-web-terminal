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
| **Cross-Site WebSocket Hijacking (CSWSH)** | `internal/auth` enforces strict `Origin` allowlisting (`ALLOWED_ORIGINS`) and OIDC token validation before upgrading `/ws`. | `apps/gateway/internal/auth/auth_test.go` |
| **Memory Exhaustion (Browser or Gateway DoS)** | Protocol enforces a 4 MiB max frame size, per-channel credit-based flow control, a 64 KiB client pending-input cap, a 4 MiB gateway ring buffer, and a browser `StorageGuard` (32 MiB default in-flight buffer, 256 MiB local storage cap). | `packages/protocol/src/protocol.test.ts`, `apps/web/src/files/files.test.ts` |
| **Sensitive Data Leakage in Logs** | `internal/audit` emits structured JSON events containing only metadata (`timestamp`, `event`, `user_id`, `session_id`, `target_host`, `target_port`, `bytes_rx`, `bytes_tx`) and redacts forbidden keys (`password`, `privateKey`, `passphrase`, `payload`, `token`). | `apps/gateway/internal/audit/audit_test.go` |
