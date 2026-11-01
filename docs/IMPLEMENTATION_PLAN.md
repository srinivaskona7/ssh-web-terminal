# WebSSH Studio — One-Page Implementation Plan

## 1. Confirmed Stack & Architecture
- **Monorepo**: npm workspaces (`packages/ui-kit`, `packages/protocol`, `apps/web`, `e2e`) + Go 1.22+ module (`apps/gateway`).
- **Frontend (`apps/web`)**: Vite + TypeScript (strict, no `any`) + Preact + `nanostores` + `@xterm/xterm` (with `@xterm/addon-fit`, `@xterm/addon-search`, `@xterm/addon-web-links`, `@xterm/addon-unicode11`, `@xterm/addon-image`, `@xterm/addon-webgl`, `@xterm/addon-canvas`) + `idb`.
- **Design System (`packages/ui-kit` & `/design`)**: Source-of-truth `tokens.json` compiled into `tokens.css` and TypeScript types; 9 built-in themes (Dark primary, Light, High-Contrast, Solarized, Dracula, Nord, Gruvbox, Tokyo Night, One Dark); custom 16-color ANSI editor; self-hosted WOFF2 fonts and 1.5px SVG icons; enforced by `scripts/lint-tokens.mjs`.
- **Protocol (`packages/protocol`)**: 15-byte binary frame `[type:u8][channel:u16][seq:u64][len:u32][payload]` + typed control packets shared between TypeScript and Go.
- **Gateway (`apps/gateway`)**: Go 1.22+, `nhooyr.io/websocket`, `golang.org/x/crypto/ssh`, `github.com/pkg/sftp`, `coreos/go-oidc/v3/oidc`. Includes SSRF Destination Policy Guard, OIDC + Origin verification, Remote Signer (`ssh.Signer` over WebSocket `sign_request`/`sign_response`), 4 MiB ring buffer per session, and atomic `.part` SFTP chunk receiver.

## 2. Milestones & Execution Schedule
- **M0 — Scaffolding & CI**: Workspace setup, `/design` tokens & specs, `.github/workflows/{ci,pages,gateway-release,security}.yml`.
- **M1 — Design System**: Token compiler, CSS custom properties, themes, self-hosted WOFF2 fonts, 1.5px line icons, accessible primitives, component gallery, hardcoded-value linter.
- **M2 — Protocol & Gateway Core**: Binary frame codec (TS + Go), credit-based flow control, OIDC & Origin middleware, SSRF destination guard (blocking loopback, link-local, `169.254.169.254`, RFC1918 by default), rate limits, `/healthz` & `/metrics`, fuzz & unit tests.
- **M3 — Vault & Remote-Signer Auth**: Non-extractable WebCrypto Ed25519 / ECDSA P-256 keys, OpenSSH public key & `authorized_keys` export, PEM/OpenSSH import, Argon2id/AES-GCM vault lock & auto-lock, IEEE-P1363 → SSH `mpint` conversion, TOFU host-key modal (neutral unknown vs blocking red mismatch), one-time key deployment (`ssh-copy-id`), and Go remote-signer SSH integration tests.
- **M4 — Workspace, Terminal & Persistence**: Clean 8px-inset xterm.js workspace, split panes, draggable tabs, Immersive Full-Screen Mode (`F11` / `Cmd/Ctrl+Shift+F`, auto-hiding top overlay, 3s toast, `Escape` lock, `100dvh` pseudo-fullscreen fallback) + Zen mode, exponential backoff with jitter, 64 KiB input queue, 4 MiB gateway ring buffer replay, and tmux auto-attach.
- **M5 — File Transfers**: Dual-pane SFTP browser, drag-and-drop files & folders, 256 KiB chunker + incremental SHA-256 Web Worker, `.part` atomic rename & resume, Storage Guard meter, streaming downloads, streaming ZIP64 folder download, and remote code editor.
- **M6 — Customization**: Theme gallery & live ANSI editor, font picker (bundled WOFF2 + Local Font Access API) & typography sliders, layout presets, cursor & surface opacity/background, per-host overrides, and versioned JSON preference migration/export/import.
- **M7 — Productivity & Security Extras**: Command palette (`Cmd/Ctrl+K`), snippets with variables, broadcast input, asciicast v2 recorder & scrubber player, keybinding editor with conflict warnings, `~/.ssh/config` importer, metadata-only audit log, PWA offline shell, OSC 133 / bell notifications, and mobile special-keys bar.
- **M8 — Hardening & Release**: Threat model, runbook, `docs/FEATURES.md` mapping all 50 features to modules and tests, Docker/Fly configs, and full test/lint/E2E verification.
