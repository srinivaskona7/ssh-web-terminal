/**
 * What is drawn: a pure function from (graph, view) to the nodes and edges the
 * canvas lays out. Filters never mutate the graph.
 *
 * Pipeline: group by -> hide kinds -> focus -> label selector -> problems ->
 * collapse -> cap. Each stage only shrinks the set of kept ids; the drawn
 * parent of a node is its nearest kept ancestor, so removing a middle container
 * re-parents its children instead of orphaning them.
 */
import type { DiagramEdge, DiagramGraph, DiagramNode, EdgeKind, GroupBy, NodeKind, NodeStatus, ViewState } from '../model.js';

export const DEFAULT_NODE_CAP = 2000;

/** C4 drill-down: Context shows the systems, Container the runtime units, Component everything. */
export type C4Level = 'context' | 'container' | 'component';

const KIND_RANK: Record<NodeKind, 1 | 2 | 3> = {
  browser: 1,
  relay: 1,
  gateway: 1,
  'jump-host': 1,
  host: 1,
  'k8s-cluster': 1,
  'tf-module': 1,
  custom: 1,
  'k8s-namespace': 2,
  'k8s-node': 2,
  'k8s-deployment': 2,
  'k8s-statefulset': 2,
  'k8s-daemonset': 2,
  'k8s-cronjob': 2,
  'k8s-job': 2,
  'k8s-service': 2,
  'k8s-ingress': 2,
  'compose-project': 2,
  'compose-service': 2,
  'docker-network': 2,
  'systemd-unit': 2,
  'tf-resource': 2,
  'k8s-pod': 3,
  'k8s-replicaset': 3,
  container: 3,
  listener: 3,
  process: 3,
  peer: 3,
  'k8s-configmap': 3,
  'k8s-secret': 3,
  'k8s-pvc': 3,
  'docker-volume': 3,
  image: 3
};

/** Higher survives the cap longer. Config objects, images and peers go first. */
const KEEP_PRIORITY: Record<NodeKind, number> = {
  host: 10,
  'k8s-cluster': 10,
  'jump-host': 10,
  browser: 10,
  relay: 10,
  gateway: 10,
  'tf-module': 9,
  custom: 9,
  'k8s-namespace': 9,
  'compose-project': 9,
  'k8s-node': 8,
  'k8s-deployment': 8,
  'k8s-statefulset': 8,
  'k8s-daemonset': 8,
  'k8s-cronjob': 8,
  'k8s-job': 7,
  'k8s-service': 8,
  'k8s-ingress': 8,
  'compose-service': 8,
  'systemd-unit': 8,
  'tf-resource': 8,
  'docker-network': 7,
  container: 6,
  'k8s-pod': 6,
  listener: 5,
  'k8s-pvc': 4,
  'docker-volume': 3,
  process: 3,
  'k8s-replicaset': 2,
  image: 2,
  peer: 2,
  'k8s-configmap': 1,
  'k8s-secret': 1
};

const EDGE_KIND_TABLE: Record<EdgeKind, true> = {
  owns: true,
  selects: true,
  routes: true,
  mounts: true,
  'uses-config': true,
  'depends-on': true,
  'orders-after': true,
  connects: true,
  listens: true,
  attached: true,
  runs: true,
  'scheduled-on': true,
  hop: true,
  flow: true,
  custom: true
};

export const NODE_KINDS = Object.keys(KIND_RANK) as NodeKind[];
export const EDGE_KINDS = Object.keys(EDGE_KIND_TABLE) as EdgeKind[];

/** Kinds that exist only to contain others; with grouping off they dissolve. */
const GROUPING_KINDS = new Set<NodeKind>(['k8s-cluster', 'k8s-namespace', 'compose-project', 'tf-module']);
const PROBLEM_STATUSES = new Set<NodeStatus>(['failed', 'warning', 'pending']);

export const C4_LEVELS: readonly { id: C4Level; title: string; rank: 1 | 2 | 3 }[] = [
  { id: 'context', title: 'Context', rank: 1 },
  { id: 'container', title: 'Container', rank: 2 },
  { id: 'component', title: 'Component', rank: 3 }
];

/** The node kinds a C4 level hides. */
export function c4Preset(level: C4Level): NodeKind[] {
  const rank = (C4_LEVELS.find((l) => l.id === level) as { rank: number }).rank;
  return NODE_KINDS.filter((k) => KIND_RANK[k] > rank);
}

/** The level whose preset equals the view's hidden kinds, or null for a custom mix. */
export function detectC4Level(view: Pick<ViewState, 'hiddenNodeKinds'>): C4Level | null {
  const hidden = new Set(view.hiddenNodeKinds);
  for (const level of C4_LEVELS) {
    const preset = c4Preset(level.id);
    if (preset.length === hidden.size && preset.every((k) => hidden.has(k))) return level.id;
  }
  return null;
}

/** How many nodes each level would draw, ignoring every other filter. */
export function c4NodeCounts(graph: DiagramGraph | null): Record<C4Level, number> {
  const counts: Record<C4Level, number> = { context: 0, container: 0, component: 0 };
  if (!graph) return counts;
  for (const node of graph.nodes) {
    const rank = KIND_RANK[node.kind];
    if (rank <= 1) counts.context += 1;
    if (rank <= 2) counts.container += 1;
    counts.component += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Label selector
// ---------------------------------------------------------------------------

export type SelectorOp = 'eq' | 'neq' | 'exists' | 'notexists' | 'in' | 'notin';

export interface SelectorRequirement {
  key: string;
  op: SelectorOp;
  values: string[];
}

export type SelectorParse =
  | { ok: true; requirements: SelectorRequirement[]; matches: (node: DiagramNode) => boolean }
  | { ok: false; error: string };

const KEY_RE = /^[A-Za-z0-9][-A-Za-z0-9_./]*$/;
const VALUE_RE = /^[-A-Za-z0-9_./]*$/;
const SET_RE = /^(\S+)\s+(in|notin)\s*\((.*)\)$/i;

function splitTopLevel(text: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  parts.push(text.slice(start));
  return parts;
}

function parseRequirement(raw: string): SelectorRequirement | string {
  const piece = raw.trim();
  if (piece === '') return 'empty requirement';
  const set = SET_RE.exec(piece);
  if (set) {
    const key = set[1] as string;
    if (!KEY_RE.test(key)) return `invalid key "${key}"`;
    const values = (set[3] as string)
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
    if (values.length === 0) return `"${key} ${(set[2] as string).toLowerCase()}" needs at least one value`;
    for (const v of values) if (!VALUE_RE.test(v)) return `invalid value "${v}"`;
    return { key, op: (set[2] as string).toLowerCase() === 'in' ? 'in' : 'notin', values };
  }
  const cmp = /^([^=!\s]+)\s*(!=|==|=)\s*(.*)$/.exec(piece);
  if (cmp) {
    const key = cmp[1] as string;
    const value = (cmp[3] as string).trim();
    if (!KEY_RE.test(key)) return `invalid key "${key}"`;
    if (!VALUE_RE.test(value)) return `invalid value "${value}"`;
    return { key, op: cmp[2] === '!=' ? 'neq' : 'eq', values: [value] };
  }
  if (piece.startsWith('!')) {
    const key = piece.slice(1).trim();
    if (!KEY_RE.test(key)) return `invalid key "${key}"`;
    return { key, op: 'notexists', values: [] };
  }
  if (!KEY_RE.test(piece)) return `cannot parse "${piece}"`;
  return { key: piece, op: 'exists', values: [] };
}

const NAMESPACE_ID = /^k8s:[a-z-]+:([^/]+)\//;

function namespaceOf(node: DiagramNode): string | null {
  const fromTags = node.tags.namespace;
  if (fromTags) return fromTags;
  const fromField = node.fields.namespace;
  if (typeof fromField === 'string' && fromField !== '') return fromField;
  if (node.kind === 'k8s-namespace') {
    const own = /^k8s:namespace:(.+)$/.exec(node.id);
    return own ? (own[1] as string) : null;
  }
  const fromId = NAMESPACE_ID.exec(node.id);
  return fromId ? (fromId[1] as string) : null;
}

/** The values a selector can test: the node's tags plus the virtual `namespace` and `kind`. */
export function nodeLabels(node: DiagramNode): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  for (const [k, v] of Object.entries(node.tags)) labels.set(k, [v]);
  if (!labels.has('namespace')) {
    const ns = namespaceOf(node);
    if (ns) labels.set('namespace', [ns]);
  }
  const kinds: string[] = [node.kind];
  const fieldKind = node.fields.kind;
  if (typeof fieldKind === 'string' && fieldKind !== '' && fieldKind !== node.kind) kinds.push(fieldKind);
  const existing = labels.get('kind');
  labels.set('kind', existing ? [...existing, ...kinds] : kinds);
  return labels;
}

function satisfies(req: SelectorRequirement, labels: Map<string, string[]>): boolean {
  const values = labels.get(req.key);
  switch (req.op) {
    case 'exists':
      return values !== undefined;
    case 'notexists':
      return values === undefined;
    case 'eq':
      return values !== undefined && values.includes(req.values[0] as string);
    case 'neq':
      return values === undefined || !values.includes(req.values[0] as string);
    case 'in':
      return values !== undefined && values.some((v) => req.values.includes(v));
    case 'notin':
      return values === undefined || !values.some((v) => req.values.includes(v));
  }
}

/** Kubernetes-style label selector. Never throws; bad input is `{ ok: false }`. */
export function parseLabelSelector(text: string): SelectorParse {
  if (text.trim() === '') return { ok: true, requirements: [], matches: () => true };
  const pieces = splitTopLevel(text);
  if (!pieces) return { ok: false, error: 'unbalanced parentheses' };
  const requirements: SelectorRequirement[] = [];
  for (const piece of pieces) {
    const parsed = parseRequirement(piece);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    requirements.push(parsed);
  }
  return {
    ok: true,
    requirements,
    matches: (node) => {
      const labels = nodeLabels(node);
      return requirements.every((r) => satisfies(r, labels));
    }
  };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

interface Regrouped {
  parent: Map<string, string | null>;
  /** Grouping-only nodes dissolved because grouping is off. */
  dissolved: Set<string>;
}

function regroup(graph: DiagramGraph, groupBy: GroupBy): Regrouped {
  const byId = new Map<string, DiagramNode>();
  for (const n of graph.nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  const original = (n: DiagramNode): string | null => (n.parent !== undefined && n.parent !== n.id && byId.has(n.parent) ? n.parent : null);
  const parent = new Map<string, string | null>();
  const dissolved = new Set<string>();

  const firstOut = new Map<string, string>();
  const firstIn = new Map<string, string>();
  if (groupBy === 'k8s-node' || groupBy === 'docker-network' || groupBy === 'owner' || groupBy === 'none') {
    const wanted: EdgeKind | null = groupBy === 'k8s-node' ? 'scheduled-on' : groupBy === 'docker-network' ? 'attached' : groupBy === 'owner' ? 'owns' : null;
    const touched = new Set<string>();
    for (const e of graph.edges) {
      touched.add(e.from);
      touched.add(e.to);
      if (e.kind !== wanted) continue;
      if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
      if (!firstOut.has(e.from)) firstOut.set(e.from, e.to);
      if (!firstIn.has(e.to)) firstIn.set(e.to, e.from);
    }
    if (groupBy === 'none') {
      for (const n of byId.values()) if (GROUPING_KINDS.has(n.kind) && !touched.has(n.id)) dissolved.add(n.id);
    }
  }

  for (const n of byId.values()) {
    let p: string | null = original(n);
    switch (groupBy) {
      case 'parent':
        break;
      case 'none':
        p = null;
        break;
      case 'namespace': {
        if (n.kind === 'k8s-namespace') break;
        const ns = namespaceOf(n);
        const target = ns ? `k8s:namespace:${ns}` : null;
        if (target && target !== n.id && byId.has(target)) p = target;
        break;
      }
      case 'k8s-node': {
        const viaEdge = firstOut.get(n.id);
        const field = n.fields.node;
        const viaField = typeof field === 'string' && field !== '' ? `k8s:node:${field}` : null;
        if (viaEdge) p = viaEdge;
        else if (viaField && viaField !== n.id && byId.has(viaField)) p = viaField;
        break;
      }
      case 'owner': {
        const owner = firstIn.get(n.id);
        if (owner) p = owner;
        break;
      }
      case 'compose-project': {
        const project = n.fields.composeProject;
        const target = typeof project === 'string' && project !== '' ? `compose:project:${project}` : null;
        if (target && target !== n.id && byId.has(target)) p = target;
        break;
      }
      case 'docker-network': {
        const net = firstOut.get(n.id);
        if (net) p = net;
        break;
      }
    }
    parent.set(n.id, p);
  }

  // Any rule can close a loop (A owns B owns A); cut it where it closes.
  const mark = new Map<string, 1 | 2>();
  for (const id of parent.keys()) {
    if (mark.get(id) === 2) continue;
    const path: string[] = [];
    let cur: string | null = id;
    while (cur !== null && mark.get(cur) === undefined) {
      mark.set(cur, 1);
      path.push(cur);
      cur = parent.get(cur) ?? null;
    }
    if (cur !== null && mark.get(cur) === 1) parent.set(path[path.length - 1] as string, null);
    for (const p of path) mark.set(p, 2);
  }
  return { parent, dissolved };
}

// ---------------------------------------------------------------------------
// applyView
// ---------------------------------------------------------------------------

export interface DrawnNode {
  node: DiagramNode;
  id: string;
  parent: string | null;
  depth: number;
  /** Children this node has before collapse and cap (kept by the filters). */
  childCount: number;
  collapsed: boolean;
  /** Descendants hidden under a collapsed container: the "+N" chip. */
  hiddenDescendants: number;
}

export interface DrawnEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  /** Underlying edges this one stands for; more than one after collapse. */
  count: number;
  members: string[];
  aggregated: boolean;
}

export interface DrawnGraph {
  nodes: DrawnNode[];
  edges: DrawnEdge[];
  total: { nodes: number; edges: number };
  hidden: { nodes: number; edges: number; capped: number };
  selectorError: string | null;
  /** The focus node is not in the (filtered) graph, so focus was ignored. */
  focusMissing: boolean;
  cap: number;
}

export const EMPTY_DRAWN: DrawnGraph = {
  nodes: [],
  edges: [],
  total: { nodes: 0, edges: 0 },
  hidden: { nodes: 0, edges: 0, capped: 0 },
  selectorError: null,
  focusMissing: false,
  cap: DEFAULT_NODE_CAP
};

export function applyView(graph: DiagramGraph | null, view: ViewState, options: { cap?: number } = {}): DrawnGraph {
  const cap = Math.max(1, options.cap ?? DEFAULT_NODE_CAP);
  if (!graph) return { ...EMPTY_DRAWN, cap };

  const byId = new Map<string, DiagramNode>();
  for (const n of graph.nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  const { parent, dissolved } = regroup(graph, view.groupBy);

  // ---- hide kinds ----
  const hiddenNodeKinds = new Set(view.hiddenNodeKinds);
  const hiddenEdgeKinds = new Set(view.hiddenEdgeKinds);
  let keep = new Set<string>();
  for (const n of byId.values()) if (!hiddenNodeKinds.has(n.kind) && !dissolved.has(n.id)) keep.add(n.id);
  const base = new Set(keep);

  const liveEdges = graph.edges.filter((e) => !hiddenEdgeKinds.has(e.kind));
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const list = adjacency.get(a);
    if (list) list.push(b);
    else adjacency.set(a, [b]);
  };
  for (const e of liveEdges) {
    if (e.from === e.to || !base.has(e.from) || !base.has(e.to)) continue;
    link(e.from, e.to);
    link(e.to, e.from);
  }

  const withAncestors = (ids: Set<string>): Set<string> => {
    const out = new Set(ids);
    for (const id of ids) {
      let cur = parent.get(id) ?? null;
      while (cur !== null && !out.has(cur)) {
        if (base.has(cur)) out.add(cur);
        cur = parent.get(cur) ?? null;
      }
    }
    return out;
  };

  // ---- focus ----
  let focusMissing = false;
  if (view.focus) {
    const start = view.focus.nodeId;
    if (!keep.has(start)) {
      focusMissing = true;
    } else {
      const hops = Math.max(0, Math.min(50, Math.floor(Number(view.focus.hops) || 0)));
      const seen = new Set<string>([start]);
      let frontier = [start];
      for (let h = 0; h < hops && frontier.length > 0; h += 1) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const nb of adjacency.get(id) ?? []) {
            if (!seen.has(nb)) {
              seen.add(nb);
              next.push(nb);
            }
          }
        }
        frontier = next;
      }
      keep = withAncestors(seen);
    }
  }

  // ---- label selector ----
  let selectorError: string | null = null;
  const selector = parseLabelSelector(view.labelSelector);
  if (!selector.ok) {
    selectorError = selector.error;
  } else if (selector.requirements.length > 0) {
    const matched = new Set<string>();
    for (const id of keep) if (selector.matches(byId.get(id) as DiagramNode)) matched.add(id);
    keep = withAncestors(matched);
  }

  // ---- problems ----
  if (view.statusFilter === 'problems') {
    const problems = new Set<string>();
    for (const id of keep) if (PROBLEM_STATUSES.has((byId.get(id) as DiagramNode).status)) problems.add(id);
    const widened = new Set(problems);
    for (const id of problems) for (const nb of adjacency.get(id) ?? []) if (keep.has(nb)) widened.add(nb);
    keep = withAncestors(widened);
  }

  // ---- drawn parent: the nearest kept ancestor ----
  const keptParent = new Map<string, string | null>();
  const resolveParent = (id: string, kept: Set<string>): string | null => {
    let cur = parent.get(id) ?? null;
    while (cur !== null && !kept.has(cur)) cur = parent.get(cur) ?? null;
    return cur;
  };
  for (const id of keep) keptParent.set(id, resolveParent(id, keep));
  const childCount = new Map<string, number>();
  for (const p of keptParent.values()) if (p !== null) childCount.set(p, (childCount.get(p) ?? 0) + 1);

  // ---- collapse ----
  const collapsedSet = new Set(view.collapsed.filter((id) => keep.has(id)));
  const rep = new Map<string, string>();
  const repOf = (id: string): string => {
    const known = rep.get(id);
    if (known !== undefined) return known;
    // Outermost collapsed ancestor wins.
    let result = id;
    let cur = keptParent.get(id) ?? null;
    while (cur !== null) {
      if (collapsedSet.has(cur)) result = cur;
      cur = keptParent.get(cur) ?? null;
    }
    rep.set(id, result);
    return result;
  };
  let drawnIds = [...keep].filter((id) => repOf(id) === id);
  const collapsedHiddenUnder = new Map<string, number>();
  for (const id of keep) {
    const r = repOf(id);
    if (r !== id) collapsedHiddenUnder.set(r, (collapsedHiddenUnder.get(r) ?? 0) + 1);
  }

  // ---- edges, aggregated onto collapsed containers ----
  interface Group {
    from: string;
    to: string;
    kind: EdgeKind;
    label?: string;
    members: string[];
    changed: boolean;
  }
  const groups = new Map<string, Group>();
  for (const e of liveEdges) {
    if (!keep.has(e.from) || !keep.has(e.to)) continue;
    const from = repOf(e.from);
    const to = repOf(e.to);
    if (from === to) continue; // inside one collapsed container
    const key = `${e.kind}\u0000${from}\u0000${to}`;
    const group = groups.get(key);
    const changed = from !== e.from || to !== e.to;
    if (group) {
      group.members.push(e.id);
      group.changed = group.changed || changed;
    } else {
      groups.set(key, { from, to, kind: e.kind, label: e.label, members: [e.id], changed });
    }
  }

  // ---- cap ----
  let capped = 0;
  if (drawnIds.length > cap) {
    const order = new Map<string, number>();
    drawnIds.forEach((id, i) => order.set(id, i));
    const score = (id: string): number => {
      const n = byId.get(id) as DiagramNode;
      let s = KEEP_PRIORITY[n.kind];
      if (PROBLEM_STATUSES.has(n.status) && n.status !== 'pending') s += 100;
      else if (n.status === 'pending') s += 50;
      if ((childCount.get(id) ?? 0) > 0) s += 20;
      return s;
    };
    const ranked = [...drawnIds].sort((a, b) => score(a) - score(b) || (order.get(b) as number) - (order.get(a) as number));
    const drop = new Set(ranked.slice(0, drawnIds.length - cap));
    capped = drop.size;
    drawnIds = drawnIds.filter((id) => !drop.has(id));
  }
  const drawnSet = new Set(drawnIds);

  const depthCache = new Map<string, number>();
  const finalParent = new Map<string, string | null>();
  for (const id of drawnIds) finalParent.set(id, resolveParent(id, drawnSet));
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const chain: string[] = [];
    let cur: string | null = id;
    while (cur !== null && !depthCache.has(cur)) {
      chain.push(cur);
      cur = finalParent.get(cur) ?? null;
    }
    let d = cur === null ? -1 : (depthCache.get(cur) as number);
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      d += 1;
      depthCache.set(chain[i] as string, d);
    }
    return depthCache.get(id) as number;
  };

  const nodes: DrawnNode[] = drawnIds.map((id) => ({
    node: byId.get(id) as DiagramNode,
    id,
    parent: finalParent.get(id) ?? null,
    depth: depthOf(id),
    childCount: childCount.get(id) ?? 0,
    collapsed: collapsedSet.has(id),
    hiddenDescendants: collapsedHiddenUnder.get(id) ?? 0
  }));

  const edges: DrawnEdge[] = [];
  let drawnMembers = 0;
  for (const g of groups.values()) {
    if (!drawnSet.has(g.from) || !drawnSet.has(g.to)) continue;
    const aggregated = g.changed || g.members.length > 1;
    drawnMembers += g.members.length;
    edges.push({
      id: aggregated ? `agg:${g.kind}:${g.from}->${g.to}` : (g.members[0] as string),
      from: g.from,
      to: g.to,
      kind: g.kind,
      label: aggregated ? undefined : g.label,
      count: g.members.length,
      members: g.members,
      aggregated
    });
  }

  return {
    nodes,
    edges,
    total: { nodes: graph.nodes.length, edges: graph.edges.length },
    hidden: {
      nodes: Math.max(0, byId.size - dissolved.size - nodes.length),
      edges: Math.max(0, graph.edges.length - drawnMembers),
      capped
    },
    selectorError,
    focusMissing,
    cap
  };
}
