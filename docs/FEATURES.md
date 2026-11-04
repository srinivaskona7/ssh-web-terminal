# WebSSH Studio — Verified Feature Matrix

This file replaces the earlier marketing-style "50 feature" table. Every row below maps to
code that exists in this repository, and the status states exactly how far it has been proven.
`CHANGELOG.md` carries the same material as human-readable release history.

## Status key

| Status | Meaning |
|---|---|
| **Verified** | Exercised by a Vitest or Go test in this repo (proof column). |
| **Implemented** | The code path exists and type-checks, but has not been run against a real server in this build. |
| **Conditional** | Works only with a prerequisite the app cannot supply (Go gateway, passwordless sudo, a package, a cluster). |
| **Unsupported** | Deliberately not provided. |

No row may be marked *Verified* from a screenshot or a connection banner.

## Connection & identity

| Capability | Module | Status | Proof / prerequisite |
|---|---|---|---|
| Browser SSH-2.0 over the Cloudflare relay | `apps/web/src/transport/browser-ssh-client.ts`, `apps/relay/src` | Verified | `browser-ssh.test.ts`, `apps/relay/src/relay.test.ts` |
| Go gateway WebSocket bridge | `apps/gateway`, `apps/web/src/transport/transport.ts` | Implemented | Go tests exist; needs a deployed gateway endpoint |
| Guest connections (Turnstile → short-lived ticket, no account) | `apps/relay/src/auth.ts` (`issueGuestTicket`), `apps/relay/src/index.ts` (`POST /auth/ticket`), `apps/web/src/ui/App.tsx` | Verified | `relay.test.ts`, `browser-ssh.test.ts`, `app.test.tsx`; requires `TURNSTILE_SECRET_KEY` on the Worker and `VITE_TURNSTILE_SITE_KEY` at build |
| Guest tickets scoped to one host and port | `apps/relay/src/index.ts` (`ERR_TICKET_SCOPE`) | Verified | `relay.test.ts` |
| Relay user login (short-lived JWT, administrator mode) | `apps/relay/src/auth.ts`, `apps/relay/src/index.ts` | Verified | `relay.test.ts` |
| Per-user quotas and connection limits | `apps/relay/src/index.ts` (`RelayUserQuotaDO`) | Verified | `relay.test.ts` |
| Destination validation / anti-rebinding pinning | `apps/relay/src/policy.ts` | Verified | `relay.test.ts` |
| Host-key TOFU pinning and mismatch blocking | `apps/web/src/vault/known-hosts.ts` | Verified | `vault.test.ts`, `browser-ssh.test.ts` |
| Non-extractable key vault | `apps/web/src/vault/vault.ts` | Verified | `vault.test.ts` |
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
| Tabs, split panes, workspace state | `apps/web/src/terminal/workspace-state.ts` | Verified | `terminal.test.ts` |
| Tab status is opening/ready/error, never guessed | `apps/web/src/ui/App.tsx` | Verified (unit) | `app.test.tsx` (second tab waits for `channel_opened`) |
| Local command output lives in an inspector, not the terminal | `apps/web/src/ui/App.tsx`, `app.css` | Verified (unit) | `app.test.tsx` asserts the viewport never contains exec output |
| Creator card with GitHub / LinkedIn / email links on Welcome | `apps/web/src/ui/ProfileCard.tsx`, `profile.ts` | Verified | `ProfileCard.test.tsx` (renders only links with a valid target; external links carry `rel="noopener noreferrer"`); LinkedIn and email stay hidden until their `href` is filled in |
| Workspace presets Terminal / Develop / Operate | `apps/web/src/prefs/index.ts`, `apps/web/src/ui/App.tsx` | Implemented | persisted through `PreferencesStore` |
| Resizable navigation rail (pointer + keyboard) | `apps/web/src/ui/App.tsx`, `railWidthPx` preference | Implemented | width persists across reloads |
| Command palette, snippets, keybindings | `apps/web/src/ui/productivity.ts` | Verified | `productivity.test.ts` |
| Session recording (asciicast v2) | `apps/web/src/ui/productivity.ts` | Verified | `productivity.test.ts` |
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
| Remote editor with conflict refusal | `apps/web/src/ui/App.tsx` (`saveEditorBuffer`) | Implemented | compares remote content before writing; needs SFTP |
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
| Limits of the Workspace IDE | — | — | no language servers, debugger, extension host, terminals or git UI beyond status/diff; binary and non-UTF-8 files are refused; nothing is installed on the server |
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

- Vitest: `npm test` at the repo root (currently 28 files / 179 tests).
- Go: `npm run test:go` (gateway packages).
- Playwright: `npm run test:e2e` (cross-browser, full-screen, accessibility).
- Token invariant: `npm run lint:tokens`.

Real-server verification against a disposable host is **not** claimed here. The rows marked
Implemented still need that run; see `docs/RUNBOOK.md` for the disposable-host procedure.
