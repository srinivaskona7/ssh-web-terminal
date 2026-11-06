/**
 * Path finder (feature 14): the shortest route between two nodes, each way, with
 * the kind of every edge crossed.
 */
import { indexGraph } from '../../graph-index.js';
import type { DiagramGraph, DiagramNode, EdgeKind, Highlight, HighlightRole } from '../../model.js';
import { shortestPath, type PathResult } from './graph-algos.js';
import { compareText, kindLabel } from './node-facts.js';

export interface PathHop {
  from: string;
  to: string;
  edgeId: string;
  edgeKind: EdgeKind;
  /** The edge was crossed against its direction (only in the direction-ignoring search). */
  reversed: boolean;
}

export interface PathRoute {
  nodes: string[];
  hops: PathHop[];
}

export interface PathReport {
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  /** from → to along edge direction. */
  forward: PathRoute | null;
  /** to → from along edge direction. */
  backward: PathRoute | null;
  /** Only searched when neither direction has a route. */
  undirected: PathRoute | null;
  summary: string;
}

function toRoute(path: PathResult | null): PathRoute | null {
  if (!path) return null;
  return {
    nodes: path.nodes,
    hops: path.steps.map((s) => ({ from: s.from, to: s.to, edgeId: s.edge.id, edgeKind: s.edge.kind, reversed: s.reversed }))
  };
}

function hopsText(route: PathRoute): string {
  const count = route.hops.length;
  return `${count} hop${count === 1 ? '' : 's'}`;
}

export function findPaths(graph: Pick<DiagramGraph, 'nodes' | 'edges'>, fromId: string, toId: string): PathReport | null {
  const index = indexGraph(graph);
  const from = index.nodes.get(fromId);
  const to = index.nodes.get(toId);
  if (!from || !to) return null;

  const base = { from: fromId, to: toId, fromLabel: from.label, toLabel: to.label };
  if (fromId === toId) {
    return { ...base, forward: null, backward: null, undirected: null, summary: `Both ends are the same node (${from.label}). Pick two different nodes.` };
  }

  const forward = toRoute(shortestPath(index, fromId, toId, { directed: true }));
  const backward = toRoute(shortestPath(index, toId, fromId, { directed: true }));
  const undirected = forward || backward ? null : toRoute(shortestPath(index, fromId, toId, { directed: false }));

  let summary: string;
  if (forward && backward) {
    summary = `Paths exist in both directions: ${from.label} reaches ${to.label} in ${hopsText(forward)}, and ${to.label} reaches ${from.label} in ${hopsText(backward)}.`;
  } else if (forward) {
    summary = `${from.label} reaches ${to.label} in ${hopsText(forward)}. ${to.label} does not reach ${from.label}.`;
  } else if (backward) {
    summary = `${to.label} reaches ${from.label} in ${hopsText(backward)}. ${from.label} does not reach ${to.label}.`;
  } else if (undirected) {
    summary = `Neither reaches the other along edge direction. Ignoring direction, they are ${hopsText(undirected)} apart.`;
  } else {
    summary = `No path between ${from.label} and ${to.label}, even ignoring edge direction.`;
  }
  return { ...base, forward, backward, undirected, summary };
}

export function pathHighlight(report: PathReport): Highlight {
  const nodes: Record<string, HighlightRole> = {};
  const edges: Record<string, HighlightRole> = {};
  for (const route of [report.forward, report.backward, report.undirected]) {
    if (!route) continue;
    for (const id of route.nodes) nodes[id] = 'secondary';
    for (const hop of route.hops) edges[hop.edgeId] = 'secondary';
  }
  nodes[report.from] = 'primary';
  nodes[report.to] = 'primary';
  return {
    id: 'path-finder',
    title: `Path: ${report.fromLabel} and ${report.toLabel}`,
    detail: report.summary,
    nodes,
    edges,
    dimOthers: true,
    fit: true
  };
}

function rank(node: DiagramNode, query: string): number {
  const label = node.label.toLowerCase();
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.includes(query)) return 2;
  if (node.id.toLowerCase().includes(query) || kindLabel(node.kind).toLowerCase().includes(query)) return 3;
  return -1;
}

/** Nodes for a picker: label matches first (exact, prefix, anywhere), then id or kind matches. */
export function searchNodes(graph: Pick<DiagramGraph, 'nodes'>, query: string, limit: number): DiagramNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return graph.nodes.slice(0, limit);
  return graph.nodes
    .map((node) => ({ node, rank: rank(node, needle) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || compareText(a.node.label, b.node.label))
    .slice(0, limit)
    .map((entry) => entry.node);
}
