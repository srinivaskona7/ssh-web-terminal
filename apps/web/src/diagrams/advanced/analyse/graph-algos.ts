/**
 * Graph algorithms for the analyses, built on `GraphIndex`.
 *
 * Every traversal is iterative: a chain of 2,000+ nodes must not overflow the
 * call stack, and the drawing caps at 2,000 nodes only after the scan.
 */
import type { GraphIndex } from '../../graph-index.js';
import type { DiagramEdge, EdgeKind } from '../../model.js';

export type EdgeFilter = (edge: DiagramEdge) => boolean;

/**
 * Edges that mean "the source needs the target", so the nodes that can reach X
 * are the ones affected when X breaks. `owns` (a controller and what it
 * creates), `orders-after` (start order only) and `hop` (the SSH path) are not
 * needs.
 */
export const DEPENDENCY_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'selects',
  'routes',
  'mounts',
  'uses-config',
  'depends-on',
  'connects',
  'attached',
  'runs',
  'scheduled-on',
  'listens',
  'flow',
  'custom'
]);

/** Edges along which a cycle is a mistake worth reporting. */
export const CYCLE_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['depends-on', 'orders-after', 'owns', 'flow', 'custom']);

export const isDependencyEdge: EdgeFilter = (edge) => DEPENDENCY_EDGE_KINDS.has(edge.kind);
export const isCycleEdge: EdgeFilter = (edge) => CYCLE_EDGE_KINDS.has(edge.kind);

export interface ReachOptions {
  /** Edges to walk; every edge by default. */
  edgeFilter?: EdgeFilter;
  /** Stop after this many edges. Unlimited by default. */
  maxHops?: number;
}

/**
 * Breadth-first reachability. `forward` follows edges from → to (what the start
 * needs), `backward` follows them to → from (what needs the start). Returns the
 * hop distance of every reached node, the starts at 0, in discovery order.
 */
export function reachable(
  index: GraphIndex,
  starts: string | readonly string[],
  direction: 'forward' | 'backward',
  options: ReachOptions = {}
): Map<string, number> {
  const maxHops = options.maxHops ?? Number.POSITIVE_INFINITY;
  const filter = options.edgeFilter;
  const distance = new Map<string, number>();
  let frontier: string[] = [];
  for (const id of typeof starts === 'string' ? [starts] : starts) {
    if (!index.nodes.has(id) || distance.has(id)) continue;
    distance.set(id, 0);
    frontier.push(id);
  }
  const edgesOf = direction === 'forward' ? index.out : index.in;
  for (let hops = 1; hops <= maxHops && frontier.length > 0; hops += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of edgesOf.get(id) ?? []) {
        if (filter && !filter(edge)) continue;
        const other = direction === 'forward' ? edge.to : edge.from;
        if (distance.has(other)) continue;
        distance.set(other, hops);
        next.push(other);
      }
    }
    frontier = next;
  }
  return distance;
}

export interface PathStep {
  from: string;
  to: string;
  edge: DiagramEdge;
  /** The edge was walked against its direction (only in undirected searches). */
  reversed: boolean;
}

export interface PathResult {
  nodes: string[];
  steps: PathStep[];
}

export interface PathOptions {
  /** Walk edges only from → to; otherwise either way. */
  directed: boolean;
  edgeFilter?: EdgeFilter;
}

/** Fewest-hop path, or null when `to` cannot be reached (or either node is not in the graph). */
export function shortestPath(index: GraphIndex, from: string, to: string, options: PathOptions): PathResult | null {
  if (!index.nodes.has(from) || !index.nodes.has(to)) return null;
  if (from === to) return { nodes: [from], steps: [] };
  const filter = options.edgeFilter;
  const arrivedBy = new Map<string, PathStep>();
  const seen = new Set<string>([from]);
  let frontier = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const candidates: PathStep[] = [];
      for (const edge of index.out.get(id) ?? []) candidates.push({ from: id, to: edge.to, edge, reversed: false });
      if (!options.directed) {
        for (const edge of index.in.get(id) ?? []) candidates.push({ from: id, to: edge.from, edge, reversed: true });
      }
      for (const step of candidates) {
        if (filter && !filter(step.edge)) continue;
        if (seen.has(step.to)) continue;
        seen.add(step.to);
        arrivedBy.set(step.to, step);
        if (step.to === to) return rebuildPath(arrivedBy, from, to);
        next.push(step.to);
      }
    }
    frontier = next;
  }
  return null;
}

function rebuildPath(arrivedBy: Map<string, PathStep>, from: string, to: string): PathResult {
  const steps: PathStep[] = [];
  let current = to;
  while (current !== from) {
    const step = arrivedBy.get(current);
    if (!step) break;
    steps.push(step);
    current = step.from;
  }
  steps.reverse();
  return { nodes: [from, ...steps.map((s) => s.to)], steps };
}

// ---------------------------------------------------------------------------
// Articulation points and bridges (undirected, iterative Tarjan)
// ---------------------------------------------------------------------------

export interface ArticulationPoint {
  id: string;
  /** Connected pieces its removal leaves (its own piece of the graph, not counting itself). */
  pieces: number;
  /** Nodes that end up apart from the largest of those pieces. */
  cutOff: number;
}

export interface Bridge {
  edge: DiagramEdge;
  /** Nodes on the smaller side once the edge is removed. */
  smallerSide: number;
}

export interface Connectivity {
  /** Most nodes cut off first, then by id. */
  articulationPoints: ArticulationPoint[];
  /** Edges whose removal splits their piece in two: larger smaller side first, then by edge id. */
  bridges: Bridge[];
}

interface Link {
  to: Vertex;
  /** Shared by both ends of one edge, so a parallel edge is not mistaken for the way back. */
  link: number;
}

interface Vertex {
  id: string;
  adjacent: Link[];
  discovered: number;
  low: number;
  size: number;
  /** Sizes of the child subtrees this vertex separates from its parent side. */
  separated: number[];
}

interface Frame {
  vertex: Vertex;
  viaLink: number;
  next: number;
}

/**
 * Direction is ignored and self-loops are skipped. Two edges between the same
 * pair of nodes are parallel, so neither is a bridge. Works on every connected
 * piece of the graph on its own.
 */
export function articulationPointsAndBridges(index: GraphIndex, options: { edgeFilter?: EdgeFilter } = {}): Connectivity {
  const vertices = new Map<string, Vertex>();
  for (const id of index.nodes.keys()) {
    vertices.set(id, { id, adjacent: [], discovered: -1, low: 0, size: 0, separated: [] });
  }
  const linkEdges: DiagramEdge[] = [];
  for (const [fromId, edges] of index.out) {
    const a = vertices.get(fromId);
    for (const edge of edges) {
      if (options.edgeFilter && !options.edgeFilter(edge)) continue;
      if (edge.from === edge.to) continue;
      const b = vertices.get(edge.to);
      if (!a || !b) continue;
      const link = linkEdges.length;
      linkEdges.push(edge);
      a.adjacent.push({ to: b, link });
      b.adjacent.push({ to: a, link });
    }
  }

  const articulationPoints: ArticulationPoint[] = [];
  const bridges: Bridge[] = [];
  let clock = 0;
  for (const root of vertices.values()) {
    if (root.discovered !== -1) continue;
    const piece: Vertex[] = [root];
    const pieceBridges: { edge: DiagramEdge; childSide: number }[] = [];
    root.discovered = root.low = clock++;
    root.size = 1;
    const stack: Frame[] = [{ vertex: root, viaLink: -1, next: 0 }];
    for (let frame = stack.at(-1); frame; frame = stack.at(-1)) {
      const v = frame.vertex;
      const step = v.adjacent[frame.next];
      if (step) {
        frame.next += 1;
        if (step.link === frame.viaLink) continue;
        const w = step.to;
        if (w.discovered === -1) {
          w.discovered = w.low = clock++;
          w.size = 1;
          piece.push(w);
          stack.push({ vertex: w, viaLink: step.link, next: 0 });
        } else if (w.discovered < v.low) {
          v.low = w.discovered;
        }
        continue;
      }
      stack.pop();
      const parent = stack.at(-1)?.vertex;
      if (!parent) continue;
      parent.size += v.size;
      if (v.low < parent.low) parent.low = v.low;
      if (v.low > parent.discovered) {
        const edge = linkEdges[frame.viaLink];
        if (edge) pieceBridges.push({ edge, childSide: v.size });
      }
      if (v.low >= parent.discovered) parent.separated.push(v.size);
    }

    for (const { edge, childSide } of pieceBridges) {
      bridges.push({ edge, smallerSide: Math.min(childSide, root.size - childSide) });
    }
    for (const v of piece) {
      if (v.separated.length === 0) continue;
      if (v === root && v.separated.length < 2) continue;
      let apart = 0;
      let largest = 0;
      for (const n of v.separated) {
        apart += n;
        if (n > largest) largest = n;
      }
      const parentSide = root.size - 1 - apart;
      if (parentSide > largest) largest = parentSide;
      articulationPoints.push({
        id: v.id,
        pieces: v.separated.length + (parentSide > 0 ? 1 : 0),
        cutOff: root.size - 1 - largest
      });
    }
  }

  articulationPoints.sort((a, b) => b.cutOff - a.cutOff || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  bridges.sort((a, b) => b.smallerSide - a.smallerSide || (a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0));
  return { articulationPoints, bridges };
}

// ---------------------------------------------------------------------------
// Strongly connected components (directed, iterative Tarjan)
// ---------------------------------------------------------------------------

interface SccVertex {
  id: string;
  successors: SccVertex[];
  order: number;
  low: number;
  onStack: boolean;
}

interface SccFrame {
  vertex: SccVertex;
  next: number;
}

/**
 * Every node belongs to exactly one component; a component of one node is
 * either acyclic or has only a self-loop, which callers check themselves.
 */
export function stronglyConnectedComponents(index: GraphIndex, options: { edgeFilter?: EdgeFilter } = {}): string[][] {
  const vertices = new Map<string, SccVertex>();
  for (const id of index.nodes.keys()) vertices.set(id, { id, successors: [], order: -1, low: 0, onStack: false });
  for (const [fromId, edges] of index.out) {
    const from = vertices.get(fromId);
    for (const edge of edges) {
      if (options.edgeFilter && !options.edgeFilter(edge)) continue;
      const to = vertices.get(edge.to);
      if (from && to) from.successors.push(to);
    }
  }

  const components: string[][] = [];
  const open: SccVertex[] = [];
  let clock = 0;
  for (const start of vertices.values()) {
    if (start.order !== -1) continue;
    start.order = start.low = clock++;
    start.onStack = true;
    open.push(start);
    const stack: SccFrame[] = [{ vertex: start, next: 0 }];
    for (let frame = stack.at(-1); frame; frame = stack.at(-1)) {
      const v = frame.vertex;
      const w = v.successors[frame.next];
      if (w) {
        frame.next += 1;
        if (w.order === -1) {
          w.order = w.low = clock++;
          w.onStack = true;
          open.push(w);
          stack.push({ vertex: w, next: 0 });
        } else if (w.onStack && w.order < v.low) {
          v.low = w.order;
        }
        continue;
      }
      stack.pop();
      if (v.low === v.order) {
        const members: string[] = [];
        for (let member = open.pop(); member; member = open.pop()) {
          member.onStack = false;
          members.push(member.id);
          if (member === v) break;
        }
        components.push(members);
      }
      const parent = stack.at(-1)?.vertex;
      if (parent && v.low < parent.low) parent.low = v.low;
    }
  }
  return components;
}

// ---------------------------------------------------------------------------
// Degrees
// ---------------------------------------------------------------------------

export interface Degree {
  /** Distinct nodes with an edge into this one (fan-in). */
  in: number;
  /** Distinct nodes this one has an edge to (fan-out). */
  out: number;
  total: number;
}

/** Counts distinct neighbours, so five edges from one client are one caller. Self-loops are not counted. */
export function degrees(index: GraphIndex, options: { edgeFilter?: EdgeFilter } = {}): Map<string, Degree> {
  const filter = options.edgeFilter;
  const result = new Map<string, Degree>();
  for (const id of index.nodes.keys()) {
    const inbound = new Set<string>();
    const outbound = new Set<string>();
    for (const edge of index.in.get(id) ?? []) {
      if (edge.from !== id && (!filter || filter(edge))) inbound.add(edge.from);
    }
    for (const edge of index.out.get(id) ?? []) {
      if (edge.to !== id && (!filter || filter(edge))) outbound.add(edge.to);
    }
    result.set(id, { in: inbound.size, out: outbound.size, total: inbound.size + outbound.size });
  }
  return result;
}
