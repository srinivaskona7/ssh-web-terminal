# WebSSH Studio — Verified Feature Matrix

This file replaces the earlier marketing-style "50 feature" table. Every row below maps to
code that exists in this repository, and the status states exactly how far it has been proven.
`CHANGELOG.md` carries the same material as human-readable release history.

## Status key

| Status | Meaning |
|---|---|
| **Verified** | An automated test in this repo (Vitest, Go or Playwright), named in the proof column, exercises the behaviour. |
| **Verified (unit)** | Proven only against test doubles; no real SSH server took part. |
| **Verified (local e2e)** | Proven by Playwright against the local Go gateway and its embedded testsshd. |
| **Implemented** | The code path exists and type-checks, but has not been run against a real server in this build. |
| **Conditional** | Works only with a prerequisite the app cannot supply (Go gateway, passwordless sudo, a package, a cluster). |
| **Unsupported** | Deliberately not provided. |

No row may be marked *Verified* from a screenshot or a connection banner.

## Connection & identity

| Capability | Module | Status | Proof / prerequisite |
|---|---|---|---|
| Browser SSH-2.0 over the Cloudflare relay | `apps/web/src/transport/browser-ssh-client.ts`, `apps/relay/src` | Verified | `browser-ssh.test.ts`, `apps/relay/src/relay.test.ts` |
| Go gateway WebSocket bridge | `apps/gateway`, `apps/web/src/transport/transport.ts` | Verified (local e2e) | `npm run test:e2e` starts the gateway against its embedded testsshd and types real POSIX commands whose output is read from the emulator buffer (Chromium and WebKit). A deployed endpoint is still needed for production use |
| Guest connections (Turnstile → short-lived ticket, no account) | `apps/relay/src/auth.ts` (`issueGuestTicket`), `apps/relay/src/index.ts` (`POST /auth/ticket`), `apps/web/src/ui/App.tsx` | Verified | `relay.test.ts`, `browser-ssh.test.ts`, `app.test.tsx`; requires `TURNSTILE_SECRET_KEY` on the Worker and `VITE_TURNSTILE_SITE_KEY` at build |
| Guest tickets scoped to one host and port | `apps/relay/src/index.ts` (`ERR_TICKET_SCOPE`) | Verified | `relay.test.ts` |
| Relay user login (short-lived JWT, administrator mode) | `apps/relay/src/auth.ts`, `apps/relay/src/index.ts` | Verified | `relay.test.ts` |
| Per-user quotas and connection limits | `apps/relay/src/index.ts` (`RelayUserQuotaDO`) | Verified | `relay.test.ts` |
| Destination validation / anti-rebinding pinning | `apps/relay/src/policy.ts` | Verified | `relay.test.ts` |
| Host-key TOFU pinning and mismatch blocking | `apps/web/src/vault/known-hosts.ts` | Verified | `vault.test.ts`, `browser-ssh.test.ts` |
| Non-extractable key vault | `apps/web/src/vault/vault.ts` | Verified | `vault.test.ts` |
| ProxyJump chains dialled by the gateway | `apps/gateway/cmd/gateway/main.go`, `apps/gateway/internal/sshbridge` (`DialChain`), `apps/web/src/ui/App.tsx` | Verified (local e2e) | `main_test.go` (connects through a bastion testsshd to a target testsshd and asserts one host-key prompt per hop in chain order; 8-hop cap, per-hop destination policy rejection, blank hop user falls back to the target user); the client sends the chain in the session's `jump` field and the connect modal shows it; audit entries carry the hop path. Every hop authenticates with the target's credentials — the modal states this; per-hop credentials are not implemented. Real network-segmented hosts are still unproven |
| No billing, subscriptions or feature paywalls | entire repository | Verified | no billing code exists |

## Terminal & workspace

| Capability | Module | Status | Proof / prerequisite |
|---|---|---|---|
| One emulator per pane, mounted on DOM availability | `apps/web/src/terminal/TerminalPane.tsx` | Verified (unit) | `TerminalPane.test.tsx`; real-host keyboard/Vim/top proof not re-run in this pass |
| PTY input/output and per-channel resize | `apps/web/src/terminal/TerminalPane.tsx`, `xterm-adapter.ts` | Verified (unit) | `TerminalPane.test.tsx`; needs a connected PTY channel to prove end to end |
| WebGL → canvas → DOM renderer fallback | `apps/web/src/terminal/xterm-adapter.ts` | Implemented | context loss reloads a real fallback and reports the mode; not exercised on a GPU-reset host |
| Independent connections and channel→pane routing | `apps/web/src/session/connection-registry.ts` | Verified (unit) | `connection-registry.test.ts` |
| Gateway session resume after a dropped socket | `apps/web/src/transport/transport.ts` (`LiveGatewaySessionClient.reconnect`) | Implemented | `reconnect.test.ts` (hello + `resume` with the stored session id/token and the last PTY sequence); needs a deployed gateway to prove the server side |
| Relay reconnect (new shell, ring-buffer replay) | `apps/web/src/transport/browser-ssh-client.ts` (`reconnect`) | Verified (unit) | `browser-ssh.test.ts`; the relay keeps no server-side session, so the UI says a new shell was started |
| Live connection health and manual reconnect | `apps/web/src/ui/App.tsx`, `session-health.ts` | Verified | `session-health.test.ts`; rendered status bar and details panel checked in a browser |
| Disconnect ends the session without an automatic retry; Reconnect reopens the connect form for the same host, user, port and jump chain | `apps/web/src/ui/App.tsx` (`handleDisconnect`, `reconnectAfterDisconnect`) | Verified | `e2e/webssh.spec.ts` "manual disconnect cancels retries and a reconnect opens a fresh shell (B07/B08)" against the local gateway and testsshd: no retry banner for 3 s, prefilled form, new SSH handshake |
| Status dots are green only for a live session; connecting and reconnecting are amber, offline, failed and ended sessions are muted, and the rail host dot follows the same state | `apps/web/src/ui/shell/status-dot.ts` (`statusDotClassFor`), `apps/web/src/ui/shell/AppRail.tsx` | Verified | `apps/web/src/ui/shell/status-dot.test.ts` (every `ConnectionState`); `e2e/webssh.spec.ts` B07/B08 asserts the rail dot is green while connected, muted after Disconnect and green again after Reconnect, and the empty-state dot is muted for a user-ended session |
| No placeholder public key is shown or sent: the authorized_keys line, the welcome form's public key and its SHA256 fingerprint exist only after the vault generates a key in this session. Browser-key mode without one is blocked with "Generate a browser key first.", a failed generation reports its error, and the connect payload carries the browser key's fingerprint, the PEM's fingerprint or none for a password | `apps/web/src/ui/App.tsx` (`generatedPubKey`, `pemFp`, `handleGenerateKey`, connect payload), `apps/web/src/ui/shell/WelcomeScreen.tsx` | Verified | `apps/web/src/ui/app.test.tsx` "shows no placeholder public key, requires a generated browser key, and copies only when the clipboard confirms"; `WelcomeScreen.test.tsx` "WelcomeScreen browser key"; `e2e/webssh.spec.ts` B07/B08 (no snippet without a key); `e2e/welcome.spec.ts` axe in every theme and layout at five widths with the missing-key error and the generated key |
| "Copied" appears only after `navigator.clipboard.writeText` resolves; a blocked or missing clipboard shows a warning toast instead | `apps/web/src/ui/App.tsx` (`copyToClipboard`) | Verified (unit) | `apps/web/src/ui/app.test.tsx` (rejecting `writeText`: toast, never "Copied"); `WelcomeScreen.test.tsx` "says Copied only when the app reports the copy succeeded" |
| A Recent Hosts rail item opens the connect form prefilled with that profile's host, user, port and jump chain (each hop's own auth method included), and leaves the live session running. A hop with its own password or key auth refuses to connect (no credential is stored for it) rather than borrowing the target's; a browser-key hop is signed by the vault key it names | `apps/web/src/ui/App.tsx` (`openConnectForProfile`), `apps/web/src/ui/shell/AppRail.tsx` (`onConnectRecent`) | Verified | `e2e/webssh.spec.ts` "a Recent Hosts item opens the connect form for that host" against the local gateway and testsshd; `app.test.tsx` "refuses to connect through a saved hop that has its own password auth" |
| Tabs, split panes, workspace state | `apps/web/src/terminal/workspace-state.ts` | Verified | `terminal.test.ts` |
| Tab status is opening/ready/error, never guessed | `apps/web/src/ui/App.tsx` | Verified (unit) | `app.test.tsx` (second tab waits for `channel_opened`) |
| Local command output lives in an inspector, not the terminal | `apps/web/src/ui/App.tsx`, `app.css` | Verified (unit) | `app.test.tsx` asserts the viewport never contains exec output |
| Welcome connect page: one form, field errors under their field, a route panel stating what the relay or gateway receives per auth method | `apps/web/src/ui/shell/WelcomeScreen.tsx`, `welcome-screen.css`, `DESIGN.md` | Verified | `WelcomeScreen.test.tsx` (host/user/port/password errors inline with `aria-invalid` + `aria-describedby`, other errors in `connect-error-badge`, gateway copy never claims secrets stay in the browser, guest check only in relay mode with a site key, dash runs kept whole); `e2e/welcome.spec.ts` (axe WCAG 2.2 AA in all nine themes, at rest and in each error state; no overflow at 1440/1024/768/390/320 in every auth mode, 44px targets and 16px field text on touch widths, Chromium and WebKit) |
| Creator card with GitHub / LinkedIn / email links (component only; no screen mounts it) | `apps/web/src/ui/ProfileCard.tsx`, `profile.ts` | Verified (unit) | `ProfileCard.test.tsx` (renders only links with a valid target; external links carry `rel="noopener noreferrer"`); not rendered on Welcome since 1750626 |
| Workspace presets Terminal / Develop / Operate | `apps/web/src/prefs/index.ts`, `apps/web/src/ui/App.tsx` | Implemented | persisted through `PreferencesStore` |
| Resizable navigation rail (pointer + keyboard) | `apps/web/src/ui/App.tsx`, `railWidthPx` preference | Implemented | width persists across reloads |
| Command palette, snippets, keybindings | `apps/web/src/ui/productivity.ts` | Verified | `productivity.test.ts` |
| Command palette v2: arrow/Enter/Esc navigation, hover sync, twelve commands | `apps/web/src/ui/App.tsx` | Verified | `app.test.tsx` (arrows move the highlight, Enter runs it, Esc closes; the broadcast command opens the split) |
| Terminal find bar (Ctrl/Cmd+F anywhere in the workspace except text fields, Enter next, Shift+Enter previous, Esc closes and refocuses the shell) | `apps/web/src/ui/App.tsx`, `apps/web/src/terminal/xterm-adapter.ts` (`findNext`/`findPrevious`/`focus`, custom key handler) | Verified | `xterm-adapter.test.ts` (both directions, `focus()`, and Ctrl/Cmd+F/K left to the app so xterm cannot swallow them), `app.test.tsx` (Ctrl+F opens the bar and moves the caret, Esc closes it); "No terminal to search" is browser-checked while disconnected |
| Broadcast input to both split panes | `apps/web/src/terminal/TerminalPane.tsx` (`sendPaneInput`) | Verified (unit) | `TerminalPane.test.tsx` (mirrors bytes, never double-sends, drops input when disconnected); button appears only when split panes > 1 |
| Rename a session tab by double-click | `apps/web/src/ui/App.tsx` | Verified | `app.test.tsx` (double-click renames the active tab; cancelling the prompt leaves the old name) |
| Keyboard shortcut cheatsheet (`?`, also a palette command) | `apps/web/src/ui/App.tsx` | Verified | `app.test.tsx` (opens with `?` outside the terminal, refuses it inside the viewport, closes on Esc) |
| Theme switch in the menubar View menu (nine themes, persisted) | `apps/web/src/ui/App.tsx`, `apps/web/src/prefs` | Verified | `app.test.tsx` (the choice applies to the document root and is written to `webssh.preferences.v2`), `prefs.test.ts` |
| Theme colours meet WCAG 2.2 AA in all nine themes: fg, accent and status text 4.5:1 on canvas, surface and elevated; labels on accent and danger fills 4.5:1; form-control borders 3:1 | `design/tokens.json`, `packages/ui-kit/tokens.json`, `packages/ui-kit/src/contrast.ts` | Verified | `ui-kit.test.ts` ("passes WCAG AA contrast…", "flags status text, labels and control borders…", "defines every colour token in every theme") |
| Stylesheets reference only declared custom properties | `scripts/lint-tokens.mjs` | Verified | `npm run lint:tokens` fails on any `var(--x)` that no stylesheet declares and no code sets |
| Recent hosts kept off the Welcome connect page (Saved Hosts only) | `apps/web/src/ui/App.tsx`, `apps/web/src/hosts/index.ts` | Verified | `app.test.tsx` ("keeps recent hosts off the connection page (Saved Hosts only) and prefills from a saved profile"); registry round-trip covered by `hosts.test.ts` |
| Session recording (asciicast v2), replay and download | `apps/web/src/ui/productivity.ts`, `apps/web/src/ui/App.tsx` | Verified (unit) | `productivity.test.ts` (recorder size cap, asciicast v2 output, timeline scrubbing), `recording.test.tsx` (refused while disconnected, empty state, no fake sample); capturing a live PTY session and the download button are not covered by an automated test |
| Dual-pane SFTP with a local folder (File System Access API) | `apps/web/src/ui/App.tsx` | Implemented | `dual-pane.test.tsx` stubs the API and proves the folder listing, the entry count and the honest "no File System Access API" fallback; the native picker cannot be driven, so move-files-both-ways still needs a manual Chromium run |
| Initial bundle code-split (IDE, server modules, capability matrix) | `apps/web/src/ui/App.tsx` | Implemented | `npm run build` emits `LightIde`, `ServerModules` and `CapabilityMatrixPanel` as separate chunks loaded on first open; no bundle-size assertion in CI |
| The Workspace IDE is reachable from the rail and the command palette | `apps/web/src/ui/shell/AppRail.tsx`, `apps/web/src/ui/App.tsx` | Verified | `app.test.tsx` ("reaches the Workspace IDE from the rail and the command palette"), `e2e/ide.spec.ts` (the rail opens `screen-ide`, the file tree is the real SFTP listing, a file opens over SFTP) |
| Monaco editor with a textarea fallback (lazy-loaded) | `apps/web/src/ui/MonacoEditor.tsx`, `apps/web/src/ui/LightIde.tsx` | Verified | `e2e/ide.spec.ts` ("hands the pane to Monaco") loads the real editor in the browser, asserts the textarea steps aside and returns on the second toggle; `monaco-editor` 0.58.0-dev vendors DOMPurify 3.4.17 and is pinned by the `dompurify` npm override |
| Scrollback caps and bounded buffers | `apps/web/src/terminal/xterm-adapter.ts`, prefs | Verified | `terminal.test.ts`, `prefs.test.ts` |

## Files, SFTP & editor

| Capability | Module | Status | Proof / prerequisite |
|---|---|---|---|
| SFTP v3 client (list, stat, read, atomic write) | `apps/web/src/transport/sftp-client.ts` | Verified | `sftp-client.test.ts` |
| `~` / `~/` expansion across every SFTP operation | `apps/web/src/transport/sftp-client.ts` (`resolvePath`) | Verified | `sftp-client.test.ts` |
| Atomic write keeps the target file mode | `apps/web/src/transport/sftp-client.ts` (`writeFile`) | Verified | `sftp-client.test.ts` |
| Resumable `.webssh-part` uploads | `apps/web/src/transport/sftp-client.ts` | Verified | `sftp-client.test.ts` |
| Transfer queue and bounded concurrency | `apps/web/src/files/transfer-engine.ts` | Verified | `files.test.ts` |
| StorageGuard memory/local caps | `apps/web/src/files/transfer-engine.ts` | Verified | `files.test.ts` |
| Remote editor with conflict refusal | `apps/web/src/ui/App.tsx` (`saveEditorBuffer`), `apps/web/src/files/remote-file-io.ts` | Implemented | reads page until the gateway-reported size is met and refuses a short read, refuses non-UTF-8 instead of saving a lossy decode, saves above ~3 MiB chunk by chunk, compares remote content before writing (`remote-file-io.test.ts`); needs SFTP |
| Workspace IDE: browse, create, rename, delete over SFTP | `apps/web/src/ui/LightIde.tsx`, `ide-editing.ts` | Verified | `LightIde.test.tsx` (create/open/rename/delete), `adapters.test.ts` (chunked paging, canonical child paths); the Go gateway returns 256 KiB read chunks and `adapters.readFile` pages until the reported size is met, refusing a partial read |
| Workspace IDE: UTF-8-only editing | `apps/web/src/session/adapters.ts` (`decodeUtf8Text`) | Verified | `adapters.test.ts` refuses invalid UTF-8; binary files are refused in `LightIde.tsx` |
| Workspace IDE: open/edit files with auto-save (1.2 s debounce) | `apps/web/src/ui/LightIde.tsx` | Verified | `LightIde.test.tsx` (auto-save on, off, and manual save; pending edits flush on unmount) |
| Workspace IDE: read-before-write conflict refusal | `apps/web/src/ui/LightIde.tsx` | Verified | `LightIde.test.tsx`; explicit "Overwrite with my version"; concurrent writers inside the read→write window are not detected |
| Workspace IDE: CRLF preserved, buffers stay LF | `apps/web/src/ui/ide-editing.ts` (`detectEol`), `LightIde.tsx` | Verified | `ide-editing.test.ts`, `LightIde.test.tsx` (a CRLF file saves back with CRLF) |
| Workspace IDE: large writes use chunked upload ops | `apps/web/src/session/adapters.ts` (`chunkedWrite`) | Verified (unit) | `adapters.test.ts`; keeps each frame under the gateway's 4 MiB limit; needs a real gateway for end-to-end proof |
| Workspace IDE: find/replace, go-to-line, comment, duplicate/move line, indent selection, Enter auto-indent | `apps/web/src/ui/ide-editing.ts` | Verified | `ide-editing.test.ts`; Ctrl+D shortcut covered in `LightIde.test.tsx` |
| Workspace IDE: project search, quick open, git status and git diff | `apps/web/src/ui/LightIde.tsx` (`parseGrepMatches`, `parseGitStatus`, `parseDiff`) | Verified | parsing covered in `ide-editing.test.ts`, wiring in `LightIde.test.tsx`; all read-only shell commands, POSIX-quoted |
| Workspace IDE: command runner with history, pinned presets, run-in-project-root | `apps/web/src/ui/LightIde.tsx` | Verified | `LightIde.test.tsx` (run, recall, pin, run-in-root); commands run in a fresh exec channel, so `cd` and shell variables do not persist between commands; command history is in-memory only (never written to local storage) |
| Workspace IDE: saved projects and recent files (browser local storage) | `apps/web/src/ui/LightIde.tsx` | Implemented | no test asserts persistence; storage holds paths only, never file contents |
| Workspace IDE: line-number gutter synced to scroll, soft-wrap toggle (persisted) | `apps/web/src/ui/LightIde.tsx`, `app.css` | Verified | `LightIde.test.tsx` (one number per line, `translateY` follows `scrollTop` and is restored after wrap is turned back off, wrap survives a remount; the gutter is hidden while wrapping and above 5,000 lines) |
| Workspace IDE: confirm before closing an unsaved buffer | `apps/web/src/ui/LightIde.tsx` (`closeFile`) | Verified | `LightIde.test.tsx` (a declined confirm keeps the buffer, an accepted one drops it) |
| Limits of the Workspace IDE | — | — | no language servers, debugger, extension host, terminals or git UI beyond status/diff; binary and non-UTF-8 files are refused; nothing is installed on the server |
| Host profiles export / import as JSON | `apps/web/src/hosts/index.ts` (`exportJson`/`importJson`) | Verified | `hosts.test.ts` (round-trip, bare array, malformed entries skipped, and `persisted: false` reported when browser storage refuses the write); profiles hold no keys or passwords |
| Browser upload / download of a file | `apps/web/src/ui/App.tsx` | Implemented | writes via `sftpOp`, capped at 64 MiB in the panel |
| Binary-safe large transfers | `apps/web/src/files/transfer-engine.ts` | Verified | `files.test.ts` |

## Discovery, recipes & jobs

| Capability | Module | Status | Proof / prerequisite |
|---|---|---|---|
| Read-only capability discovery | `apps/web/src/discovery/capabilities.ts` | Verified | `capabilities.test.ts` |
| Versioned recipe schema and shell escaping | `apps/web/src/recipes/engine.ts`, `types.ts` | Verified | `engine.test.ts` |
| Recipe preflight and plan preview | `apps/web/src/recipes/engine.ts` | Verified | `engine.test.ts` |
| Durable detached jobs (`setsid`, markers) | `apps/web/src/jobs/remote-job-runner.ts` | Verified | `jobs.test.ts` |
| Job monitor / cancel / reattach | `apps/web/src/jobs/job-manager.ts` | Verified | `jobs.test.ts`; Activity panel calls `cancelAndConfirm` |
| Post-install recipe verification from job markers | `apps/web/src/jobs/job-manager.ts` (`verifyJob`), Recipes panel | Verified | `jobs.test.ts`; needs streaming exec (`execStream`) on the transport |
| Command-step jobs for builds and deploys | `apps/web/src/jobs/job-manager.ts` (`startCommandJob`) | Implemented | shares the detached runner; needs a real host |

## Operations

| Capability | Module | Status | Proof / prerequisite |
|---|---|---|---|
| Live CPU / memory / disk / network sampling | `apps/web/src/control/server-control.ts` | Verified | `server-control.test.ts`; blanks fields a host does not report |
| Process list | `apps/web/src/control/server-control.ts` | Verified | `server-control.test.ts` |
| Service list, logs, restart/stop | `apps/web/src/control/server-control.ts` | Conditional | needs `sudo -n` for actions |
| Reboot / power off with typed confirmation | `apps/web/src/control/server-control.ts` | Conditional | needs `sudo -n` |
| Docker containers, images, Compose | `apps/web/src/containers/docker-client.ts` | Implemented | needs docker CLI + socket permission |
| Kubernetes pods, logs, contexts | `apps/web/src/kubernetes/kubectl-client.ts` | Implemented | needs kubeconfig; Secrets are never read |
| Git status, diff, stage, commit | `apps/web/src/git/git-client.ts` | Implemented | needs git and a work tree |
| Project detection and deployment plan | `apps/web/src/projects/projects.ts` | Verified | planner is pure; execution is Implemented |
| Reviewed deployment as a durable job | `apps/web/src/ui/ServerModules.tsx` (`DeploymentsPanel`) | Implemented | needs a project manifest and runtime |
| Python detection and managed cron entries | `apps/web/src/automation/python-automation.ts` | Implemented | needs python3 and a crontab |

| Product sign-in for the hosted relay (administrator mode, under Administrator settings) | `apps/web/src/ui/App.tsx` (`handleRelayLogin`) | Verified | `app.test.tsx`; calls `/auth/session` and stores the short-lived token in `sessionStorage` |

## Deliberately unsupported

| Capability | Why |
|---|---|
| Anonymous public TCP proxy | Every connection is authenticated, origin-checked and destination-validated. |
| Payments / tiers / paywalls | The product has no billing concept. |
| Reading Kubernetes Secret values by default | Secrets are not listed or decoded in the UI. |
| Automatic pipe-to-shell installers | Recipes use package managers and explicit commands only. |
| Silent force-push / history rewrite | Git actions never force-push or reset destructively. |

## Test suite reference

- Vitest: `npm test` at the repo root (834 tests across 65 files as verified on 2026-11-06).
- Go: `npm run test:go` (gateway packages).
- Playwright: `npm run test:e2e` (cross-browser, full-screen, accessibility).
- Token invariant: `npm run lint:tokens`.

Real-server verification against a disposable host is **not** claimed here. The rows marked
Implemented still need that run. `docs/RUNBOOK.md` §5 covers connecting to a target and §6 the
in-browser terminal checks; a scripted disposable-host procedure has not been written yet.
