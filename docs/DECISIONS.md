# Architecture & Engineering Decisions (`DECISIONS.md`)

## ADR-001: Stitch Tool Fallback & Design System Source of Truth
- **Context**: Section 0 Step 1 instructs invoking the integrated Stitch tool with the Section 2.1 brief, and if unavailable or failing, logging the fallback in `docs/DECISIONS.md` and implementing Sections 2.2–2.6 directly while keeping `/design` and `/packages/ui-kit/tokens.json` as the swappable token source of truth.
- **Decision**: Because the Stitch MCP tool is not registered in this CLI runtime, we logged this fallback and generated the complete `/design/tokens.json`, `/design/COMPONENT_SPECS.md`, and `/packages/ui-kit` token compiler from the Section 2.1–2.6 specification. Replacing `/packages/ui-kit/tokens.json` with a future Stitch export automatically updates `tokens.css` and TypeScript token definitions.

## ADR-002: Client Framework & State Management (Preact + Nanostores)
- **Context**: Section 1 specifies TypeScript (strict), Vite, xterm.js, Preact or Lit, and `nanostores`, with CSS custom properties generated from design tokens and zero runtime CSS-in-JS.
- **Decision**: We selected **Preact** with **`nanostores`** (`@nanostores/preact`) for lightweight, deterministic rendering, minimal bundle size, and crisp decoupling between domain modules (`vault`, `transport`, `terminal`, `files`, `prefs`, `hosts`) and the `ui` presentation layer.

## ADR-003: Non-Extractable WebCrypto Keys & IEEE-P1363 to SSH `mpint` Conversion
- **Context**: Browsers support Ed25519 in modern WebCrypto and ECDSA P-256 universally. WebCrypto's ECDSA `sign()` outputs raw IEEE-P1363 `r || s` (64 bytes for P-256), whereas OpenSSH `ecdsa-sha2-nistp256` signatures require SSH wire encoding (`string "ecdsa-sha2-nistp256" || string(mpint r || mpint s)`).
- **Decision**: `vault` generates Ed25519 keys first and falls back to ECDSA P-256 if Ed25519 is unsupported. Private keys generated in-browser are stored as non-extractable `CryptoKey` handles in IndexedDB (`idb`). Imported OpenSSH/PEM private keys are wrapped with AES-GCM-256 derived via Argon2id (with PBKDF2-SHA256 fallback in restricted WASM environments) and imported into non-extractable `CryptoKey` instances for signing, zeroizing temporary buffers (`Uint8Array.fill(0)`) immediately. Note: JavaScript strings are immutable and GC-managed, so passphrase/PEM strings in memory are cleared on best-effort basis after conversion to `Uint8Array`.

## ADR-004: Multiplexed Binary Wire Protocol & Credit-Based Flow Control
- **Context**: A single WebSocket (`wss://`) carries control messages, multiple PTY sessions, and concurrent SFTP transfers without head-of-line blocking or unbounded memory growth.
- **Decision**: Every binary frame uses a 15-byte big-endian header: `[type:u8][channel:u16][seq:u64][len:u32][payload]`.
  - Channel `0` is reserved for JSON-encoded control messages (`hello`, `connect`, `hostkey_prompt`, `hostkey_decision`, `sign_request`, `sign_response`, `resize`, `resume`, `ack`, `credit`, `error`, `resync`).
  - Channels `1..1023` carry PTY streams; channels `1024..65535` carry SFTP chunk streams.
  - Each data channel maintains credit-based backpressure (`credit{channel, bytes}`) and sequence numbers (`seq:u64`) backed by a 4 MiB per-session ring buffer for seamless lossless reconnects.

## ADR-005: Self-Hosted OpenSSH Integration Test Server in Go
- **Context**: CI and local environments may not always have Docker daemon access for `testcontainers` on every runner, while still requiring real end-to-end SSH protocol handshakes, `publickey` callback verification, PTY execution, and SFTP subsystem streaming.
- **Decision**: In `apps/gateway/internal/testsshd`, we provide an embedded, spec-compliant OpenSSH server using `golang.org/x/crypto/ssh` and `github.com/pkg/sftp` (plus optional Docker OpenSSH container support when `DOCKER_HOST` is active). This guarantees 100% deterministic integration testing of remote-signer authentication, host-key TOFU/mismatch, session ring-buffer resume, and chunked `.part` SFTP resume in any environment.
