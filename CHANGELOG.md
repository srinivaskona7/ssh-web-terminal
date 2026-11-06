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
- **Terminal find bar.** Ctrl/Cmd+F opens an in-terminal search overlay; Enter and
  Shift+Enter walk matches, Esc returns focus to the shell, and an unconnected pane says
  "No terminal to search" instead of failing silently. *(Verified — `xterm-adapter.test.ts`
  for `findNext`/`findPrevious`, `focus()`, and the custom key handler that keeps
  Ctrl/Cmd+F and Ctrl/Cmd+K out of xterm; `app.test.tsx` for the bar opening with the caret
  and Esc closing it.)*
- **Broadcast input.** With split panes open, one toggle mirrors every keystroke into both
  PTY channels; input is dropped, not queued, when the transport is down. *(Verified —
  `TerminalPane.test.tsx`.)*
- **Command palette v2.** ↑/↓ move, Enter runs, Esc closes, mouse hover follows the
  selection, and the palette grew to twelve commands including find, broadcast, close tab,
  IDE toggle and the shortcut list. *(Verified — `app.test.tsx` for the broadcast command
  and find-bar focus; the rest is browser-checked.)*
- **Keyboard shortcut cheatsheet.** `?` (or the palette) opens a modal listing only the
  shortcuts that actually have a handler. *(Implemented — browser-checked.)*
- **Theme quick switch.** A header select applies any of the nine themes immediately and
  persists the choice. *(Implemented — persistence covered by `prefs.test.ts`.)*
- **Recent hosts on Welcome.** The five most recently connected saved hosts appear above
  Quick Connect and prefill it in one click. *(Implemented — needs a real connect to exercise.)*
- **Session recording.** Record/Stop in the terminal toolbar captures the active pane's output
  and the keystrokes typed into it into an asciicast v2 file; the Snippets screen replays it
  with a scrubber and downloads it. Recording is refused while disconnected, stops on a
  dropped session, and the captured file never leaves the tab unless downloaded.
  *(Verified — `recording.test.tsx` for the disconnected refusal and the empty state; the
  recorder and parser are covered by `productivity.test.ts`.)*
- **ProxyJump chains are dialled.** The gateway now connects to each jump hop in order before
  the target, reusing the target's credentials and running every hop through the same
  destination policy and host-key prompt; a chain longer than 8 hops is refused with
  `INVALID_JUMP_CHAIN`. The web client sends the chain in the session control message, and
  the connect modal lists the hops that will be used.
  *(Verified — `main_test.go`: `TestConnectProxiesThroughJumpHops` connects through a real
  bastion testsshd to a target testsshd and asserts one host-key prompt per hop in chain
  order; `TestRejectsJumpChainAboveLimit`, `TestRejectsJumpHopOutsideDestinationPolicy` and
  `TestJumpHopFallsBackToTargetUser` cover the cap, the per-hop policy and the blank user.
  A deployed gateway and real network-segmented hosts are still unproven.)*
- **Dual-pane SFTP.** The Files screen gained a local pane backed by the File System Access
  API: pick a folder, upload its files to the current remote directory or download remote
  files straight into it, and drop files onto the remote pane to upload. Browsers without the
  API (Firefox, Safari) are told so instead of being shown a fake listing.
  *(Implemented — `dual-pane.test.tsx` stubs the API and covers the listing, the status line
  and the honest unsupported-browser fallback; moving files both ways still needs a manual
  Chromium run. Upload/Download paths are unchanged.)*
- **Host profiles export / import.** Download saved hosts as JSON and merge a file back;
  profiles contain no keys or passwords, malformed entries are skipped and counted, and a
  write the browser refused is reported as session-only instead of success.
  *(Verified — `hosts.test.ts`.)*
- **IDE editor chrome.** Line-number gutter that follows the editor scroll and a persisted
  soft-wrap toggle (the gutter withdraws while wrapping, since a wrapped line spans several
  visual rows). *(Verified — `LightIde.test.tsx` for the scroll sync, wrap persistence across
  a remount, and the unsaved-close confirm.)*

### Fixed

- **The remote file editor truncated large files and saved the truncation back.** It read
  the file with one `read_file`, which the gateway caps at 256 KiB, so a 300 KiB file was
  shown with its tail missing; saving then wrote that short buffer over the original and
  the conflict check re-read the same first chunk and reported "unchanged". Reads now page
  until the full size is in hand and refuse a short read outright; saves above 3 MiB go
  through the chunked upload ops instead of one oversized frame. *(Verified —
  `remote-file-io.test.ts` covers paging past 256 KiB, the short-read refusal, the size
  cap, a non-advancing gateway, and the chunked write path.)*
- **A successful ProxyJump session left no trace of its hops in the audit log.** Only the
  auth-failure record carried `jumps`, so a bastioned session was indistinguishable from a
  direct one. Both records now name every hop. *(Verified — `TestConnectProxiesThroughJumpHops`
  asserts the success record contains the bastion.)*
- **A blackholing jump host left the connection pending forever.** `ssh.Client.Dial` has no
  timeout, and `ssh.NewClientConn` never reads `ClientConfig.Timeout`, so a hop that accepted
  TCP and then sent no SSH banner hung the connect indefinitely. `SetDeadline` cannot carry
  the bound either: a hop reached through a jump is an `*ssh.chanConn`, whose `SetDeadline`
  always reports "deadline not supported". Each hop now runs under a watchdog that closes
  the connection after 15 s; it pauses while the host-key prompt waits for the user and
  re-arms afterwards, so a server that stalls user authentication cannot hang the connect
  either. *(Verified — `TestDialChainTimesOutOnSilentHandshake`,
  `TestDialChainTimesOutOnSilentTargetThroughJump` and
  `TestDialChainClearsHandshakeDeadline`; each fails without the watchdog.)*
- **Connecting as a second user silently replaced the first user's saved host.** The
  connect-time profile upsert minted `host-<host>-<port>` while the lookup matched user too,
  so `root@10.0.0.5` overwrote `deploy@10.0.0.5` and its alias, folder, tags and notes. The
  fallback id now includes the user.
- **Saving a file of exactly 3 MiB failed with a protocol error.** The inline-write threshold
  ignored base64 and JSON expansion, so a 3 MiB buffer encoded to exactly the 4 MiB frame
  ceiling and `encodeFrame` rejected it before sending. The threshold now leaves 4 KiB of
  headroom and is shared by the editor, the SFTP upload panel and the IDE. *(Verified —
  `remote-file-io.test.ts` chunks a 3 MiB file and fails at the old threshold.)*
- **A recording missed the split pane.** The cast was filtered on the recorded tab's id,
  and the split pane has no tab of its own, so its output and keystrokes were silently
  absent. Output and input from a split on the recorded tab's connection are now captured.
- **Ctrl/Cmd+K did nothing.** The global keydown handler was registered on both `document`
  and `window`, so a single press toggled the palette twice and closed it again. Only the
  `document` listener remains.
- **Ctrl/Cmd+F only worked with the terminal focused.** The workspace now handles it
  wherever focus is except text fields, and Esc hands focus back to the emulator rather
  than the viewport wrapper. xterm swallowed Ctrl+letter on Windows/Linux (the keydown was
  cancelled before it bubbled and `\x06` was typed into the remote shell), so the emulator
  now declines Ctrl/Cmd+F and Ctrl/Cmd+K and lets the app handle them. *(Verified —
  `xterm-adapter.test.ts` for `findNext`/`findPrevious`, `focus()` and the key hand-off.)*
- **Palette "Broadcast input" could switch broadcasting off.** With a single pane the
  command toggled the flag blindly, so a broadcast left on from an earlier split turned
  OFF while the split stayed closed. It now opens the split and turns broadcast on the
  first time, and only toggles once a split exists. *(Verified — `app.test.tsx`.)*
- **Palette "Close current tab" used a first-render snapshot.** The command registry was
  memoised on `[isFullscreen]`, so its commands closed over the initial empty tab list: the
  UI reset to a disconnected "Terminal 1" while the live transports stayed open. The
  registry is rebuilt each render.
- **Typing `?` in the terminal opened the shortcut cheatsheet.** The local line editor is a
  div, so the global handler treated it as a page-level key; only focus outside the terminal
  viewport opens help now.
- **IDE gutter drifted from the code.** Line numbers were 12 px against the editor's 14 px,
  moving a full line out of step every seven rows; the gutter now takes the editor's size.
- Host export and SFTP download revoked their blob URLs in the same task as the click,
  which cancels the download in Firefox; both revokes are now delayed.
- Host import announced success even when `localStorage` refused the write (quota or blocked
  storage), so the imported hosts disappeared on reload; the registry now reports
  `persisted` and the UI says the import is session-only. A file that cannot be read is
  reported instead of leaving an unhandled rejection and a dirty input.
- The IDE gutter restarted at line 1 after soft wrap was turned off while scrolled; it now
  reads the editor's scroll offset when it remounts, and is not rendered at all above 5,000
  lines (one DOM node per line).
- The first tab rendered a separate label from the tab list, so renaming it while another
  tab was active, or clicking any other tab, showed the wrong title.
- The find bar relied on `autoFocus`, which does not move the caret when the emulator holds
  focus; it now claims focus explicitly each time it opens.
- Escape now closes the command palette and the shortcut sheet wherever focus sits; only the
  palette's own input handled it before.
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
- The SFTP screen was titled "Dual-Pane" while showing a single remote pane. It is renamed
  honestly and the local pane now exists (see Added).
- Workspace IDE: rename keeps unsaved edits, search hits move the caret, CRLF files save with
  their original line endings, and close/reopen no longer drops a pending save.

### Changed

- **Welcome and header decluttered.** Terminal font family and size moved from the header to
  Settings → Appearance (clamped 11–32 px, same as the `/font` command). The welcome card's
  duplicate Open Terminal / Open IDE row is removed (use the rail). Quick Connect Host, Username
  and Port share one grid that stays inside the card. The disabled Record button explains
  itself on hover. Rail group titles use the secondary foreground token and preset chips are
  larger.

- **Initial bundle code-split.** The Workspace IDE, capability matrix and server modules
  (Docker, Kubernetes, git, deployments, automations, activity) load on first open instead
  of at startup, so the terminal is interactive before those chunks parse.
- **Shell chrome condensed.** One 44 px header row for tabs and controls, the navigation rail
  regrouped as Home · Workspace presets · Sessions · Operations · Workspace tools with
  **Settings and the IDE toggle pinned at the rail's foot**, the touch key row hidden on a
  desktop pointer, and a single 32 px status bar. The terminal frame was tightened so the
  emulator keeps the pixels.
- Status bar rebuilt around one health trigger (`● Connected · target · RTT · uptime`); the
  cipher and version moved into the details panel.
- Session tabs keep their own emulator; a second connection never closes the first.

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
  *(as of 1.0.0, hops were not traversed; the chain is dialled as of Unreleased)*.

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
- ProxyJump chains are dialled by the gateway only; the Cloudflare relay refuses a chain
  rather than silently connecting direct. The chain is proven against two local testsshd
  instances, not against real network-segmented hosts.
- **ProxyJump credential model**: every hop authenticates with the target's credentials, and
  the connect modal says so. Do not jump through a bastion that must not hold the target's
  password or key; per-hop credentials are not implemented yet. The audit log now records the
  hop path (`jumps`) on both success and failure.

## Test suite

- Vitest: `npm test` — 31 files / 223 tests.
- Go: `npm run test:go`.
- Playwright: `npm run test:e2e` — Chromium and WebKit start the Go gateway against its
  embedded testsshd and type real commands whose output is read from the emulator buffer.
  The Playwright Firefox build does not start on this macOS host (`Could not find profile
  folder`); that project is blocked by the environment, not by the app.
- Design tokens: `npm run lint:tokens`.
