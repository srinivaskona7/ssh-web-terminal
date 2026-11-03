# WebSSH Studio — Verified Feature Matrix

This file replaces the earlier marketing-style "50 feature" table. Every row below maps to
code that exists in this repository, and the status states exactly how far it has been proven.

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
| xterm.js PTY rendering | `apps/web/src/terminal/xterm-adapter.ts` | Implemented | needs a connected PTY channel |
| Tabs, split panes, workspace state | `apps/web/src/terminal/workspace-state.ts` | Verified | `terminal.test.ts` |
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

- Vitest: `npm test` at the repo root (currently 18 files / 114 tests).
- Go: `npm run test:go` (gateway packages).
- Playwright: `npm run test:e2e` (cross-browser, full-screen, accessibility).
- Token invariant: `npm run lint:tokens`.

Real-server verification against a disposable host is **not** claimed here. The rows marked
Implemented still need that run; see `docs/RUNBOOK.md` for the disposable-host procedure.
