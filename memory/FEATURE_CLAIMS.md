# Feature Claims Policy

Source of truth: `docs/FEATURES.md`. UI mirror: `apps/web/src/ui/capability-matrix.ts` → `CapabilityMatrixPanel.tsx`.

## Status Key

| Status | Meaning |
|--------|---------|
| Verified | Automated test (Vitest / Go / Playwright) named in proof column exercises it |
| Verified (unit) | Test doubles only — no real SSH server |
| Verified (local e2e) | Playwright vs local gateway + testsshd |
| Implemented | Code exists + typechecks, **not** run vs real server |
| Conditional | Needs prerequisite (gateway, `sudo -n`, docker, kubeconfig) |
| Unsupported | Deliberately not provided |

No row may be marked Verified from a screenshot or banner.

## Verified Snapshot (as of 2026-11-06)

- **Tests:** 65 files / ~834 Vitest tests + Go gateway suite + `e2e/webssh.spec.ts`.
- **Connection:** Browser SSH via relay, Go gateway bridge (local e2e), Turnstile guest tickets + host-scoped tickets, user JWT login, per-user quotas, destination validation, TOFU pinning, vault, ProxyJump (local e2e), no billing.
- **Terminal:** One emulator per pane, PTY I/O + resize (unit), channel routing (unit), split/tabs/workspace state, status `opening`/`ready`/`error`, inspector-only local output, palette v2, find bar, broadcast, rename, cheatsheet, 9 themes persisted, recent hosts, asciicast v2 (unit), scrollback caps.
- **Files/IDE:** SFTP v3 + `~` expansion + atomic mode-preserving write + `.webssh-part` resume (verified), transfer queue + StorageGuard, IDE browse/crud, UTF-8 only, autosave, conflict refusal, CRLF, chunked large writes, find/replace/goto/comment/duplicate/indent, project search/diff/status, cmd runner, line gutter, unsaved confirm.
- **Jobs:** Discovery read-only, recipe engine + preflight, durable detached jobs + monitor/cancel, `verifyJob` from markers.
- **Ops:** Live CPU/mem/disk/net/process (verified, blanks missing), service list/logs (conditional `sudo -n`), reboot/power typed confirm (conditional), docker/k8s/git/automation implemented.

## Implemented (not yet Verified)

- WebGL→canvas→DOM fallback (needs GPU-reset host), gateway resume server side (needs deployed gateway), workspace presets, rail resize, bundle code-split, dual-pane SFTP local folder (needs manual Chromium FS Access run), browser upload/download cap 64 MiB, projects execution, deploy panel.

## Deliberately Unsupported

- Anonymous public TCP proxy · billing/paywalls · K8s Secret reads · pipe-to-shell installers · force-push/history rewrite.

## Real-Server Gap

20.8 pending: real-server runs for recipes, Docker, K8s, Git/deploy, Python cron, service actions + Playwright cross-browser + screenshots. Do not mark Verified until they run. See `docs/RUNBOOK.md` §5-§6.

## Relay Limits

Relay terminal/exec verified vs EC2 OpenSSH. Relay file tools + editor are shell-fixture — not production. Use gateway for SFTP/binary/editor. No local listener for relay tunnels, no remote process resume.

## How to Claim a Feature

1. Wire a real probe/action via `WorkspaceRemoteSession` (ADR-007).
2. Add a test that exercises it.
3. Add/update row in `docs/FEATURES.md` with proof test name.
4. Update `capability-matrix.ts` if UI shows claims.
5. Diagrams/DevOps: design doc is `docs/DIAGRAMS_FEATURES.md` — screen not shipped, don't claim.
