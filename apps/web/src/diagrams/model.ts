/**
 * Shared model for Diagram Studio.
 *
 * Every node and edge comes from something the connected host (or a file the
 * user supplied) actually reported. A state the source did not report is
 * `unknown`, which renders as "not reported" — never a guessed green.
 */
import type { JSX } from 'preact';

export type SourceId =
  | 'kubernetes'
  | 'docker'
  | 'systemd'
  | 'sockets'
  | 'ssh-path'
  | 'terraform'
  | 'import';

export type NodeKind =
  // SSH path
  | 'browser'
  | 'relay'
  | 'gateway'
  | 'jump-host'
  | 'host'
  // Kubernetes
  | 'k8s-cluster'
  | 'k8s-namespace'
  | 'k8s-node'
  | 'k8s-deployment'
  | 'k8s-statefulset'
  | 'k8s-daemonset'
  | 'k8s-replicaset'
  | 'k8s-job'
  | 'k8s-cronjob'
  | 'k8s-pod'
  | 'k8s-service'
  | 'k8s-ingress'
  | 'k8s-configmap'
  | 'k8s-secret'
  | 'k8s-pvc'
  // Docker / Compose
  | 'compose-project'
  | 'compose-service'
  | 'container'
  | 'docker-network'
  | 'docker-volume'
  | 'image'
  // systemd and sockets
  | 'systemd-unit'
  | 'process'
  | 'listener'
  | 'peer'
  // Terraform
  | 'tf-module'
  | 'tf-resource'
  // user-authored (Mermaid / draw.io import)
  | 'custom';

/**
 * - `healthy`, `warning`, `failed`, `pending`, `stopped`: what the source said.
 * - `unknown`: the source did not report a state ("not reported").
 */
export type NodeStatus = 'healthy' | 'warning' | 'failed' | 'pending' | 'stopped' | 'unknown';

/** Visual tone a formatting rule or overlay may apply; maps to token colours. */
export type NodeTone = 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'muted';

export type FieldValue = string | number | boolean | null;

export interface EvidenceRef {
  source: SourceId;
  /** The exact command that produced this object, when it came from a scan. */
  command?: string;
  /** The file it came from, for imports and config-derived nodes. */
  path?: string;
  /** The raw object or line as the source returned it (shown in the inspector). */
  raw?: unknown;
}

export interface DiagramNode {
  /** Stable across scans, e.g. `k8s:pod:default/web-7c9f-abc12`, so snapshots can be compared. */
  id: string;
  kind: NodeKind;
  label: string;
  /** Optional finer type, e.g. a Terraform resource type (`aws_instance`). */
  subtype?: string;
  /** Id of the containing node (namespace, compose project, host, module). */
  parent?: string;
  status: NodeStatus;
  statusDetail?: string;
  /** Labels / tags as reported (k8s labels, compose labels, Terraform tags). */
  tags: Record<string, string>;
  /** Inspector fields; data binding merges imported columns in here. */
  fields: Record<string, FieldValue>;
  evidence: EvidenceRef;
  /** Set by overlays (conditional formatting, notes); the renderer honours it. */
  style?: { tone?: NodeTone; badge?: string };
}

/**
 * Edges point from the actor to what it acts on or needs: owner → owned,
 * Service → Pod, Pod → PVC, unit → required unit, client → server. So the
 * nodes that can reach X are the ones affected when X breaks.
 */
export type EdgeKind =
  | 'owns'
  | 'selects'
  | 'routes'
  | 'mounts'
  | 'uses-config'
  | 'depends-on'
  | 'orders-after'
  | 'connects'
  | 'listens'
  | 'attached'
  | 'runs'
  | 'scheduled-on'
  | 'hop'
  | 'flow'
  | 'custom';

export interface DiagramEdge {
  /** Stable: `${kind}:${from}->${to}` unless several edges share endpoints. */
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  tags?: Record<string, string>;
}

export type SourceStatus = 'ok' | 'partial' | 'unavailable' | 'error' | 'skipped';

export interface SourceReport {
  source: SourceId;
  status: SourceStatus;
  note?: string;
  /** Commands the scan ran for this source, in order. */
  commands: string[];
  durationMs?: number;
}

export interface DiagramGraph {
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  sources: SourceReport[];
  collectedAt: number;
  /** `user@host:port` of the scanned host; absent for imported diagrams. */
  hostKey?: string;
}

/**
 * Key for per-estate storage (snapshots, rules, notes): the scanned host, or
 * the title of an imported diagram when there is no host.
 */
export function storageKeyFor(graph: Pick<DiagramGraph, 'hostKey' | 'title'>): string {
  return graph.hostKey ?? `import:${graph.title}`;
}

/** What each source builder returns from raw command output or an imported file. */
export interface SourceBuild {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  report: SourceReport;
}

// ---------------------------------------------------------------------------
// View state: what is shown. Filters never mutate the graph.
// ---------------------------------------------------------------------------

export type LayoutDirection = 'LR' | 'TB';

export type GroupBy = 'parent' | 'namespace' | 'k8s-node' | 'owner' | 'compose-project' | 'docker-network' | 'none';

export interface ViewState {
  direction: LayoutDirection;
  groupBy: GroupBy;
  hiddenNodeKinds: NodeKind[];
  hiddenEdgeKinds: EdgeKind[];
  /** `problems` keeps failed/warning/pending nodes plus the path to their containers. */
  statusFilter: 'all' | 'problems';
  /** Label selector, e.g. `app=web,tier!=db,env`. Empty means no filter. */
  labelSelector: string;
  search: string;
  focus: { nodeId: string; hops: number } | null;
  /** Container ids drawn collapsed (drill-down). */
  collapsed: string[];
}

export const DEFAULT_VIEW: ViewState = {
  direction: 'LR',
  groupBy: 'parent',
  hiddenNodeKinds: [],
  hiddenEdgeKinds: [],
  statusFilter: 'all',
  labelSelector: '',
  search: '',
  focus: null,
  collapsed: []
};

// ---------------------------------------------------------------------------
// Highlights: analyses, diffs and presentation steps all speak this shape.
// ---------------------------------------------------------------------------

export type HighlightRole = 'primary' | 'secondary' | 'added' | 'removed' | 'changed' | 'danger';

/**
 * An overlay drawn over the current graph without changing it. One overlay is
 * active at a time; a new one replaces the last.
 */
export interface Highlight {
  id: string;
  title: string;
  detail?: string;
  nodes: Record<string, HighlightRole>;
  edges: Record<string, HighlightRole>;
  /** Dim everything not named above. */
  dimOthers: boolean;
  /** Per-node tone (conditional formatting, exposure, incidents). */
  tones?: Record<string, NodeTone>;
  /** Per-node short badge text (notes, counts). */
  badges?: Record<string, string>;
  /** Zoom the drawing to the highlighted nodes (presentation steps, path results). */
  fit?: boolean;
}

// ---------------------------------------------------------------------------
// Advanced tab panels. Diagram Studio mounts whatever panels it is given.
// ---------------------------------------------------------------------------

export interface AdvancedPanelProps {
  /** The graph currently drawn (after data binding and any replay). */
  graph: DiagramGraph | null;
  /** The last live scan, kept separately so replay and imports can return to it. */
  liveGraph: DiagramGraph | null;
  view: ViewState;
  onViewChange: (patch: Partial<ViewState>) => void;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onHighlight: (highlight: Highlight | null) => void;
  /** Draw a different graph (import, snapshot replay, diff merge, data binding). */
  onShowGraph: (graph: DiagramGraph) => void;
  /** Return to the live scan. */
  onShowLive: () => void;
  /** Serialised SVG of the current drawing, for exporters that embed it. */
  getSvgMarkup: () => string | null;
  /** `user@host:port` when connected; storage keys use it. Null when disconnected. */
  hostKey: string | null;
  /** Read a text file on the connected host over SFTP; null when disconnected or unsupported. */
  readRemoteFile: ((path: string) => Promise<string>) | null;
  /** How the connection is made (relay or gateway, jump hosts, target); null when disconnected. */
  connectionPath: ConnectionPathInfo | null;
}

export type AdvancedSection = 'view' | 'analyse' | 'history' | 'data' | 'present';

export const ADVANCED_SECTIONS: readonly { id: AdvancedSection; title: string }[] = [
  { id: 'view', title: 'View' },
  { id: 'analyse', title: 'Analyse' },
  { id: 'history', title: 'History' },
  { id: 'data', title: 'Data' },
  { id: 'present', title: 'Present' }
];

export interface AdvancedPanel {
  /** Matches the feature id in docs/DIAGRAMS_FEATURES.md. */
  id: string;
  section: AdvancedSection;
  title: string;
  description: string;
  /**
   * A short live finding shown beside the title before the panel is opened
   * ("3 exposed", "2 single points"), so the Advanced tab reveals what is
   * worth a look. Synchronous and cheap; null shows nothing.
   */
  summary?: (props: AdvancedPanelProps) => string | null;
  Component: (props: AdvancedPanelProps) => JSX.Element;
}

/** The connection the SSH path source draws. Only values the transport reported. */
export interface ConnectionPathInfo {
  transport: 'cloudflare-relay' | 'go-gateway';
  /** Relay or gateway URL host, as configured. */
  endpoint: string;
  hops: { host: string; port: number; user: string }[];
  target: { host: string; port: number; user: string };
  hostKeyFingerprint?: string;
  serverVersion?: string;
  cipher?: string;
}
