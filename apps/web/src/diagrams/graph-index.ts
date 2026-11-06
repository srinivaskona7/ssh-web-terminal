/**
 * Lookup structure over a graph. Built once per graph; every analysis, filter
 * and exporter reads through it so none re-scans the edge list.
 */
import type { DiagramEdge, DiagramGraph, DiagramNode } from './model.js';

export interface GraphIndex {
  nodes: Map<string, DiagramNode>;
  /** Edges whose `from` is the key. */
  out: Map<string, DiagramEdge[]>;
  /** Edges whose `to` is the key. */
  in: Map<string, DiagramEdge[]>;
  /** Parent id → ids of its direct children, in node order. */
  children: Map<string, string[]>;
}

export function indexGraph(graph: Pick<DiagramGraph, 'nodes' | 'edges'>): GraphIndex {
  const nodes = new Map<string, DiagramNode>();
  for (const node of graph.nodes) nodes.set(node.id, node);

  const out = new Map<string, DiagramEdge[]>();
  const into = new Map<string, DiagramEdge[]>();
  for (const edge of graph.edges) {
    // An edge to a node the graph does not contain cannot be drawn or followed.
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    push(out, edge.from, edge);
    push(into, edge.to, edge);
  }

  const children = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.parent && nodes.has(node.parent) && node.parent !== node.id) push(children, node.parent, node.id);
  }
  return { nodes, out, in: into, children };
}

function push<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Every node below `id` in the containment tree, nearest first. Cycle-safe. */
export function descendants(index: GraphIndex, id: string): string[] {
  const seen = new Set<string>([id]);
  const result: string[] = [];
  let frontier = [id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const child of index.children.get(current) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        result.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return result;
}

/** The containers above `id`, nearest first. Cycle-safe. */
export function ancestors(index: GraphIndex, id: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>([id]);
  let current = index.nodes.get(id)?.parent;
  while (current && !seen.has(current) && index.nodes.has(current)) {
    seen.add(current);
    result.push(current);
    current = index.nodes.get(current)?.parent;
  }
  return result;
}

/** Ids one edge away in either direction, with the connecting edge. */
export function neighbours(index: GraphIndex, id: string): { id: string; edge: DiagramEdge }[] {
  const result: { id: string; edge: DiagramEdge }[] = [];
  for (const edge of index.out.get(id) ?? []) result.push({ id: edge.to, edge });
  for (const edge of index.in.get(id) ?? []) result.push({ id: edge.from, edge });
  return result;
}
