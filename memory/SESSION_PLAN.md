# WebSSH Studio — Session Plan & Milestone Checklist

See synchronized plan in `/Users/sr20536224wipro.com/.apple-gemini/.gemini/tmp/terminal/memory/SESSION_PLAN.md`.

## Ordered Step-by-Step Checklist
- [x] **Step 0 — Stitch & One-Page Plan**
- [x] **Step 1 (M0) — Scaffolding & CI**
- [x] **Step 2 (M1) — Design System (`packages/ui-kit`)**
- [x] **Step 3 (M2) — Protocol & Gateway Core (`packages/protocol`, `apps/gateway`)**
- [x] **Step 4 (M3) — Vault & Remote-Signer Auth**
- [x] **Step 5 (M4) — Workspace, Terminal & Persistence**
- [x] **Step 6 (M5) — File Transfers**
- [x] **Step 7 (M6) — Customization**
- [x] **Step 8 (M7) — Productivity & Security Extras**
- [x] **Step 9 (M8) — Hardening, Verification & Release**
- [x] **Step 10 — Interactive Terminal, Font Scaling & Connection Modal (`apps/web/src/ui/App.tsx`)**
- [x] **Step 11 — macOS Terminal & VS Code IDE UI Upgrade + 50-Feature Interactive Workbench (`apps/web/src/ui/App.tsx`, `app.css`)**
- [x] **Step 12 — Advanced Feature Suite: Telemetry HUD, Port Forwarding Studio, Smart Shell (Blocks/Autocomplete/Safety/Redaction), Advanced SFTP (Diff/Chmod/Tail/Relay), and FIDO2/CA/Playbooks**
- [x] **Step 13 — Clean Minimal Welcome-First Experience, Zen Mode `Escape` Exit, Zero Mock Data, Private Key Upload (`chmod 0400`) + Simple Username/Password Connect, and IDE Mode Enablement Toggle**
- [x] **Step 14 — Rounded Dracula-Style Terminal Studio UI (`#000000` outer, `#131313` rounded container, `#282A36` terminal screen), Top Session Toolbar (`Terminal 1` tab, separator, `+`, Coral Red `#DC514E` Stop control, Fullscreen corner icon, Pop-out icon, `⋯` More custom options), Progressive Lime-to-Pink ASCII Banner (zero copyrights), and Colorful Shell Prompt (`#F1FA8C` user, `#72C7F5` host, `#70DFE3` `~`, `#80F29A` `➜`, `#AAAAAA` block cursor)**
- [x] **Step 15 — Blank Screen on Reload/Upgrade Root-Cause Fix & Production Reliability**
- [x] **Step 16 — End-to-End SSH Truthfulness, Real Gateway WebSocket Bridge, Real Terminal PTY, Subsystem Unification & UI Cleanup**:
  - [x] **16.1 — Audit & Document Implementation Gaps**: Trace `handleConnectSubmit`, `executeTerminalCommand`, `appendCommandBlock`, gateway `/ws` handler, and all hardcoded UI claims.
  - [x] **16.2 — Real WebSocket-to-SSH Gateway & Protocol Extensions (`packages/protocol`, `apps/gateway`)**: Implement RFC 6455 WebSocket upgrade on `/ws`, wire real SSH dialing (password, PEM/OpenSSH private key, and `RemoteSigner`), multi-channel PTY (`open_channel`, `PtyData`, `resize`, `close_channel`), `exec_command`/`exec_result`, SFTP (`list`, `stat`, `read_file`, `write_file`, `chmod`, `upload_*`, `download_read`), and `tunnel_op`/`tunnel_result`; expand `testsshd` to support real PTY/exec commands (`uname -s`, `pwd`, `printf`, `ls`, exit codes) and TCP forwarding.
  - [x] **16.3 — Authoritative Frontend Session, Gateway Transport & Key Validation (`apps/web/src/transport`, `apps/web/src/vault`)**: Validate PEM/OpenSSH private keys accurately (never infer `chmod 0400` from filename), connect via real WebSocket gateway, surface actionable "Gateway not configured / unreachable" state when absent, isolate explicit opt-in Demo Mode, and track real negotiated metadata + per-subsystem readiness.
  - [x] **16.4 — Real Terminal Engine (`@xterm/xterm` + PTY Channel per Tab/Split Pane)**: Connect visible terminal panes to real remote PTY channels, support interactive keys (`Enter`, `Backspace`, arrows, `Tab`, `Ctrl+C`, `Ctrl+D`, `Ctrl+L`, paste), eliminate fabricated `Executed remote/shell command` and hardcoded `08:15:10 (28ms)` cards, and collapse welcome banner on connect.
  - [x] **16.5 — Repair Every IDE Subsystem (SFTP, Editor, Telemetry, Tunnels, Fleet, Snippets, Recording, Keys/Security)**: Wire SFTP file browser/chmod/transfers, Editor load/dirty/save/conflict handling, Telemetry bounded probes & unavailable states, Tunnels backend verification & Honest HTTP preview, Fleet explicit host targeting & concurrency, Recording user vs sample separation, and Key/HostKey security verification.
  - [x] **16.6 — UI Cleanup & Accessibility**: Compact toolbar, collapsible activity rail, move font/theme selectors to Appearance Settings, remove duplicate IDE/theme buttons, move dev/demo galleries out of production views, dynamic terminal fit (`cols`x`rows`), and keyboard-accessible menus with focus restoration.
  - [x] **16.7 — Honest End-to-End Verification & Feature Matrix**: Automated Go + Vitest + Playwright tests against disposable `testsshd` + Gateway verifying real `uname -s` -> `Linux`, `pwd`, `printf`, non-zero exit codes, SFTP, Editor, Tunnels, Host-key mismatch, and reload/startup resilience.
