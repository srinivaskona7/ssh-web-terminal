/**
 * Blast radius (feature 13): from one node, what breaks if it breaks (the nodes
 * that can reach it through dependency edges) and what it needs (the nodes it
 * reaches).
 */
import { descendants, indexGraph, type GraphIndex } from '../../graph-index.js';
import type { DiagramGraph, DiagramNode, Highlight, HighlightRole } from '../../model.js';
import { isDependencyEdge, reachable } from './graph-algos.js';
import { compareText, groupByKind, type KindGroup } from './node-facts.js';

export const MAX_HOPS = 5;
const DEFAULT_HOPS = 3;

/** 1 to 5, whole hops. Anything that is not a number falls back to 3. */
export function clampHops(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_HOPS;
  return Math.min(MAX_HOPS, Math.max(1, Math.floor(value)));
}

export type BlastMode = 'breaks' | 'needs';

export interface BlastOptions {
  mode: BlastMode;
  hops: number;
}

export interface BlastNode {
  id: string;
  distance: number;
}

export interface BlastResult {
  startId: string;
  startLabel: string;
  mode: BlastMode;
  hops: number;
  /** Nearest first, then by label. The start itself is not listed. */
  nodes: BlastNode[];
  groups: KindGroup[];
  /** Dependency edges between the start and the listed nodes. */
  edgeIds: string[];
  /** Listed nodes whose own status is already `failed`. */
  alreadyFailed: string[];
  /** The start is a host, so everything it contains went down with it. */
  hostFailure: boolean;
  /** The assumptions that applied, for the panel to print. */
  assumptions: string[];
}

export const BLAST_ASSUMPTIONS: readonly string[] = [
  'Follows selects, routes, mounts, uses-config, depends-on, connects, attached, runs, scheduled-on, listens, flow and custom edges. It ignores owns and orders-after: a controller is not a dependency of what it creates, and start order is not a need.',
  'Every dependency counts as required. Redundancy is not modelled: a Service is listed even when other pods behind it could keep serving. Single points shows where redundancy is missing.',
  'This is read from the configuration the host reported, not from measured traffic.'
];

const HOST_ASSUMPTION = 'A failed host takes everything it contains with it; those nodes count as one hop.';

function affectedBy(index: GraphIndex, start: DiagramNode, hops: number): Map<string, number> {
  const distance = reachable(index, start.id, 'backward', { edgeFilter: isDependencyEdge, maxHops: hops });
  if (start.kind !== 'host') return distance;
  // Containment is not an edge, so the contents of a failed host are added by hand
  // at one hop, and what depends on them follows from there.
  const inside = descendants(index, start.id);
  const dependants = reachable(index, inside, 'backward', { edgeFilter: isDependencyEdge, maxHops: hops - 1 });
  for (const [id, hopsFromInside] of dependants) {
    const total = hopsFromInside + 1;
    const known = distance.get(id);
    if (known === undefined || total < known) distance.set(id, total);
  }
  return distance;
}

export function blastRadius(graph: Pick<DiagramGraph, 'nodes' | 'edges'>, startId: string, options: BlastOptions): BlastResult | null {
  const index = indexGraph(graph);
  const start = index.nodes.get(startId);
  if (!start) return null;
  const hops = clampHops(options.hops);
  const hostFailure = options.mode === 'breaks' && start.kind === 'host';
  const distance =
    options.mode === 'breaks'
      ? affectedBy(index, start, hops)
      : reachable(index, startId, 'forward', { edgeFilter: isDependencyEdge, maxHops: hops });
  distance.delete(startId);

  const label = (id: string): string => index.nodes.get(id)?.label ?? id;
  const nodes = [...distance]
    .map(([id, d]) => ({ id, distance: d }))
    .sort((a, b) => a.distance - b.distance || compareText(label(a.id), label(b.id)) || compareText(a.id, b.id));

  const inResult = new Set<string>([startId, ...distance.keys()]);
  const edgeIds = new Set<string>();
  for (const id of inResult) {
    for (const edge of index.out.get(id) ?? []) {
      if (inResult.has(edge.to) && isDependencyEdge(edge)) edgeIds.add(edge.id);
    }
  }

  return {
    startId,
    startLabel: start.label,
    mode: options.mode,
    hops,
    nodes,
    groups: groupByKind(
      nodes.map((n) => n.id),
      index.nodes
    ),
    edgeIds: [...edgeIds].sort(compareText),
    alreadyFailed: nodes.filter((n) => index.nodes.get(n.id)?.status === 'failed').map((n) => n.id),
    hostFailure,
    assumptions: hostFailure ? [...BLAST_ASSUMPTIONS, HOST_ASSUMPTION] : [...BLAST_ASSUMPTIONS]
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function blastHighlight(result: BlastResult): Highlight {
  const failed = new Set(result.alreadyFailed);
  const nodes: Record<string, HighlightRole> = { [result.startId]: 'primary' };
  for (const n of result.nodes) nodes[n.id] = failed.has(n.id) ? 'danger' : 'secondary';
  const edges: Record<string, HighlightRole> = {};
  for (const id of result.edgeIds) edges[id] = 'secondary';

  const count = result.nodes.length;
  const reach = `${plural(count, 'node')} within ${plural(result.hops, 'hop')}`;
  let detail: string;
  if (result.mode === 'breaks') {
    detail = count === 0 ? `No other nodes depend on ${result.startLabel} through the edges followed.` : `${reach} break if ${result.startLabel} breaks.`;
  } else {
    detail = count === 0 ? `${result.startLabel} needs no other nodes through the edges followed.` : `${reach} are needed by ${result.startLabel}.`;
  }
  if (failed.size > 0) detail += ` ${failed.size} already failed.`;

  return {
    id: 'blast-radius',
    title: result.mode === 'breaks' ? `Blast radius: ${result.startLabel}` : `What ${result.startLabel} needs`,
    detail,
    nodes,
    edges,
    dimOthers: true
  };
}
