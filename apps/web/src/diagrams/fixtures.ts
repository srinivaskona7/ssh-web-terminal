/**
 * Builders for tests. Not imported by product code.
 */
import type { DiagramEdge, DiagramGraph, DiagramNode, EdgeKind, NodeKind, SourceId } from './model.js';

export function makeNode(
  id: string,
  overrides: Partial<Omit<DiagramNode, 'id'>> & { kind?: NodeKind; source?: SourceId } = {}
): DiagramNode {
  const { source, ...rest } = overrides;
  return {
    id,
    kind: 'custom',
    label: id,
    status: 'unknown',
    tags: {},
    fields: {},
    evidence: { source: source ?? 'import' },
    ...rest
  };
}

export function makeEdge(from: string, to: string, kind: EdgeKind = 'depends-on', extra: Partial<DiagramEdge> = {}): DiagramEdge {
  return { id: `${kind}:${from}->${to}`, from, to, kind, ...extra };
}

export function makeGraph(nodes: DiagramNode[], edges: DiagramEdge[] = [], extra: Partial<DiagramGraph> = {}): DiagramGraph {
  return { title: 'test', nodes, edges, sources: [], collectedAt: 1_700_000_000_000, ...extra };
}
