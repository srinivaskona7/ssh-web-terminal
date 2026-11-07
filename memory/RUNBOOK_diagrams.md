# Runbook — Diagram Studio (`diagrams/`, `docs/DIAGRAMS_FEATURES.md`)

Engine foundations only. Screen not wired.

## Contract

- `model.ts` — `DiagramGraph`/`Node`/`Edge`, node ids stable: `k8s:<kind>:<ns>/<name>`, `docker:container:<name>`, `host:<host>`, `ssh:browser|relay|gateway`, `tf:<resource>`
- `sources/scan.ts` — `scanHost(session, {path, namespace, signal, onSource})` → Promise<DiagramGraph>. 16 MiB per-command cap.
- Panels: View (`diagram-studio` props `session/scan/connectionPath/panels`), Analyse (`ANALYSE_PANELS`), Data (`DATA_PANELS`)
- Storage: localStorage `webssh.diagrams.*`, IndexedDB `webssh-diagrams` v1 `snapshots` (30/estate, no `evidence.raw`)
- Test ids: `diagram-studio`, `diagram-canvas`, `diagram-node`/`edge`, `advanced-panel-<id>`

## Rules

Real data only, unknown = "not reported", read-only scans, no secret values, 2,000-node draw cap, tokens only, no network beyond SSH.

## Wiring steps (for implementer)

1. Create `DiagramsScreen.tsx` using `DiagramStudio` contract in DIAGRAMS_FEATURES.md §Ownership
2. Wire `scanHost` with `WorkspaceRemoteSession` from `session/adapters.ts`
3. Add nav entry + `data-testid="diagram-studio"` screen, hide when disconnected
4. Tests: empty graph, unknown status, missing fields, malformed input, largest input
