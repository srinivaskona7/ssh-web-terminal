/**
 * Difference between two scans of the same estate.
 *
 * Nodes are matched by id, so the ids must be stable across scans (see the id
 * table in docs/DIAGRAMS_FEATURES.md). Fields hold no clock-dependent values,
 * so an unchanged object produces no change entry.
 */
import type { DiagramEdge, DiagramGraph, DiagramNode, FieldValue, Highlight, HighlightRole } from './model.js';

export interface FieldChange {
  /** `status`, `label`, `parent`, `tag:<key>` or `field:<key>`. */
  field: string;
  before: FieldValue | undefined;
  after: FieldValue | undefined;
}

export interface NodeChange {
  id: string;
  label: string;
  kind: DiagramNode['kind'];
  changes: FieldChange[];
}

export interface GraphDiff {
  addedNodes: DiagramNode[];
  removedNodes: DiagramNode[];
  changedNodes: NodeChange[];
  addedEdges: DiagramEdge[];
  removedEdges: DiagramEdge[];
  unchangedNodes: number;
}

export function isEmptyDiff(diff: GraphDiff): boolean {
  return (
    diff.addedNodes.length === 0 &&
    diff.removedNodes.length === 0 &&
    diff.changedNodes.length === 0 &&
    diff.addedEdges.length === 0 &&
    diff.removedEdges.length === 0
  );
}

function compareRecords<V extends FieldValue | string>(
  prefix: string,
  before: Record<string, V>,
  after: Record<string, V>,
  out: FieldChange[]
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const b = Object.prototype.hasOwnProperty.call(before, key) ? before[key] : undefined;
    const a = Object.prototype.hasOwnProperty.call(after, key) ? after[key] : undefined;
    if (b !== a) out.push({ field: `${prefix}:${key}`, before: b, after: a });
  }
}

function nodeChanges(before: DiagramNode, after: DiagramNode): FieldChange[] {
  const changes: FieldChange[] = [];
  if (before.status !== after.status) changes.push({ field: 'status', before: before.status, after: after.status });
  if (before.label !== after.label) changes.push({ field: 'label', before: before.label, after: after.label });
  if (before.parent !== after.parent) changes.push({ field: 'parent', before: before.parent ?? null, after: after.parent ?? null });
  compareRecords('tag', before.tags, after.tags, changes);
  compareRecords('field', before.fields, after.fields, changes);
  return changes;
}

export function diffGraphs(before: Pick<DiagramGraph, 'nodes' | 'edges'>, after: Pick<DiagramGraph, 'nodes' | 'edges'>): GraphDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));

  const addedNodes = after.nodes.filter((n) => !beforeNodes.has(n.id));
  const removedNodes = before.nodes.filter((n) => !afterNodes.has(n.id));
  const changedNodes: NodeChange[] = [];
  let unchangedNodes = 0;
  for (const node of after.nodes) {
    const previous = beforeNodes.get(node.id);
    if (!previous) continue;
    const changes = nodeChanges(previous, node);
    if (changes.length > 0) changedNodes.push({ id: node.id, label: node.label, kind: node.kind, changes });
    else unchangedNodes += 1;
  }

  const beforeEdges = new Set(before.edges.map((e) => e.id));
  const afterEdges = new Set(after.edges.map((e) => e.id));
  return {
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges: after.edges.filter((e) => !beforeEdges.has(e.id)),
    removedEdges: before.edges.filter((e) => !afterEdges.has(e.id)),
    unchangedNodes
  };
}

/**
 * A graph that holds both sides of a diff, so removed nodes can still be drawn
 * (marked `removed` by `diffToHighlight`). The `after` copy wins for nodes and
 * edges present in both.
 */
export function mergeForDiff(before: DiagramGraph, after: DiagramGraph, diff: GraphDiff): DiagramGraph {
  const nodes = [...after.nodes];
  const seenNodes = new Set(nodes.map((n) => n.id));
  for (const node of diff.removedNodes) {
    if (!seenNodes.has(node.id)) nodes.push(node);
  }
  const edges = [...after.edges];
  const seenEdges = new Set(edges.map((e) => e.id));
  for (const edge of diff.removedEdges) {
    if (!seenEdges.has(edge.id)) edges.push(edge);
  }
  return { ...after, title: `${after.title} (compared)`, nodes, edges, sources: after.sources, collectedAt: after.collectedAt, hostKey: after.hostKey ?? before.hostKey };
}

export function diffToHighlight(diff: GraphDiff, title: string): Highlight {
  const nodes: Record<string, HighlightRole> = {};
  const edges: Record<string, HighlightRole> = {};
  for (const n of diff.addedNodes) nodes[n.id] = 'added';
  for (const n of diff.removedNodes) nodes[n.id] = 'removed';
  for (const n of diff.changedNodes) nodes[n.id] = 'changed';
  for (const e of diff.addedEdges) edges[e.id] = 'added';
  for (const e of diff.removedEdges) edges[e.id] = 'removed';
  const parts = [
    `${diff.addedNodes.length} added`,
    `${diff.removedNodes.length} removed`,
    `${diff.changedNodes.length} changed`
  ];
  return {
    id: 'diff',
    title,
    detail: `${parts.join(', ')}; ${diff.addedEdges.length} edges added, ${diff.removedEdges.length} removed.`,
    nodes,
    edges,
    dimOthers: true
  };
}
