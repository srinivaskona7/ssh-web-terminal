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

## Batch status (final)
- B01/B09/B10: registry isolates hosts (unit); per-host badges/stale write-block implemented; live two-host e2e owed.
- B02/B03: per-pane channels + FitAddon resize (unit + B03 e2e).
- B07/B08: bounded retry + manual-disconnect suppression (code + reconnect unit); socket-drop needs network fixture.
- F01/F02/F07: OS detection (NAME/VERSION_ID) + Debian/Amazon Linux fixtures (unit, new); real distro images owed.
- G01–G04/H03: Docker/K8s/tunnel clients exist with honest unavailable states; positive paths need fixtures.
- J06/J07: `scripts/capacity-ramp.mjs` harness — measured 100 WS opens vs local gateway (p50 51 ms, p95 52 ms, 0 fail). Measures WS accept, not full SSH auth (gateway opens WS without hello; SSH happens on connect frame). 100 SSH sessions + 30-min soak still owed.
- C09/C10: viewport screenshots at 390/768/1024/1440/1672 done; keyboard/zoom manual owed.
- Score: unit-covered cases pass; integration cases need disposable Debian+RPM hosts + Docker/K8s fixtures. Release is NOT 100% yet.
