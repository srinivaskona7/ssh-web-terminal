# Workspace Additions (2026-11)

Created Nov 2026. These expand the original M0-M8 core.

## Shell & Welcome

- `ui/shell/`: `AppHeader`, `AppRail`, `SettingsScreen`, `WelcomeScreen`, `TurnstileWidget`, `types.ts` — extracted from `App.tsx`.
- `ui/WelcomeDashboard.tsx`, `welcome-data.ts`, `welcome-dashboard.css` — dashboard over actual connected session + hosts registry.
- `ui/ide-storage.ts` — `webssh.ide.v1` project + recent-file **paths only**.

## Remote I/O & Transport Helpers

- `files/remote-file-io.ts` — paged reads until gateway size met (refuse short), chunked writes, UTF-8 refusal.
- `transport/exec-output.ts` — bounded exec output capture.
- `transport/remote-signer.ts` — fingerprint routing, `sign_request`/`sign_response` multiplexing.
- `transport/session-env.ts` — environment reports / capability shims.

## Gateway Helpers (Go)

- `cmd/gateway/env.go` — env validation + TLS/Origin/auth config.
- `cmd/gateway/hops.go` — ProxyJump chain parsing, 8-hop cap, per-hop policy, blank user fallback to target user, audit hop path.
- `cmd/gateway/execstream.go` — bounded command streams.
- Tests: `harness_test.go` (integration harness), `hops_test.go`, `execstream_test.go`, `env_test.go`, `main_test.go`.

## DevOps (engine only)

`apps/web/src/devops/` — `types.ts`, `exec.ts`, `logs/`, `tools/network/`, `tools/delivery/`, `tools/system/`.

**Status:** Tested engine foundations. No wired screen. PRs must not add a screen without server-backed probes + tests (ADR-007).

## Diagrams (engine only)

`apps/web/src/diagrams/` — `model.ts`, `graph-index.ts`, `diff.ts`, `download.ts`, `layout/`, `sources/`, `advanced/analyse/`, `advanced/data/`.

Design contract: `docs/DIAGRAMS_FEATURES.md` (30 features: live scan k8s/docker/compose/systemd/sockets/SSH path, layout, inspector, layers/filters/group-by/drill-down, blast-radius/path-finder/cycles/orphans/exposure, snapshots/compare/drift, data-binding, infra import, diagram-as-code, presentation, annotations, SSH sequence).

**Status:** Engine foundations only. `DiagramsScreen` and nav not wired. Feature table is design target, not shipped claim.

### Snapshots

- IndexedDB `webssh-diagrams` v1, store `snapshots`, keyPath `id`, index `byEstate` on `estate`.
- Newest 30 per estate, without `evidence.raw`.
- Impl: `diagrams/advanced/data/snapshots-store.ts`.
- View prefs: `webssh.diagrams.view.v1`, refresh `webssh.diagrams.refresh.v1`, rules `webssh.diagrams.rules.v1:<estate>`, baseline `webssh.diagrams.baseline.v1:<estate>`, notes `webssh.diagrams.notes.v1:<estate>`.
- Bounds: 16 MiB per scan command, 2,000 nodes drawn cap, stable node ids across scans.
- Rules in doc: real data only, unknown = "not reported", read-only scans, no secret values, tokens only, no network beyond SSH.

## Gate Reminder

Generate tokens before lint/typecheck/test/build (root scripts do this). Gates: `npm run lint`, `npm test`, `VITE_BASE_PATH=/ssh-web-terminal/ npm run build`, `go test -race ./...` in gateway, `npx playwright test` (needs sockets).
