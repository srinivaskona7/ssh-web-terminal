# Release Verification Scorecard (2026-11-08, HEAD 2367bec + fixes)

## Baseline
- HEAD at audit start: `2367bec`. Unit: 839/839. Lint/build/go-race green.

## Fixes landed this pass
- ViewBoundary per Server Tools view (Retry/Reload) — Overview crash no longer takes app down.
- Credentials cleared on connect success, Cancel, and navigating away from Welcome.
- Tabs distinctly numbered; single disconnected recovery panel with Reconnect.
- Volume meter defaults to `/`; Files breadcrumb + refresh age; Vault lists real fingerprints; Replay hides demo when live recording exists.
- Host badges from all registry connections; write guards at controlService/powerAction/writeFile/startDetachedJob boundaries; discovery "Inspected Ns ago (stale)"; RTT labeled; editor starts empty.
- A09 generation guard: cancel bumps generation, late success closed & ignored.
- E2e: C06 disjoint-rect assertion added; editor explicit-load; 60s timeout.

## Evidence
- `npm test` 839/839, `npm run lint` clean, `npm run build` + `go test -race` green (local).
- Playwright Chromium: real-SSH test + find-bar + split + C06 pass locally (single + parallel varies; CI flake under parallel load with shared gateway).
- Firefox e2e: launch infra failure (profile folder) — pre-existing, unrelated.

## Not verified (blocked on fixtures)
- Multi-host switching meters/badges (B01/B09/B10), two tabs same host PTY isolation (B02), split geometry (B03), reconnect races (B07/B08), Debian+RPM OS paths (F01), K8s/Docker positive paths, 100-session capacity (J06/J07), 7 viewport/theme/zoom matrix.
- Score: unit-covered cases pass; integration cases need disposable Debian+RPM hosts + Docker/K8s fixtures. Release is NOT 100% yet.
