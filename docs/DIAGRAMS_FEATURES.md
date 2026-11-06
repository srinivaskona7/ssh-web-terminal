# Diagram Studio — feature doc

Implementation status: this directory currently contains tested engine foundations only.
The Diagram Studio screen, panel components and application navigation are not
implemented or wired into the app. Screen descriptions and contracts below are
design targets, not shipped feature claims.

Living design document for Diagram Studio (`apps/web/src/diagrams/`).
Keep it current as part of every change. `docs/FEATURES.md` holds the
verified claims; this file holds the design, the contract and the limits.

## What it is

A topology and flow diagram drawn from what the connected host actually
reports — Kubernetes, Docker/Compose, systemd, sockets and the SSH path —
plus imported files (Terraform state, `kubectl -o json`, Compose config,
Mermaid). The features that diagram vendors keep behind paid tiers (live
import, auto-sync, version compare, drift, data linking, overlays,
watermark-free export, diagram-as-code sync) are free here, as every product
feature is (no billing, invariant 6).

The **Diagram** tab shows the drawing with the everyday tools. The
**Advanced** tab reveals the deep-dive panels, grouped View / Analyse /
History / Data / Present.

## Rules every feature follows

| Rule | Meaning |
|---|---|
| Real data only | Nodes and edges come from a command's output or a file the user supplied. No sample graphs, no placeholder nodes. |
| Unknown is visible | A state the source did not report is `unknown`, drawn neutral and labelled "not reported". |
| Read-only scans | Scans run read-only commands only. Every command is listed in the source report before and after it runs. |
| No secret values | ConfigMap and Secret *data* is never fetched. Env var values, `last-applied-configuration`, `managedFields`, Docker `Config.Env` values and Terraform sensitive attributes are redacted before anything is kept. |
| Bounded | Each command's output is capped at 16 MiB (`SCAN_OUTPUT_LIMIT`); the drawing caps at 2,000 nodes and says how many were hidden. |
| Stable fields | `node.fields` and `node.tags` hold no clock-dependent values (no ages, no "5m ago", no `collectedAt`), so two scans of an unchanged estate diff as empty. Counts that really change (restarts, ready replicas) are fine. |
| Tokens only | Colours come from `--color-status-*`, `--color-accent-primary`, `--color-fg-*`, `--color-bg-*` (invariant 1). |
| No network | Nothing leaves the browser except SSH commands to the connected host (invariant 3). |

## Shared contract

`apps/web/src/diagrams/model.ts` — `DiagramGraph`, `DiagramNode`,
`DiagramEdge`, `ViewState`, `Highlight`, `AdvancedPanel`. Agents do not edit it.

### Node ids (stable across scans, so snapshots compare)

| Source | Id |
|---|---|
| Kubernetes | `k8s:cluster:<context>`, `k8s:namespace:<ns>`, `k8s:node:<name>`, `k8s:<kind>:<ns>/<name>` with kind in `deployment statefulset daemonset replicaset job cronjob pod service ingress configmap secret pvc` |
| Docker | `docker:container:<name>`, `docker:network:<name>`, `docker:volume:<name>`, `docker:image:<repo:tag or short id>` |
| Compose | `compose:project:<name>`, `compose:service:<project>/<service>` |
| systemd | `systemd:unit:<name>` |
| Sockets | `sock:listen:<tcp or udp>:<bind address>:<port>`, `proc:<comm>` (only processes not mapped to a unit or container), `peer:<address>` (inbound, aggregated) and `peer:<address>:<port>` (outbound) |
| Host | `host:<host>` — parent of systemd, socket and Docker nodes |
| SSH path | `ssh:browser`, `ssh:relay` or `ssh:gateway`, `ssh:hop:<n>:<host>`; the last hop leads to `host:<host>` itself (the scanned machine is not drawn twice) |
| Terraform | `tf:module:<module path>`, `tf:<resource address>` |
| Import | `custom:<id from the file>` |

### Edge direction

Edges point from the actor to what it acts on or needs:

| Kind | From → To |
|---|---|
| `owns` | Deployment → ReplicaSet → Pod; CronJob → Job → Pod; StatefulSet/DaemonSet → Pod; unit → `proc` |
| `selects` | Service → Pod |
| `routes` | Ingress → Service; published host listener → container |
| `mounts` | Pod → PVC; container → Docker volume |
| `uses-config` | Pod → ConfigMap / Secret (by reference) |
| `depends-on` | Compose `depends_on`; systemd `Requires` `Wants` `BindsTo` |
| `orders-after` | systemd `After` (A After=B gives A → B) |
| `connects` | inbound peer → listener; unit/container/proc → outbound peer |
| `listens` | unit / container / proc → its listener |
| `attached` | container → Docker network |
| `runs` | container → image |
| `scheduled-on` | Pod → node |
| `hop` | browser → relay/gateway → hop 1 … → target |
| `flow`, `custom` | imported diagrams |

### Status mapping

| Object | healthy | warning | failed | pending | stopped | unknown |
|---|---|---|---|---|---|---|
| Pod | Running, all ready | Running, not all ready | Failed, or a container waiting in CrashLoopBackOff, ImagePullBackOff, ErrImagePull, CreateContainerConfigError | Pending | Succeeded | anything else |
| Deployment/StatefulSet/DaemonSet/ReplicaSet | ready = desired > 0 | 0 < ready < desired | ready = 0 < desired | — | desired = 0 | not reported |
| Service | ≥ 1 selected pod ready (detail says "derived") | selected pods exist, none ready | — | — | — | no selector |
| PVC | Bound | — | Lost | Pending | — | other |
| k8s node | Ready=True | — | Ready=False | — | — | Ready=Unknown |
| Container | running (health healthy or none) | restarting | exited ≠ 0, dead, health unhealthy | created, health starting | exited 0, paused | other |
| systemd unit | active | — | failed | activating, deactivating, reloading | inactive | other |
| Listener | listening as reported by `ss` | — | — | — | — | — |
| SSH path | the session reported connected | — | — | — | — | not reported |

### Field glossary (`node.fields`)

Analyses, overlays and conditional formatting read these names. `null` means
not reported.

| Kind | Fields |
|---|---|
| Pod | `phase` `ready` ("2/3") `restarts` `node` `podIP` `hostNetwork` `privileged` `containerPorts` ("80/TCP,443/TCP") `images` `warningEvents` `lastWarning` |
| Workloads | `replicas` `readyReplicas` `updatedReplicas` `availableReplicas` `warningEvents` `lastWarning` |
| Service | `type` `clusterIP` `ports` ("80/TCP→8080") `nodePorts` `selector` ("app=web") `externalIPs` `loadBalancerIngress` |
| Ingress | `hosts` `tls` `ingressClass` |
| PVC | `phase` `storageClass` `capacity` |
| k8s node | `ready` `kubeletVersion` `roles` |
| Container | `state` `health` `image` `publishedPorts` ("0.0.0.0:8080->80/tcp") `privileged` `networkMode` `restarts` `exitCode` `composeProject` `composeService` |
| systemd unit | `activeState` `subState` `mainPid` `fragmentPath` `description` |
| Listener | `protocol` `bindAddress` `port` `process` `pid` `allInterfaces` |
| Peer | `address` `port` `connections` |
| SSH path | `endpoint` `user` `port` `cipher` `serverVersion` `hostKeyFingerprint` |
| Terraform | `type` `provider` `mode` `module` `index` |

## The 30 features

"Mirrors" names the paid capability elsewhere that the feature matches.
Owners (implementer agents): **sources** = data collection and import, **canvas** = layout, rendering and the screen shell, **analyse** = analyses and overlays, **data** = history, data and export.

### Diagram tab

| # | Id | Feature | Mirrors | Owner | Status |
|---|---|---|---|---|---|
| 1 | `live-scan` | Scan the connected host: Kubernetes, Docker/Compose, systemd, sockets, SSH path. Per-source report (ok / partial / unavailable / error / skipped) with the exact commands and durations; cross-source edges (listener → unit/container by PID) | Lucid Cloud Accelerator, Miro AWS Cloud View, Cloudcraft live import, Hava | sources | planned |
| 2 | `auto-layout` | Deterministic layered layout, LR/TB, compound containers (namespace, project, host), pan/zoom/fit, keyboard navigation | Lucid auto-layout, Lens LTR/TTB | canvas | planned |
| 3 | `inspector` | Side panel: kind, status ("not reported" when unknown), fields, tags, evidence command and redacted raw object | Headlamp side panel, Cloudcraft inspector | canvas | planned |
| 4 | `search` | Find by label, id or tag value; matches highlighted, others dimmed; Enter steps through | draw.io / Lucid find | canvas | planned |
| 5 | `minimap` | Overview with the viewport rectangle; click to jump | Miro / draw.io minimap | canvas | planned |
| 6 | `live-refresh` | Re-scan every 30 s / 60 s / 5 min while the screen is visible and connected; "collected at" time; pauses on disconnect | Hava auto-sync, Cloudcraft live sync | canvas | planned |
| 7 | `export-image` | SVG and PNG (2×) with no watermark, plus JSON of the graph | watermark-free export tiers | canvas | planned |

### Advanced tab — View

| # | Id | Feature | Mirrors | Owner | Status |
|---|---|---|---|---|---|
| 8 | `layers` | Show/hide each node kind and edge kind, with counts | Lucid / draw.io / Cloudcraft layers | canvas | planned |
| 9 | `filters` | Label selector (`app=web,tier!=db,env,!canary,tier in (web,api)`) over every source's tags, plus a problems-only toggle that keeps failed/warning/pending nodes, their containers and direct neighbours | Cloudcraft filtered views, Headlamp filters, k9s fault toggle | canvas | planned |
| 10 | `group-by` | Regroup by namespace, k8s node, owner, Compose project, Docker network, or none | Headlamp Resource Map | canvas | planned |
| 11 | `drill-down` | C4-style levels — Context (SSH path, hosts, clusters), Container (workloads, services, units, Compose services), Component (pods, containers, listeners, processes) — and collapse/expand per container | Structurizr C4, IcePanel zoom levels, Lucid drill-down | canvas | planned |
| 12 | `conditional-format` | Rules `field op value → tone/badge` (ops `= != > >= < <= contains exists`), saved per host, applied to the drawn graph | Lucid conditional formatting | analyse | planned |

### Advanced tab — Analyse

| # | Id | Feature | Mirrors | Owner | Status |
|---|---|---|---|---|---|
| 13 | `blast-radius` | From the selected node: what breaks if it breaks (nodes that reach it) and what it needs (nodes it reaches), 1–5 hops, grouped by kind | Komodor dependency map, k9s UsedBy, Kiali | analyse | planned |
| 14 | `path-finder` | Shortest path between two chosen nodes, highlighted, with the hop list | Kiali find | analyse | planned |
| 15 | `single-points` | Articulation points and bridges of the undirected graph, plus workloads with exactly one ready replica | SUSE Observability, Komodor | analyse | planned |
| 16 | `cycles` | Dependency cycles (strongly connected components) over `depends-on`, `orders-after`, `owns`, `flow`, `custom` | — | analyse | planned |
| 17 | `orphans` | Services selecting no pods, PVCs no pod mounts, listed ConfigMaps/Secrets nothing references, Docker volumes/networks/images nothing uses | Lens / Popeye hygiene | analyse | planned |
| 18 | `exposure` | Listeners on all interfaces, NodePort/LoadBalancer Services, Ingress without TLS, privileged or host-network pods, containers publishing on 0.0.0.0 | Cloudcraft security overlay, Hava security view | analyse | planned |
| 19 | `request-flow` | Config-derived request paths: Ingress → Service → Pods (container ports); host listener → container; listener → unit/process. Says plainly that this is configuration, not observed traffic | lens-flow, Kiali traffic graph | analyse | planned |
| 20 | `hotspots` | Rank nodes by fan-in, degree and restarts | Kiali node ranking | analyse | planned |
| 21 | `incident-overlay` | Warning events and failed units on their nodes, with counts and the last message | Komodor timeline, SUSE root-cause | analyse | planned |

### Advanced tab — History

| # | Id | Feature | Mirrors | Owner | Status |
|---|---|---|---|---|---|
| 22 | `snapshots` | Save the scan to IndexedDB per host (last 30 kept), list, replay | Lucid / Miro / FigJam version history | data | planned |
| 23 | `compare` | Diff two snapshots or a snapshot vs live: added / removed / changed nodes and edges with field-level changes, drawn as an overlay | Lucid compare, Hava compare revisions | data | planned |
| 24 | `baseline-drift` | Mark a snapshot as baseline; the panel shows drift against it and refreshes on every scan while open | Hava architectural monitoring, Brainboard drift | data | planned |

### Advanced tab — Data

| # | Id | Feature | Mirrors | Owner | Status |
|---|---|---|---|---|---|
| 25 | `data-binding` | Import CSV (RFC 4180) or JSON, join on node id, label or a tag, merge the columns into node fields | Lucid data linking, Visio data visualizer | data | planned |
| 26 | `infra-import` | Draw Terraform state (v4 `.tfstate` or `terraform show -json`), a `kubectl get -o json` List, or `docker compose config --format json`; paste, choose a local file, or read a path on the host over SFTP | Lucid Cloud Accelerator, Brainboard import | sources | planned |
| 27 | `diagram-as-code` | Export Mermaid, D2, PlantUML, Graphviz DOT, draw.io XML; import a Mermaid flowchart (subset) | Mermaid Chart sync, draw.io import | data | planned |

### Advanced tab — Present

| # | Id | Feature | Mirrors | Owner | Status |
|---|---|---|---|---|---|
| 28 | `presentation` | Step through containers, request flows or the problems (failed first); ← / → keys, Esc to leave | Lucid presentation, Mermaid / D2 steps | analyse | planned |
| 29 | `annotations` | Notes pinned to nodes, saved per estate, shown as badges while the panel is open, listed, exportable as JSON | Lucid / Miro comments | data | planned |
| 30 | `ssh-sequence` | Sequence diagram of the live connection: browser → relay or gateway → each jump host → target, with the reported cipher, server version and host key fingerprint | — | data | planned |

## What it deliberately does not do

| Not done | Why |
|---|---|
| Cloud provider APIs (AWS, Azure, GCP) | No credentials leave the browser and nothing calls third-party APIs; Terraform state import covers cloud estates. |
| Observed traffic | Request flows come from configuration; a service mesh would be needed for real traffic. The panel says so. |
| Co-editing, share links, AI | Need a server the product does not run. |
| Writing to the cluster or host | Diagram Studio is read-only. Changes go through the Kubernetes and Containers screens, which preview first. |
| VSDX and PDF | No library without a CDN or a heavy dependency; SVG and PNG cover printing. |

## On the user's hands

- Scans need `kubectl`, `docker`, `systemctl` and `ss` on the host; missing ones are reported, not faked.
- Full socket-to-process mapping needs root. Without it the sockets source is `partial` and says so.
- Docker without the `docker` group or root reports `partial` with the permission error.

## Ownership and contracts (for implementers)

### Directories

```
apps/web/src/diagrams/
  model.ts graph-index.ts diff.ts fixtures.ts download.ts   shared; nobody but the coordinator edits these
  sources/** scan.ts import/**                              sources agent
  layout/** canvas/** studio/**                             canvas agent
  advanced/analyse/**                                       analyse agent
  advanced/data/**                                          data agent
  DiagramsScreen.tsx advanced/index.ts                      coordinator (wires everything)
```

A change a shared file needs is reported in the final message, not made.

### Contracts between areas

```ts
// sources/../scan.ts — sources agent
export const SCAN_OUTPUT_LIMIT = 16 * 1024 * 1024;
export interface ScanOptions {
  path: ConnectionPathInfo | null;       // from model.ts; null skips the ssh-path source
  namespace?: string;                    // kubectl -n <ns> instead of -A
  signal?: AbortSignal;
  onSource?: (report: SourceReport) => void;
}
export function scanHost(session: WorkspaceRemoteSession, options: ScanOptions): Promise<DiagramGraph>;

// import/index.ts — sources agent
export const INFRA_IMPORT_PANEL: AdvancedPanel;       // feature 26, section 'data'

// studio/DiagramStudio.tsx — canvas agent
export interface DiagramStudioProps {
  session: WorkspaceRemoteSession | null;
  scan: ((signal: AbortSignal, options: { namespace?: string }) => Promise<DiagramGraph>) | null; // null = disconnected
  connectionPath: ConnectionPathInfo | null;
  panels: readonly AdvancedPanel[];
}
export function DiagramStudio(props: DiagramStudioProps): JSX.Element;
export const VIEW_PANELS: readonly AdvancedPanel[];   // layers, filters, group-by, drill-down (section 'view')

// advanced/analyse/index.ts — analyse agent
export const ANALYSE_PANELS: readonly AdvancedPanel[];

// advanced/data/index.ts — data agent
export const DATA_PANELS: readonly AdvancedPanel[];
```

`hostKey` is `${user}@${host}:${port}` (the studio computes it). `readRemoteFile`
is `session.readFile` bound, when the session has one.

### How panels act on the drawing

| Need | Call |
|---|---|
| Colour, dim, badge or zoom to some nodes/edges | `onHighlight(highlight)` — one overlay at a time; `null` clears it. The studio also clears it when the open panel changes. |
| Draw a different graph (import, replay, merged diff, bound data) | `onShowGraph(graph)`; the studio shows a banner "Showing <title>" with a **Back to live scan** button (`onShowLive`). |
| Change filters, grouping, focus, collapse | `onViewChange(patch)` |
| Select a node (opens the inspector) | `onSelectNode(id)` |

### Storage keys

| Owner | Where | Key |
|---|---|---|
| canvas | localStorage | `webssh.diagrams.view.v1` (direction, group-by, hidden kinds), `webssh.diagrams.refresh.v1` (interval) |
| analyse | localStorage | `webssh.diagrams.rules.v1:<storageKeyFor(graph)>` |
| data | IndexedDB | database `webssh-diagrams` v1, store `snapshots` (keyPath `id`, index `byEstate` on `estate`) |
| data | localStorage | `webssh.diagrams.baseline.v1:<estate>` (snapshot id), `webssh.diagrams.notes.v1:<estate>` |

`estate` is `storageKeyFor(graph)`. A snapshot keeps the graph without
`evidence.raw`, so a snapshot stays small.

### Test ids

`diagram-studio`, `diagram-tab-diagram`, `diagram-tab-advanced`,
`diagram-scan-btn`, `diagram-status`, `diagram-source-<sourceId>`,
`diagram-canvas`, `diagram-node` (with `data-node-id`), `diagram-edge`
(with `data-edge-id`), `diagram-inspector`, `diagram-search-input`,
`diagram-minimap`, `diagram-export-svg`, `diagram-export-png`,
`diagram-export-json`, `diagram-refresh-select`, `diagram-banner`,
`diagram-back-to-live`, `advanced-section-<id>`, `advanced-panel-<panelId>`
(the card), `advanced-panel-body-<panelId>` (the opened content). A panel
prefixes its own controls with its id (`blast-radius-run`, `snapshots-save`).

### Quality gates for every agent

- Tests live next to the code (`*.test.ts` / `*.test.tsx`), use `fixtures.ts`, and cover the empty graph, a node with `unknown` status, missing fields, malformed input and the largest sensible input.
- `npx vitest run apps/web/src/diagrams/<your area>` from the repo root.
- `npx tsc -p apps/web/tsconfig.json --noEmit 2>&1 | grep 'diagrams/'` prints nothing (other areas may be mid-edit; ignore their paths).
- `node scripts/lint-tokens.mjs` reports nothing under `apps/web/src/diagrams/`. In TSX, SVG ids such as `url(#bad-x)` look like hex colours to the linter; prefix every id with `diagram-`.
- LF line endings only; `node scripts/check-eol.mjs`.
- No new dependency, no network, no CDN, no `eval`.
