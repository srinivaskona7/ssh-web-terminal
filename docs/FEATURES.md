# WebSSH Studio — 50-Feature Traceability Matrix

| # | Category | Feature | Module | Automated Verification / Test |
|---|---|---|---|---|
| 1 | Connection | In-browser key generation (Ed25519 / ECDSA P-256 non-extractable) | `apps/web/src/vault/vault.ts` | `apps/web/src/vault/vault.test.ts` |
| 2 | Connection | Public key export (`authorized_keys` snippet) | `apps/web/src/vault/ssh-wire.ts` | `apps/web/src/vault/vault.test.ts` |
| 3 | Connection | Private key import (OpenSSH/PEM into encrypted IndexedDB) | `apps/web/src/vault/vault.ts` | `apps/web/src/vault/vault.test.ts` |
| 4 | Connection | One-time key deployment (`ssh-copy-id` equivalent) | `apps/gateway/internal/sshbridge/sshbridge.go` | `apps/gateway/internal/sshbridge/sshbridge_test.go` |
| 5 | Connection | Saved host profiles (tags, folders, favorites, notes) | `apps/web/src/hosts/index.ts` | `apps/web/src/hosts/hosts.test.ts` |
| 6 | Connection | Automatic reconnect (exponential backoff + ±25% jitter) | `apps/web/src/transport/transport.ts` | `apps/web/src/transport/transport.test.ts` |
| 7 | Connection | Persistent sessions with replay (4 MiB gateway ring buffer) | `apps/gateway/internal/session/session.go` | `apps/gateway/internal/session/session_test.go` |
| 8 | Connection | ProxyJump chains (multi-hop bastion dialing) | `apps/gateway/internal/sshbridge/sshbridge.go` | `apps/gateway/internal/sshbridge/sshbridge_test.go` |
| 9 | Terminal | GPU-accelerated rendering (WebGL -> Canvas -> DOM fallback) | `apps/web/src/terminal/xterm-adapter.ts` | `apps/web/src/terminal/terminal.test.ts` |
| 10 | Terminal | Split panes (horizontal/vertical binary tree with ratios) | `apps/web/src/terminal/workspace-state.ts` | `apps/web/src/terminal/terminal.test.ts` |
| 11 | Terminal | Tabs (drag-reorderable, renamable, status dots) | `apps/web/src/terminal/workspace-state.ts` | `apps/web/src/terminal/terminal.test.ts` |
| 12 | Terminal | Scrollback search and caps (10k default, 100k hard max) | `apps/web/src/terminal/xterm-adapter.ts` | `apps/web/src/terminal/terminal.test.ts` |
| 13 | Terminal | Immersive full-screen mode (Fullscreen API, hover bar, 100dvh fallback) | `apps/web/src/terminal/workspace-state.ts` | `e2e/webssh.spec.ts` & `terminal.test.ts` |
| 14 | Terminal | Full Unicode support (unicode11 wide chars, emoji, IME) | `apps/web/src/terminal/xterm-adapter.ts` | `apps/web/src/terminal/terminal.test.ts` |
| 15 | Terminal | Rich output (true color, OSC 8 hyperlinks, inline images) | `apps/web/src/terminal/xterm-adapter.ts` | `apps/web/src/terminal/terminal.test.ts` |
| 16 | Terminal | Safe paste (bracketed paste + multi-line/suspicious warning) | `apps/web/src/terminal/xterm-adapter.ts` | `apps/web/src/terminal/terminal.test.ts` |
| 17 | Terminal | Connection status bar (RTT, throughput, cipher, hideable) | `apps/web/src/ui/App.tsx` | `e2e/webssh.spec.ts` |
| 18 | Files | Drag-and-drop upload | `apps/web/src/files/transfer-engine.ts` | `apps/web/src/files/files.test.ts` |
| 19 | Files | Folder upload (recursive directory tree creation first) | `apps/web/src/files/transfer-engine.ts` | `apps/web/src/files/files.test.ts` |
| 20 | Files | Chunked resumable transfers (256 KiB chunks, SHA-256, `.part` offset resume) | `apps/web/src/files/transfer-engine.ts` & `sshbridge.go` | `apps/web/src/files/files.test.ts` & `sshbridge_test.go` |
| 21 | Files | Streaming downloads (FileSystemWritableFileStream + bounded fallback) | `apps/web/src/files/transfer-engine.ts` | `apps/web/src/files/files.test.ts` |
| 22 | Files | Dual-pane SFTP browser (sorting, filtering, directory-first) | `apps/web/src/files/transfer-engine.ts` | `apps/web/src/files/files.test.ts` |
| 23 | Files | Transfer queue (pause, resume, cancel, concurrency cap) | `apps/web/src/files/transfer-engine.ts` | `apps/web/src/files/files.test.ts` |
| 24 | Files | Storage and memory meter (`StorageGuard`) | `apps/web/src/files/transfer-engine.ts` | `apps/web/src/files/files.test.ts` |
| 25 | Files | Remote file editor (in-browser edit + SFTP atomic save) | `apps/web/src/files/transfer-engine.ts` | `apps/web/src/files/files.test.ts` |
| 26 | Files | Streaming folder download (ZIP / ZIP64 streaming writer) | `apps/web/src/files/zip-stream.ts` | `apps/web/src/files/files.test.ts` |
| 27 | Customization | Theme library (Dark, Light, High-Contrast, Solarized, Dracula, Nord, Gruvbox, Tokyo Night, One Dark) | `packages/ui-kit/tokens.json` | `packages/ui-kit/src/ui-kit.test.ts` |
| 28 | Customization | Custom theme editor (16-color ANSI palette + WCAG contrast check) | `apps/web/src/prefs/index.ts` | `apps/web/src/prefs/prefs.test.ts` |
| 29 | Customization | Font selection (self-hosted WOFF2 + Local Font Access API) | `apps/web/src/prefs/index.ts` | `apps/web/src/prefs/prefs.test.ts` |
| 30 | Customization | Typography controls (size, line height, letter spacing, ligatures) | `apps/web/src/prefs/index.ts` | `apps/web/src/prefs/prefs.test.ts` |
| 31 | Customization | Layout presets (sidebar-left/right, bottom-files, compact, zen) | `apps/web/src/prefs/index.ts` | `apps/web/src/prefs/prefs.test.ts` |
| 32 | Customization | Cursor and surface options (shape, blink, opacity, background) | `apps/web/src/prefs/index.ts` | `apps/web/src/prefs/prefs.test.ts` |
| 33 | Customization | Per-host overrides (theme, font, layout per host profile) | `apps/web/src/prefs/index.ts` | `apps/web/src/prefs/prefs.test.ts` |
| 34 | Customization | Portable preferences (schemaVersion v1->v2 migration, JSON import/export) | `apps/web/src/prefs/index.ts` | `apps/web/src/prefs/prefs.test.ts` |
| 35 | Security | Host key verification (TOFU pinning + blocking red mismatch modal) | `apps/web/src/vault/known-hosts.ts` | `apps/web/src/vault/vault.test.ts` & `e2e/webssh.spec.ts` |
| 36 | Security | Passphrase-locked vault (memory-hard KDF + AES-256-GCM wrapping) | `apps/web/src/vault/vault.ts` | `apps/web/src/vault/vault.test.ts` |
| 37 | Security | Auto-lock (idle timeout, tab hide, explicit lock shortcut) | `apps/web/src/vault/vault.ts` | `apps/web/src/vault/vault.test.ts` |
| 38 | Security | Hardened web posture (strict CSP `<meta>`, no-referrer, zero CDN) | `apps/web/index.html` & `scripts/lint-tokens.mjs` | `e2e/webssh.spec.ts` |
| 39 | Security | OIDC gateway authentication & strict `Origin` check | `apps/gateway/internal/auth/auth.go` | `apps/gateway/internal/auth/auth_test.go` |
| 40 | Security | Destination policy guard (blocks loopback, metadata `169.254.169.254`, link-local, RFC1918) | `apps/gateway/internal/policy/policy.go` | `apps/gateway/internal/policy/policy_test.go` |
| 41 | Security | Remote-signer authentication (private key never leaves browser) | `apps/gateway/internal/sshbridge/sshbridge.go` & `vault.ts` | `apps/gateway/internal/sshbridge/sshbridge_test.go` |
| 42 | Security | Metadata-only audit trail (never logs PTY or key material) | `apps/gateway/internal/audit/audit.go` | `apps/gateway/internal/audit/audit_test.go` |
| 43 | Productivity | Command palette (`Cmd/Ctrl+K` fuzzy launcher) | `apps/web/src/ui/productivity.ts` | `apps/web/src/ui/productivity.test.ts` & `e2e/webssh.spec.ts` |
| 44 | Productivity | Snippet library (`{{variable}}` interpolation & tags) | `apps/web/src/ui/productivity.ts` | `apps/web/src/ui/productivity.test.ts` |
| 45 | Productivity | Broadcast input (type across multiple selected panes/tabs) | `apps/web/src/ui/productivity.ts` & `workspace-state.ts` | `apps/web/src/ui/productivity.test.ts` |
| 46 | Productivity | Session recording & replay (asciicast v2 + scrubber + 64 MiB cap) | `apps/web/src/ui/productivity.ts` | `apps/web/src/ui/productivity.test.ts` |
| 47 | Productivity | Custom keybindings (rebindable shortcuts + conflict detection) | `apps/web/src/ui/productivity.ts` | `apps/web/src/ui/productivity.test.ts` |
| 48 | Productivity | `~/.ssh/config` import (`Host`, `HostName`, `User`, `Port`, `ProxyJump`) | `apps/web/src/hosts/index.ts` | `apps/web/src/hosts/hosts.test.ts` |
| 49 | Productivity | Installable PWA (`manifest.webmanifest` + offline `sw.js`) | `apps/web/public/manifest.webmanifest` & `sw.js` | `apps/web/src/main.tsx` |
| 50 | Productivity | Command-completion notifications (OSC 133 `133;D` & bell detection) | `apps/web/src/ui/productivity.ts` & `workspace-state.ts` | `apps/web/src/ui/productivity.test.ts` |
