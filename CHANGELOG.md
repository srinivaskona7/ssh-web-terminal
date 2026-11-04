# Changelog

All notable changes to WebSSH Studio. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

Status words are the same as `docs/FEATURES.md`:

- **Verified** — exercised by a test in this repository.
- **Implemented** — the code path exists and type-checks, but has not been run against a
  real server in this build.
- **Conditional** — needs a prerequisite the app cannot supply (gateway, `sudo -n`, a CLI).

## [Unreleased] — 2026-11-04

### Added

- **Session reconnect.** A dropped gateway socket reconnects automatically with exponential
  backoff (5 attempts, manual "Reconnect now"), and resumes the same server-side session via
  `hello` + `resume {sessionId, token, lastSeq}`; the gateway replays buffered frames.
  *(Implemented — `reconnect.test.ts`; server side needs a deployed gateway.)*
- **Relay reconnect.** The Cloudflare relay keeps no server-side session, so reconnecting
  there starts a new shell; the UI states this instead of implying a resume. *(Verified.)*
- **Connection health panel.** Status-bar toggle opens live RTT, uptime, reconnect count,
  transport, cipher, key exchange and server version. *(Verified — `session-health.test.ts`,
  browser-checked.)*
- **Workspace IDE.** Browse/create/rename/delete over SFTP, UTF-8 editor with 1.2 s
  auto-save, read-before-write conflict refusal, CRLF preservation, chunked uploads above
  3 MiB, find/replace, go-to-line, comment/duplicate/move line, project search, quick open,
  git status and diff, command runner with history and pinned presets. *(Verified; no
  language servers, debugger or extension host.)*
- **Creator card on the Welcome screen.** Monogram avatar, name, role and link chips
  (GitHub, LinkedIn, email) over a soft animated aurora; links are data in
  `apps/web/src/ui/profile.ts` and a link with no target is not rendered. Motion is
  suppressed under `prefers-reduced-motion`.
- **Settings and rail reorganisation.** Settings split into Appearance / Keyboard /
  Maintenance; workspace tools grouped in the rail; `Button` supports `aria-pressed`.

### Changed

- **Shell chrome condensed.** One 44 px header row for tabs and controls, the navigation rail
  regrouped as Home · Workspace presets · Sessions · Operations · Workspace tools with
  **Settings and the IDE toggle pinned at the rail's foot**, the touch key row hidden on a
  desktop pointer, and a single 32 px status bar. The terminal frame was tightened so the
  emulator keeps the pixels.
- Status bar rebuilt around one health trigger (`● Connected · target · RTT · uptime`); the
  cipher and version moved into the details panel.
- Session tabs keep their own emulator; a second connection never closes the first.

### Fixed

- xterm's own stylesheet was never imported: its hidden helper textarea rendered as a white
  box over the terminal and the scrollbar kept light-theme colours.
- The ⋯ menu was clipped by the header's overflow rules and could not be clicked;
  the header no longer clips and the menu sits outside the scrolling controls row.
- Native scrollbars inherited the browser's light theme inside the dark UI; they now follow
  the palette, and the muted text token was raised to `#9aa4b2` (7.2:1, passes WCAG AA).
- The rail's third preset ("Operate") was clipped and unclickable; the presets are a
  3-column grid and no longer duplicate the selected-state accent.
- The remote editor overflowed the panel horizontally and rendered in proportional type; it
  is now monospaced and never exceeds the panel width.
- The server-version string had left the status bar and broken the e2e assertion; it is back.
- Disconnect is disabled while no session exists, and the terminal's empty state now carries
  a Connect button.
- Workspace IDE: Enter now carries the current indentation and opens one level after a
  bracket; the editor fills the remaining pane height instead of stopping at 320 px.
- The connection panel reported `Uptime 0s` while disconnected; it now says **not reported**.
- The UI showed `chacha20-poly1305` and `SSH-2.0-OpenSSH` before any negotiation happened.
  Negotiated values now start empty and render **not reported**.
- The SFTP screen was titled "Dual-Pane" while showing a single remote pane. Renamed
  honestly; a true local↔remote pane is still to build.
- Workspace IDE: rename keeps unsaved edits, search hits move the caret, CRLF files save with
  their original line endings, and close/reopen no longer drops a pending save.

### Security

- Relay and gateway keep authentication, origin checks, destination validation, quotas and
  connection limits; there is no anonymous proxy path.
- Non-extractable keys stay in browser WebCrypto/IndexedDB; the gateway authenticates through
  `sign_request` / `sign_response`.

## [1.0.0] — 2026-11-04

Baseline of the current product. Everything below exists in this repository.

### Connection and identity

- Browser SSH-2.0 over the Cloudflare relay *(Verified)*; Go WebSocket SSH/SFTP gateway
  *(Implemented — needs a deployed endpoint)*.
- Guest connections without an account: Turnstile → short-lived ticket pinned to host/port
  *(Verified)*; relay login with a short-lived JWT *(Verified)*.
- Per-user quotas, destination validation and anti-rebinding pinning *(Verified)*.
- Host-key trust-on-first-use with mismatch blocking *(Verified)*; non-extractable key vault
  *(Verified)*.

### Terminal and workspace

- One xterm.js emulator per pane, PTY input/output, per-channel resize, WebGL → canvas → DOM
  fallback *(Verified, except the GPU-reset path)*.
- Tabs, split panes, workspace presets, resizable rail *(see `docs/FEATURES.md` for the
  status of each row)*.
- Command palette, snippets, keybindings, asciicast v2 recording, bounded scrollback
  *(Verified)*.
- Port forwarding UI for `-L` / `-R` / `-D`; ProxyJump chains are parsed and displayed
  *(Implemented — hops are not traversed yet)*.

### Files and editor

- SFTP v3 client: list, stat, read, atomic write, `~` expansion, resumable uploads
  *(Verified)*.
- Transfer queue with bounded concurrency and storage caps *(Verified)*; browser
  upload/download *(Implemented)*.
- Remote editor with read-before-write conflict refusal *(Implemented)*; larger edits happen
  in the Workspace IDE.

### Discovery, recipes, jobs and operations

- Read-only capability discovery *(Verified)*; versioned recipes with preflight and plan
  preview *(Verified)*.
- Durable detached jobs (`setsid` + markers) with monitor, cancel and reattach *(Verified)*;
  command-step jobs *(Implemented)*.
- Live CPU/memory/disk/network sampling and process list *(Verified)*; service actions,
  reboot and power-off *(Conditional — `sudo -n`)*.
- Docker, Kubernetes (Secrets never read), git, project detection and deployment plans,
  Python automation *(Implemented/Conditional as marked in the feature matrix)*.

### Deliberately not provided

- Anonymous public TCP proxy, payments/tiers/paywalls, reading Kubernetes Secret values by
  default, pipe-to-shell installers, silent force-push or history rewrite.

## Known limits

- Real-server verification against a disposable host is not claimed; rows marked
  *Implemented* still need that run (`docs/RUNBOOK.md`).
- The relay cannot resume a shell, and SFTP/remote editor/ring-buffer resume require the Go
  gateway.
- The Workspace IDE refuses binary and non-UTF-8 files and installs nothing on the server.
- Port-forwarding rules can be created and edited, but ProxyJump hops are not yet dialled.

## Test suite

- Vitest: `npm test` — 28 files / 179 tests.
- Go: `npm run test:go`.
- Playwright: `npm run test:e2e` (cross-browser, full-screen, accessibility).
- Design tokens: `npm run lint:tokens`.
