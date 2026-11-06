/**
 * Dependency cycles (feature 16): groups of nodes that all depend on each other,
 * found as strongly connected components over depends-on, orders-after, owns,
 * flow and custom edges.
 */
import { indexGraph, type GraphIndex } from '../../graph-index.js';
import type { DiagramGraph, EdgeKind, Highlight, HighlightRole } from '../../model.js';
import { isCycleEdge, stronglyConnectedComponents } from './graph-algos.js';
import { compareText } from './node-facts.js';

export interface Cycle {
  id: string;
  /** Members, sorted by label. */
  nodeIds: string[];
  /** One concrete walk around the loop, each node once, starting from the first member. */
  loop: string[];
  edgeIds: string[];
  edgeKinds: EdgeKind[];
  selfLoop: boolean;
}

export interface CyclesResult {
  cycles: Cycle[];
}

/** Shortest way from `start` back to itself using only edges inside the component. */
function loopThrough(index: GraphIndex, start: string, members: Set<string>): string[] {
  const cameFrom = new Map<string, string>();
  let frontier = [start];
  const seen = new Set<string>([start]);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of index.out.get(current) ?? []) {
        if (!isCycleEdge(edge) || !members.has(edge.to)) continue;
        if (edge.to === start) {
          const loop = [current];
          while (loop[0] !== start) {
            const before = cameFrom.get(loop[0] ?? start);
            if (before === undefined) break;
            loop.unshift(before);
          }
          return loop;
        }
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        cameFrom.set(edge.to, current);
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  return [start];
}

export function findCycles(graph: Pick<DiagramGraph, 'nodes' | 'edges'>): CyclesResult {
  const index = indexGraph(graph);
  const label = (id: string): string => index.nodes.get(id)?.label ?? id;
  const cycles: Cycle[] = [];

  for (const component of stronglyConnectedComponents(index, { edgeFilter: isCycleEdge })) {
    const members = new Set(component);
    const edges = component.flatMap((id) => (index.out.get(id) ?? []).filter((e) => isCycleEdge(e) && members.has(e.to)));
    const selfLoop = component.length === 1;
    if (selfLoop && edges.length === 0) continue;
    const nodeIds = [...component].sort((a, b) => compareText(label(a), label(b)) || compareText(a, b));
    const first = nodeIds[0] ?? '';
    cycles.push({
      id: `cycle:${first}`,
      nodeIds,
      loop: selfLoop ? [first] : loopThrough(index, first, members),
      edgeIds: edges.map((e) => e.id).sort(compareText),
      edgeKinds: [...new Set(edges.map((e) => e.kind))],
      selfLoop
    });
  }
  cycles.sort((a, b) => b.nodeIds.length - a.nodeIds.length || compareText(a.id, b.id));
  return { cycles };
}

export function cyclesHighlight(cycle: Cycle): Highlight {
  const nodes: Record<string, HighlightRole> = {};
  const edges: Record<string, HighlightRole> = {};
  for (const id of cycle.nodeIds) nodes[id] = 'danger';
  for (const id of cycle.edgeIds) edges[id] = 'danger';
  return {
    id: 'cycles',
    title: cycle.selfLoop ? 'Depends on itself' : `Dependency cycle of ${cycle.nodeIds.length}`,
    detail: cycle.selfLoop ? 'A node with an edge to itself.' : `${cycle.nodeIds.length} nodes that all depend on each other, through ${cycle.edgeKinds.join(', ')} edges.`,
    nodes,
    edges,
    dimOthers: true
  };
}
