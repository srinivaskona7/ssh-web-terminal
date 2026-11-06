/**
 * Single points of failure (feature 15): nodes and links the rest of the estate
 * is hanging from, plus workloads running on one replica.
 */
import { indexGraph } from '../../graph-index.js';
import type { DiagramGraph, Highlight, HighlightRole } from '../../model.js';
import { articulationPointsAndBridges, isDependencyEdge } from './graph-algos.js';
import { compareText, fieldNumber } from './node-facts.js';

export type SinglePointKind = 'cut-node' | 'bridge' | 'single-replica';

export interface SingleFinding {
  id: string;
  kind: SinglePointKind;
  title: string;
  /** Why this is a single point, in a sentence. */
  why: string;
  /** The flagged node, or for a bridge the two nodes it joins. */
  nodeIds: string[];
  edgeIds: string[];
}

export interface SinglePointsResult {
  findings: SingleFinding[];
  /** Distinct nodes named by any finding. */
  nodeIds: string[];
}

const REPLICATED_KINDS = new Set(['k8s-deployment', 'k8s-statefulset']);

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function findSinglePoints(graph: Pick<DiagramGraph, 'nodes' | 'edges'>): SinglePointsResult {
  const index = indexGraph(graph);
  const label = (id: string): string => index.nodes.get(id)?.label ?? id;
  const connectivity = articulationPointsAndBridges(index, { edgeFilter: isDependencyEdge });
  const findings: SingleFinding[] = [];

  for (const point of connectivity.articulationPoints) {
    findings.push({
      id: `cut-node:${point.id}`,
      kind: 'cut-node',
      title: label(point.id),
      why: `Removing ${label(point.id)} splits its part of the estate into ${plural(point.pieces, 'piece')}; ${plural(point.cutOff, 'node')} end up apart from the largest one.`,
      nodeIds: [point.id],
      edgeIds: []
    });
  }

  for (const { edge, smallerSide } of connectivity.bridges) {
    findings.push({
      id: `bridge:${edge.id}`,
      kind: 'bridge',
      title: `${label(edge.from)} to ${label(edge.to)}`,
      why: `This is the only link between ${label(edge.from)} and ${label(edge.to)}; without it ${plural(smallerSide, 'node')} on the smaller side are cut off (${edge.kind}).`,
      nodeIds: [edge.from, edge.to],
      edgeIds: [edge.id]
    });
  }

  const workloads = graph.nodes.filter((n) => REPLICATED_KINDS.has(n.kind) && fieldNumber(n, 'replicas') === 1).sort((a, b) => compareText(a.label, b.label) || compareText(a.id, b.id));
  for (const workload of workloads) {
    findings.push({
      id: `single-replica:${workload.id}`,
      kind: 'single-replica',
      title: workload.label,
      why: `${workload.label} runs one replica, so a restart or a node loss takes it offline.`,
      nodeIds: [workload.id],
      edgeIds: []
    });
  }

  return { findings, nodeIds: [...new Set(findings.flatMap((f) => f.nodeIds))] };
}

export function singlePointsHighlight(result: SinglePointsResult): Highlight | null {
  if (result.findings.length === 0) return null;
  const nodes: Record<string, HighlightRole> = {};
  const edges: Record<string, HighlightRole> = {};
  for (const finding of result.findings) {
    if (finding.kind === 'bridge') {
      for (const id of finding.nodeIds) nodes[id] ??= 'secondary';
      for (const id of finding.edgeIds) edges[id] = 'danger';
    }
  }
  for (const finding of result.findings) {
    if (finding.kind !== 'bridge') for (const id of finding.nodeIds) nodes[id] = 'danger';
  }
  return {
    id: 'single-points',
    title: 'Single points of failure',
    detail: `${plural(result.findings.length, 'finding')} across ${plural(result.nodeIds.length, 'node')}.`,
    nodes,
    edges,
    dimOthers: true
  };
}
