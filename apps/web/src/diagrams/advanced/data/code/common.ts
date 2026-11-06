/**
 * What every text exporter needs: containment without cycles, ids that are
 * valid and unique in the target language, and the edges that can be drawn.
 */
import type { DiagramEdge, DiagramGraph, DiagramNode, NodeStatus } from '../../../model.js';

/** Outline colour per status, resolved from theme tokens by the caller. Never hard-coded here. */
export type StatusPalette = Partial<Record<NodeStatus, string>>;

export interface ExportOptions {
  direction?: 'LR' | 'TB';
  palette?: StatusPalette;
}

export interface PreparedEdge {
  edge: DiagramEdge;
  from: string;
  to: string;
  label: string | undefined;
}

export interface Prepared {
  nodes: DiagramNode[];
  /** Node id → id in the target language. */
  ids: Map<string, string>;
  /** Node id → ids of direct children, in node order. */
  children: Map<string, string[]>;
  roots: string[];
  byId: Map<string, DiagramNode>;
  edges: PreparedEdge[];
  skipped: DiagramEdge[];
}

export function prepare(graph: Pick<DiagramGraph, 'nodes' | 'edges'>, reserved: ReadonlySet<string>): Prepared {
  const byId = new Map<string, DiagramNode>();
  for (const node of graph.nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const nodes = [...byId.values()];

  const parentOf = new Map<string, string>();
  for (const node of nodes) {
    if (node.parent && node.parent !== node.id && byId.has(node.parent)) parentOf.set(node.id, node.parent);
  }
  // A parent loop would nest a node inside itself; cut it where it closes.
  for (const node of nodes) {
    const path = new Set<string>([node.id]);
    let current = node.id;
    for (;;) {
      const next = parentOf.get(current);
      if (next === undefined) break;
      if (path.has(next)) {
        parentOf.delete(current);
        break;
      }
      path.add(next);
      current = next;
    }
  }

  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of nodes) {
    const parent = parentOf.get(node.id);
    if (parent === undefined) roots.push(node.id);
    else children.set(parent, [...(children.get(parent) ?? []), node.id]);
  }

  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const node of nodes) {
    const stem = node.id.replace(/^custom:/, '');
    let base = stem.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (base === '') base = 'n';
    else if (/^\d/.test(base) || reserved.has(base.toLowerCase())) base = `n_${base}`;
    let candidate = base;
    for (let i = 2; used.has(candidate.toLowerCase()); i += 1) candidate = `${base}_${i}`;
    used.add(candidate.toLowerCase());
    ids.set(node.id, candidate);
  }

  const edges: PreparedEdge[] = [];
  const skipped: DiagramEdge[] = [];
  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      skipped.push(edge);
      continue;
    }
    const label = edge.label ?? (edge.kind === 'custom' || edge.kind === 'flow' ? undefined : edge.kind);
    edges.push({ edge, from: edge.from, to: edge.to, label });
  }
  return { nodes, ids, children, roots, byId, edges, skipped };
}

export function isContainer(prepared: Prepared, id: string): boolean {
  return (prepared.children.get(id)?.length ?? 0) > 0;
}

/** First non-container node at or below `id`. */
export function representativeLeaf(prepared: Prepared, id: string): string {
  let current = id;
  for (;;) {
    const kids = prepared.children.get(current);
    if (!kids || kids.length === 0) return current;
    current = kids[0]!;
  }
}

/** Dotted path of target-language ids from the root to `id`. */
export function pathOf(prepared: Prepared, id: string): string[] {
  const parts: string[] = [];
  const parents = new Map<string, string>();
  for (const [parent, kids] of prepared.children) for (const kid of kids) parents.set(kid, parent);
  for (let current: string | undefined = id; current !== undefined; current = parents.get(current)) {
    parts.unshift(prepared.ids.get(current)!);
  }
  return parts;
}

/** Single-line text for a trailing comment. */
export function commentSafe(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

export function skippedNote(edge: DiagramEdge): string {
  return commentSafe(`skipped edge ${edge.from} -> ${edge.to}: an endpoint is not in the drawing`);
}

/** Only a plain hex colour from the caller's palette is written out; anything else is dropped. */
export function safeColor(value: string | undefined): string | undefined {
  return value !== undefined && /^#[0-9a-f]{3,8}$/i.test(value.trim()) ? value.trim() : undefined;
}
