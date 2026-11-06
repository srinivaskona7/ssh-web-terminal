/**
 * Deterministic layered (Sugiyama-style) layout for a compound graph.
 *
 * - Containers (a node other than a leaf that other nodes name as `parent`) are
 *   laid out bottom-up: each container's children form a layered graph of their
 *   own, and the container is sized around the result.
 * - Edges between nodes in different containers are lifted to the level where
 *   their ancestors are siblings, so the containers are layered, not the leaves.
 * - Each level: DFS cycle breaking, longest-path layering, dummy nodes for long
 *   edges, barycentre crossing reduction (best of several sweeps), and a
 *   least-squares coordinate pass that keeps the order and the spacing.
 * - Disconnected components are packed in rows.
 *
 * Pure and dependency-free. Never throws on odd input: self-loops, duplicate
 * edges, dangling edges, duplicate ids, parent cycles and dangling parents are
 * all tolerated. No recursion, so a 2,000-deep chain cannot overflow the stack.
 */
import type { LayoutDirection } from '../model.js';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutNodeInput {
  id: string;
  parent?: string | null;
  /** Leaf size. For a container this is the minimum width (its title). */
  width?: number;
  height?: number;
}

export interface LayoutEdgeInput {
  id: string;
  from: string;
  to: string;
}

export interface LayoutInput {
  nodes: readonly LayoutNodeInput[];
  edges: readonly LayoutEdgeInput[];
}

export interface LayoutOptions {
  direction?: LayoutDirection;
  nodeWidth?: number;
  nodeHeight?: number;
  /** Space between neighbours in one layer. */
  nodeGap?: number;
  /** Space between layers. */
  rankGap?: number;
  /** Space between disconnected components. */
  componentGap?: number;
  containerPadding?: number;
  /** Height of a container's title strip. */
  headerHeight?: number;
  margin?: number;
  /** Cap on dummy nodes used to route long edges; beyond it edges are drawn direct. */
  maxDummyNodes?: number;
  /** Crossing-reduction sweeps per level. */
  sweeps?: number;
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  parent: string | null;
  container: boolean;
  children: string[];
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  /** Route from the source's port to the target's port, through the waypoints. */
  points: Point[];
  /** SVG path data (cubic segments, or a line for a vertical edge). */
  path: string;
  /** Where a hover label sits. */
  label: Point;
  selfLoop: boolean;
  /** Drawn against the layer direction because the edge closes a cycle. */
  reversed: boolean;
  /** Between a container and something inside it. */
  vertical: boolean;
}

export interface LayoutStats {
  crossings: number;
  layers: number;
  dummyNodes: number;
  levels: number;
}

export interface Layout {
  direction: LayoutDirection;
  nodes: LayoutNode[];
  byId: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  bounds: Rect;
  /** Edge ids dropped because an endpoint is not in the node list. */
  skippedEdges: string[];
  stats: LayoutStats;
}

type Resolved = Required<LayoutOptions>;

export const DEFAULT_LAYOUT_OPTIONS: Resolved = {
  direction: 'LR',
  nodeWidth: 140,
  nodeHeight: 44,
  nodeGap: 24,
  rankGap: 64,
  componentGap: 40,
  containerPadding: 16,
  headerHeight: 30,
  margin: 24,
  maxDummyNodes: 60_000,
  sweeps: 6
};

/** Cross-axis size of a dummy node (a point on a routed edge). */
const DUMMY_CROSS = 6;
/** Gap used next to a dummy node: routes can pass closer than boxes. */
const ROUTE_GAP = 12;
const PACK_ASPECT = 1.6;
const LOOP_SIZE = 28;
const PARALLEL_STEP = 12;

interface Item {
  w: number;
  h: number;
}

interface Pair {
  from: number;
  to: number;
}

interface ComponentResult {
  /** Top-left of each member, aligned with the member list. */
  x: number[];
  y: number[];
  width: number;
  height: number;
  /** Waypoints per pair key, relative to the component origin, in pair order. */
  waypoints: Map<number, Point[]>;
  reversed: Set<number>;
  crossings: number;
  layers: number;
  dummies: number;
}

interface LevelResult {
  x: number[];
  y: number[];
  width: number;
  height: number;
  waypoints: Map<number, Point[]>;
  reversed: Set<number>;
}

interface Context {
  o: Resolved;
  LR: boolean;
  dummyUsed: number;
  crossings: number;
  layers: number;
}

// ---------------------------------------------------------------------------
// One level
// ---------------------------------------------------------------------------

function connectedComponents(n: number, pairs: readonly Pair[]): number[] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur] as number;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  for (const p of pairs) {
    const a = find(p.from);
    const b = find(p.to);
    if (a !== b) {
      // Keep the smaller index as the root so component ids follow item order.
      if (a < b) parent[b] = a;
      else parent[a] = b;
    }
  }
  const ids = new Map<number, number>();
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    let id = ids.get(root);
    if (id === undefined) {
      id = ids.size;
      ids.set(root, id);
    }
    out[i] = id;
  }
  return out;
}

interface LNode {
  /** Index into the component's members, or -1 for a dummy. */
  member: number;
  layer: number;
  main: number;
  cross: number;
  up: number[];
  down: number[];
}

/**
 * Place items in a row, in order, at the centres closest (least squares) to
 * `desired` while keeping `centre[i+1] - centre[i] >= minStep[i]`. Solved
 * exactly by pool-adjacent-violators on the offset-shifted targets.
 */
function placeRow(desired: readonly number[], minStep: readonly number[]): number[] {
  const n = desired.length;
  const offset = new Array<number>(n);
  offset[0] = 0;
  for (let i = 1; i < n; i += 1) offset[i] = (offset[i - 1] as number) + (minStep[i - 1] as number);
  const sums: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < n; i += 1) {
    sums.push((desired[i] as number) - (offset[i] as number));
    counts.push(1);
    while (sums.length > 1) {
      const last = sums.length - 1;
      const meanLast = (sums[last] as number) / (counts[last] as number);
      const meanPrev = (sums[last - 1] as number) / (counts[last - 1] as number);
      if (meanPrev <= meanLast) break;
      sums[last - 1] = (sums[last - 1] as number) + (sums[last] as number);
      counts[last - 1] = (counts[last - 1] as number) + (counts[last] as number);
      sums.pop();
      counts.pop();
    }
  }
  const out = new Array<number>(n);
  let k = 0;
  for (let b = 0; b < sums.length; b += 1) {
    const mean = (sums[b] as number) / (counts[b] as number);
    for (let c = 0; c < (counts[b] as number); c += 1) {
      out[k] = mean + (offset[k] as number);
      k += 1;
    }
  }
  return out;
}

function countCrossings(layers: readonly number[][], nodes: readonly LNode[], pos: readonly number[]): number {
  let total = 0;
  for (let i = 0; i + 1 < layers.length; i += 1) {
    const upper = layers[i] as number[];
    const size = (layers[i + 1] as number[]).length;
    if (size < 2) continue;
    const bit = new Int32Array(size + 1);
    let seen = 0;
    for (const a of upper) {
      const down = (nodes[a] as LNode).down;
      if (down.length === 0) continue;
      const targets = down.map((b) => pos[b] as number).sort((p, q) => p - q);
      for (const t of targets) {
        let q = 0;
        for (let k = t + 1; k > 0; k -= k & -k) q += bit[k] as number;
        total += seen - q;
      }
      for (const t of targets) {
        for (let k = t + 1; k <= size; k += k & -k) bit[k] = (bit[k] as number) + 1;
        seen += 1;
      }
    }
  }
  return total;
}

function reorderLayers(layers: number[][], nodes: readonly LNode[], pos: number[], downward: boolean): void {
  const from = downward ? 1 : layers.length - 2;
  const to = downward ? layers.length : -1;
  const step = downward ? 1 : -1;
  for (let i = from; i !== to; i += step) {
    const layer = layers[i] as number[];
    if (layer.length < 2) continue;
    const movable: { id: number; bc: number; idx: number }[] = [];
    const fixed = new Array<boolean>(layer.length).fill(false);
    for (let idx = 0; idx < layer.length; idx += 1) {
      const id = layer[idx] as number;
      const neighbours = downward ? (nodes[id] as LNode).up : (nodes[id] as LNode).down;
      if (neighbours.length === 0) {
        fixed[idx] = true;
        continue;
      }
      let sum = 0;
      for (const nb of neighbours) sum += pos[nb] as number;
      movable.push({ id, bc: sum / neighbours.length, idx });
    }
    movable.sort((a, b) => a.bc - b.bc || a.idx - b.idx);
    let k = 0;
    for (let idx = 0; idx < layer.length; idx += 1) {
      if (fixed[idx]) continue;
      layer[idx] = (movable[k] as { id: number }).id;
      k += 1;
    }
    for (let idx = 0; idx < layer.length; idx += 1) pos[layer[idx] as number] = idx;
  }
}

interface Chain {
  /** Dummies from the DAG source layer to the DAG target layer. */
  dummies: number[];
}

function layoutComponent(
  members: readonly number[],
  pairs: readonly Pair[],
  items: readonly Item[],
  ctx: Context
): ComponentResult {
  const { o, LR } = ctx;
  const m = members.length;
  const mainOf = (it: Item): number => (LR ? it.w : it.h);
  const crossOf = (it: Item): number => (LR ? it.h : it.w);

  if (m === 1) {
    const it = items[members[0] as number] as Item;
    ctx.layers += 1;
    return { x: [0], y: [0], width: it.w, height: it.h, waypoints: new Map(), reversed: new Set(), crossings: 0, layers: 1, dummies: 0 };
  }

  const local = new Map<number, number>();
  members.forEach((g, i) => local.set(g, i));
  const lp: [number, number][] = pairs.map((p) => [local.get(p.from) as number, local.get(p.to) as number]);

  // ---- cycle breaking: iterative DFS, back edges are reversed ----
  const out: number[][] = Array.from({ length: m }, () => []);
  const indeg = new Array<number>(m).fill(0);
  for (const [u, v] of lp) {
    (out[u] as number[]).push(v);
    indeg[v] = (indeg[v] as number) + 1;
  }
  for (const list of out) list.sort((a, b) => a - b);
  const state = new Uint8Array(m);
  const cursor = new Array<number>(m).fill(0);
  const back = new Set<number>();
  const rootOrder: number[] = [];
  for (let i = 0; i < m; i += 1) if (indeg[i] === 0) rootOrder.push(i);
  for (let i = 0; i < m; i += 1) if ((indeg[i] as number) > 0) rootOrder.push(i);
  for (const r of rootOrder) {
    if (state[r]) continue;
    const stack = [r];
    state[r] = 1;
    while (stack.length > 0) {
      const u = stack[stack.length - 1] as number;
      const edges = out[u] as number[];
      if ((cursor[u] as number) < edges.length) {
        const v = edges[cursor[u] as number] as number;
        cursor[u] = (cursor[u] as number) + 1;
        if (state[v] === 0) {
          state[v] = 1;
          stack.push(v);
        } else if (state[v] === 1) {
          back.add(u * m + v);
        }
      } else {
        state[u] = 2;
        stack.pop();
      }
    }
  }

  // ---- DAG and longest-path layering (Kahn) ----
  interface DagEdge {
    u: number;
    v: number;
  }
  const dagKeys = new Map<number, DagEdge>();
  const dagOut: number[][] = Array.from({ length: m }, () => []);
  const dagIn = new Array<number>(m).fill(0);
  const pairDag: DagEdge[] = [];
  const pairReversed: boolean[] = [];
  for (const [u, v] of lp) {
    const rev = back.has(u * m + v);
    const du = rev ? v : u;
    const dv = rev ? u : v;
    const key = du * m + dv;
    let edge = dagKeys.get(key);
    if (!edge) {
      edge = { u: du, v: dv };
      dagKeys.set(key, edge);
      (dagOut[du] as number[]).push(dv);
      dagIn[dv] = (dagIn[dv] as number) + 1;
    }
    pairDag.push(edge);
    pairReversed.push(rev);
  }
  const layer = new Array<number>(m).fill(0);
  const remaining = dagIn.slice();
  const queue: number[] = [];
  for (let i = 0; i < m; i += 1) if (remaining[i] === 0) queue.push(i);
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head] as number;
    for (const v of dagOut[u] as number[]) {
      if ((layer[v] as number) < (layer[u] as number) + 1) layer[v] = (layer[u] as number) + 1;
      remaining[v] = (remaining[v] as number) - 1;
      if (remaining[v] === 0) queue.push(v);
    }
  }
  // Pull sources next to their nearest successor so their edges stay short.
  for (let i = 0; i < m; i += 1) {
    const succ = dagOut[i] as number[];
    if (dagIn[i] !== 0 || succ.length === 0) continue;
    let min = Infinity;
    for (const v of succ) if ((layer[v] as number) < min) min = layer[v] as number;
    layer[i] = min - 1;
  }
  let layerCount = 0;
  for (let i = 0; i < m; i += 1) if ((layer[i] as number) + 1 > layerCount) layerCount = (layer[i] as number) + 1;

  // ---- extended graph with dummy nodes for long edges ----
  const nodes: LNode[] = members.map((g, i) => {
    const it = items[g] as Item;
    return { member: i, layer: layer[i] as number, main: mainOf(it), cross: crossOf(it), up: [], down: [] };
  });
  const connect = (a: number, b: number): void => {
    (nodes[a] as LNode).down.push(b);
    (nodes[b] as LNode).up.push(a);
  };
  const chains = new Map<DagEdge, Chain>();
  let dummies = 0;
  for (const edge of dagKeys.values()) {
    const span = (layer[edge.v] as number) - (layer[edge.u] as number);
    if (span <= 1) {
      connect(edge.u, edge.v);
      continue;
    }
    if (ctx.dummyUsed + span - 1 > ctx.o.maxDummyNodes) continue; // routed direct; ignored for ordering
    let prev = edge.u;
    const chain: Chain = { dummies: [] };
    for (let k = 1; k < span; k += 1) {
      const id = nodes.length;
      nodes.push({ member: -1, layer: (layer[edge.u] as number) + k, main: 0, cross: DUMMY_CROSS, up: [], down: [] });
      chain.dummies.push(id);
      connect(prev, id);
      prev = id;
    }
    connect(prev, edge.v);
    chains.set(edge, chain);
    ctx.dummyUsed += span - 1;
    dummies += span - 1;
  }

  // ---- initial order: DFS from the sources, following down edges ----
  const layers: number[][] = Array.from({ length: layerCount }, () => []);
  const pos = new Array<number>(nodes.length).fill(-1);
  const visited = new Uint8Array(nodes.length);
  const place = (id: number): void => {
    const l = layers[(nodes[id] as LNode).layer] as number[];
    pos[id] = l.length;
    l.push(id);
  };
  for (let s = 0; s < nodes.length; s += 1) {
    if (visited[s] || (nodes[s] as LNode).up.length > 0) continue;
    const stack: number[] = [s];
    visited[s] = 1;
    place(s);
    const it = new Map<number, number>();
    while (stack.length > 0) {
      const u = stack[stack.length - 1] as number;
      const downs = (nodes[u] as LNode).down;
      const c = it.get(u) ?? 0;
      if (c < downs.length) {
        it.set(u, c + 1);
        const v = downs[c] as number;
        if (!visited[v]) {
          visited[v] = 1;
          place(v);
          stack.push(v);
        }
      } else {
        stack.pop();
      }
    }
  }
  for (let s = 0; s < nodes.length; s += 1) if (!visited[s]) place(s);

  // ---- crossing reduction: keep the best ordering seen ----
  let best = layers.map((l) => l.slice());
  let bestCrossings = countCrossings(layers, nodes, pos);
  for (let sweep = 0; sweep < ctx.o.sweeps && bestCrossings > 0; sweep += 1) {
    reorderLayers(layers, nodes, pos, true);
    reorderLayers(layers, nodes, pos, false);
    const c = countCrossings(layers, nodes, pos);
    if (c < bestCrossings) {
      bestCrossings = c;
      best = layers.map((l) => l.slice());
    }
  }
  for (let i = 0; i < layers.length; i += 1) {
    layers[i] = (best[i] as number[]).slice();
    (layers[i] as number[]).forEach((id, idx) => {
      pos[id] = idx;
    });
  }

  // ---- cross-axis coordinates ----
  const crossPos = new Array<number>(nodes.length).fill(0);
  const stepsFor = (layerIds: readonly number[]): number[] => {
    const steps: number[] = [];
    for (let i = 0; i + 1 < layerIds.length; i += 1) {
      const a = nodes[layerIds[i] as number] as LNode;
      const b = nodes[layerIds[i + 1] as number] as LNode;
      const gap = a.member < 0 || b.member < 0 ? ROUTE_GAP : o.nodeGap;
      steps.push((a.cross + b.cross) / 2 + gap);
    }
    return steps;
  };
  for (const ids of layers) {
    let c = 0;
    ids.forEach((id, idx) => {
      const node = nodes[id] as LNode;
      if (idx > 0) {
        const prev = nodes[ids[idx - 1] as number] as LNode;
        c += (prev.cross + node.cross) / 2 + (prev.member < 0 || node.member < 0 ? ROUTE_GAP : o.nodeGap);
      }
      crossPos[id] = c;
    });
  }
  const steps = layers.map((ids) => stepsFor(ids));
  const align = (ids: readonly number[], stepList: readonly number[]): void => {
    if (ids.length === 0) return;
    const desired = ids.map((id) => {
      const node = nodes[id] as LNode;
      const nb = node.up.length + node.down.length;
      if (nb === 0) return crossPos[id] as number;
      let sum = 0;
      for (const u of node.up) sum += crossPos[u] as number;
      for (const d of node.down) sum += crossPos[d] as number;
      return sum / nb;
    });
    const placed = placeRow(desired, stepList);
    ids.forEach((id, idx) => {
      crossPos[id] = placed[idx] as number;
    });
  };
  for (let pass = 0; pass < 3; pass += 1) {
    for (let i = 0; i < layers.length; i += 1) align(layers[i] as number[], steps[i] as number[]);
    for (let i = layers.length - 1; i >= 0; i -= 1) align(layers[i] as number[], steps[i] as number[]);
  }
  for (let i = 0; i < layers.length; i += 1) align(layers[i] as number[], steps[i] as number[]);

  let minCross = Infinity;
  let maxCross = -Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i] as LNode;
    const lo = (crossPos[i] as number) - node.cross / 2;
    const hi = (crossPos[i] as number) + node.cross / 2;
    if (lo < minCross) minCross = lo;
    if (hi > maxCross) maxCross = hi;
  }
  for (let i = 0; i < crossPos.length; i += 1) crossPos[i] = (crossPos[i] as number) - minCross;

  // ---- main-axis coordinates ----
  const thick = new Array<number>(layerCount).fill(0);
  for (const node of nodes) if (node.main > (thick[node.layer] as number)) thick[node.layer] = node.main;
  const mainStart = new Array<number>(layerCount).fill(0);
  let mainTotal = 0;
  for (let l = 0; l < layerCount; l += 1) {
    mainStart[l] = mainTotal;
    mainTotal += (thick[l] as number) + (l + 1 < layerCount ? o.rankGap : 0);
  }
  const centreMain = (id: number): number => {
    const node = nodes[id] as LNode;
    return (mainStart[node.layer] as number) + (thick[node.layer] as number) / 2;
  };
  const toPoint = (main: number, cross: number): Point => (LR ? { x: main, y: cross } : { x: cross, y: main });

  const xs = new Array<number>(m);
  const ys = new Array<number>(m);
  for (let i = 0; i < m; i += 1) {
    const it = items[members[i] as number] as Item;
    const c = toPoint(centreMain(i), crossPos[i] as number);
    xs[i] = c.x - it.w / 2;
    ys[i] = c.y - it.h / 2;
  }

  const waypoints = new Map<number, Point[]>();
  const reversed = new Set<number>();
  pairs.forEach((p, idx) => {
    const chain = chains.get(pairDag[idx] as DagEdge);
    const rev = pairReversed[idx] as boolean;
    const key = p.from * items.length + p.to;
    if (rev) reversed.add(key);
    if (!chain) return;
    const pts = chain.dummies.map((d) => toPoint(centreMain(d), crossPos[d] as number));
    waypoints.set(key, rev ? pts.reverse() : pts);
  });

  const width = LR ? mainTotal : maxCross - minCross;
  const height = LR ? maxCross - minCross : mainTotal;
  ctx.crossings += bestCrossings;
  ctx.layers += layerCount;
  return { x: xs, y: ys, width, height, waypoints, reversed, crossings: bestCrossings, layers: layerCount, dummies };
}

function layoutLevel(items: readonly Item[], pairs: readonly Pair[], ctx: Context): LevelResult {
  const n = items.length;
  const result: LevelResult = { x: new Array<number>(n).fill(0), y: new Array<number>(n).fill(0), width: 0, height: 0, waypoints: new Map(), reversed: new Set() };
  if (n === 0) return result;

  const comp = connectedComponents(n, pairs);
  let compCount = 0;
  for (const c of comp) if (c + 1 > compCount) compCount = c + 1;
  const memberLists: number[][] = Array.from({ length: compCount }, () => []);
  for (let i = 0; i < n; i += 1) (memberLists[comp[i] as number] as number[]).push(i);
  const pairLists: Pair[][] = Array.from({ length: compCount }, () => []);
  for (const p of pairs) (pairLists[comp[p.from] as number] as Pair[]).push(p);

  const layouts = memberLists.map((members, c) => layoutComponent(members, pairLists[c] as Pair[], items, ctx));

  // Shelf-pack the components, tallest first (stable), into rows no wider than
  // a roughly 1.6:1 block, so many isolated nodes become a grid, not a strip.
  const order = layouts.map((_, i) => i);
  if (layouts.length > 1) order.sort((a, b) => (layouts[b] as ComponentResult).height - (layouts[a] as ComponentResult).height || a - b);
  let area = 0;
  let widest = 0;
  for (const l of layouts) {
    area += (l.width + ctx.o.componentGap) * (l.height + ctx.o.componentGap);
    if (l.width > widest) widest = l.width;
  }
  const rowLimit = layouts.length > 1 ? Math.max(widest, Math.sqrt(area * PACK_ASPECT)) : widest;
  let cx = 0;
  let cy = 0;
  let rowHeight = 0;
  let totalW = 0;
  const offsets = new Array<Point>(layouts.length);
  for (const ci of order) {
    const l = layouts[ci] as ComponentResult;
    if (cx > 0 && cx + l.width > rowLimit) {
      cx = 0;
      cy += rowHeight + ctx.o.componentGap;
      rowHeight = 0;
    }
    offsets[ci] = { x: cx, y: cy };
    cx += l.width + ctx.o.componentGap;
    if (l.height > rowHeight) rowHeight = l.height;
    if (cx - ctx.o.componentGap > totalW) totalW = cx - ctx.o.componentGap;
  }
  result.width = totalW;
  result.height = cy + rowHeight;

  layouts.forEach((l, ci) => {
    const off = offsets[ci] as Point;
    const members = memberLists[ci] as number[];
    members.forEach((g, i) => {
      result.x[g] = off.x + (l.x[i] as number);
      result.y[g] = off.y + (l.y[i] as number);
    });
    for (const [key, pts] of l.waypoints) result.waypoints.set(key, pts.map((p) => ({ x: p.x + off.x, y: p.y + off.y })));
    for (const key of l.reversed) result.reversed.add(key);
  });
  return result;
}

// ---------------------------------------------------------------------------
// Whole graph
// ---------------------------------------------------------------------------

const round1 = (v: number): number => Math.round(v * 10) / 10;

function formatPoint(p: Point): string {
  return `${round1(p.x)},${round1(p.y)}`;
}

/** Cubic segments between the points, with tangents along the layer axis. */
function curvePath(points: readonly Point[], LR: boolean): string {
  const first = points[0] as Point;
  let d = `M${formatPoint(first)}`;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i - 1] as Point;
    const q = points[i] as Point;
    const delta = LR ? q.x - p.x : q.y - p.y;
    // Forward segments bend halfway; backward ones swing out so they loop round.
    const k = delta >= 0 ? delta / 2 : -delta / 2 + 40;
    const c1: Point = LR ? { x: p.x + k, y: p.y } : { x: p.x, y: p.y + k };
    const c2: Point = LR ? { x: q.x - k, y: q.y } : { x: q.x, y: q.y - k };
    d += ` C${formatPoint(c1)} ${formatPoint(c2)} ${formatPoint(q)}`;
  }
  return d;
}

function midpoint(points: readonly Point[]): Point {
  if (points.length === 1) return points[0] as Point;
  const i = Math.floor((points.length - 1) / 2);
  const a = points[i] as Point;
  const b = points[i + 1] as Point;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

interface Classified {
  kind: 'self' | 'vertical' | 'sibling' | 'skipped';
  a: number;
  b: number;
  /** Parent index of the level the edge was lifted to (-1 = root). */
  level: number;
  ca: number;
  cb: number;
}

interface Draft {
  edge: number;
  a: number;
  b: number;
  waypoints: Point[];
  forward: boolean;
  reversed: boolean;
}

export function layoutGraph(input: LayoutInput, options: LayoutOptions = {}): Layout {
  const o: Resolved = { ...DEFAULT_LAYOUT_OPTIONS, ...stripUndefined(options) };
  const LR = o.direction === 'LR';
  const ctx: Context = { o, LR, dummyUsed: 0, crossings: 0, layers: 0 };

  // ---- ids (the first node with an id wins) ----
  const ids: string[] = [];
  const index = new Map<string, number>();
  const specs: LayoutNodeInput[] = [];
  for (const node of input.nodes) {
    if (index.has(node.id)) continue;
    index.set(node.id, ids.length);
    ids.push(node.id);
    specs.push(node);
  }
  const N = ids.length;

  // ---- containment forest, parent cycles and dangling parents cut ----
  const parent = new Array<number>(N).fill(-1);
  for (let i = 0; i < N; i += 1) {
    const p = (specs[i] as LayoutNodeInput).parent;
    const pi = p === undefined || p === null ? undefined : index.get(p);
    if (pi !== undefined && pi !== i) parent[i] = pi;
  }
  const mark = new Uint8Array(N);
  for (let i = 0; i < N; i += 1) {
    if (mark[i] === 2) continue;
    const path: number[] = [];
    let cur = i;
    while (cur !== -1 && mark[cur] === 0) {
      mark[cur] = 1;
      path.push(cur);
      cur = parent[cur] as number;
    }
    if (cur !== -1 && mark[cur] === 1) parent[path[path.length - 1] as number] = -1;
    for (const p of path) mark[p] = 2;
  }
  const children: number[][] = Array.from({ length: N }, () => []);
  const roots: number[] = [];
  for (let i = 0; i < N; i += 1) {
    const p = parent[i] as number;
    if (p === -1) roots.push(i);
    else (children[p] as number[]).push(i);
  }
  const depth = new Array<number>(N).fill(0);
  const bfs = roots.slice();
  for (let head = 0; head < bfs.length; head += 1) {
    const u = bfs[head] as number;
    for (const c of children[u] as number[]) {
      depth[c] = (depth[u] as number) + 1;
      bfs.push(c);
    }
  }
  let maxDepth = 0;
  for (const d of depth) if (d > maxDepth) maxDepth = d;

  // ---- classify edges and lift them to sibling level ----
  const classified: Classified[] = [];
  const skipped: string[] = [];
  const levelPairs = new Map<number, Map<number, Pair>>();
  input.edges.forEach((e) => {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined) {
      skipped.push(e.id);
      classified.push({ kind: 'skipped', a: -1, b: -1, level: -1, ca: -1, cb: -1 });
      return;
    }
    if (a === b) {
      classified.push({ kind: 'self', a, b, level: -1, ca: a, cb: b });
      return;
    }
    let ca = a;
    let cb = b;
    while ((depth[ca] as number) > (depth[cb] as number)) ca = parent[ca] as number;
    while ((depth[cb] as number) > (depth[ca] as number)) cb = parent[cb] as number;
    if (ca === cb) {
      classified.push({ kind: 'vertical', a, b, level: -1, ca, cb });
      return;
    }
    while (parent[ca] !== parent[cb]) {
      ca = parent[ca] as number;
      cb = parent[cb] as number;
    }
    const level = parent[ca] as number;
    let pairs = levelPairs.get(level);
    if (!pairs) {
      pairs = new Map();
      levelPairs.set(level, pairs);
    }
    pairs.set(ca * N + cb, { from: ca, to: cb });
    classified.push({ kind: 'sibling', a, b, level, ca, cb });
  });

  // ---- sizes, bottom-up ----
  const w = new Array<number>(N);
  const h = new Array<number>(N);
  for (let i = 0; i < N; i += 1) {
    const spec = specs[i] as LayoutNodeInput;
    w[i] = Math.max(1, spec.width ?? o.nodeWidth);
    h[i] = Math.max(1, spec.height ?? o.nodeHeight);
  }
  const lx = new Array<number>(N).fill(0);
  const ly = new Array<number>(N).fill(0);
  const levels = new Map<number, { result: LevelResult; members: number[]; localIndex: Map<number, number> }>();

  const runLevel = (owner: number): void => {
    const members = owner === -1 ? roots : (children[owner] as number[]);
    const localIndex = new Map<number, number>();
    members.forEach((g, i) => localIndex.set(g, i));
    const items: Item[] = members.map((g) => ({ w: w[g] as number, h: h[g] as number }));
    const pairs: Pair[] = [];
    // Pair keys inside a level use local indices.
    const raw = levelPairs.get(owner);
    if (raw) {
      for (const p of raw.values()) pairs.push({ from: localIndex.get(p.from) as number, to: localIndex.get(p.to) as number });
    }
    // Map iteration follows insertion order, which follows edge order: deterministic.
    const result = layoutLevel(items, pairs, ctx);
    members.forEach((g, i) => {
      lx[g] = result.x[i] as number;
      ly[g] = result.y[i] as number;
    });
    levels.set(owner, { result, members, localIndex });
    if (owner !== -1) {
      w[owner] = Math.max(w[owner] as number, result.width + 2 * o.containerPadding);
      h[owner] = o.headerHeight + o.containerPadding + result.height + o.containerPadding;
    }
  };
  for (let d = maxDepth; d >= 0; d -= 1) {
    for (let i = 0; i < N; i += 1) {
      if (depth[i] === d && (children[i] as number[]).length > 0) runLevel(i);
    }
  }
  runLevel(-1);

  // ---- absolute positions, top-down ----
  const ax = new Array<number>(N).fill(0);
  const ay = new Array<number>(N).fill(0);
  const originX = new Map<number, number>();
  const originY = new Map<number, number>();
  originX.set(-1, o.margin);
  originY.set(-1, o.margin);
  for (const u of bfs) {
    const p = parent[u] as number;
    ax[u] = (originX.get(p) as number) + (lx[u] as number);
    ay[u] = (originY.get(p) as number) + (ly[u] as number);
    if ((children[u] as number[]).length > 0) {
      originX.set(u, (ax[u] as number) + o.containerPadding);
      originY.set(u, (ay[u] as number) + o.headerHeight + o.containerPadding);
    }
  }

  // ---- edge routes ----
  const isContainer = (i: number): boolean => (children[i] as number[]).length > 0;
  const centre = (i: number): Point => ({ x: (ax[i] as number) + (w[i] as number) / 2, y: (ay[i] as number) + (h[i] as number) / 2 });

  const drafts: Draft[] = [];
  const routes: (LayoutEdge | null)[] = new Array<LayoutEdge | null>(input.edges.length).fill(null);
  const parallel = new Map<string, number[]>();
  input.edges.forEach((e, k) => {
    const c = classified[k] as Classified;
    if (c.kind === 'skipped') return;
    const pairKey = c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`;
    const group = parallel.get(pairKey);
    if (group) group.push(k);
    else parallel.set(pairKey, [k]);
  });
  const parallelIndex = new Array<{ k: number; n: number }>(input.edges.length);
  for (const group of parallel.values()) {
    group.forEach((k, i) => {
      parallelIndex[k] = { k: i, n: group.length };
    });
  }

  input.edges.forEach((e, k) => {
    const c = classified[k] as Classified;
    if (c.kind === 'skipped') return;
    if (c.kind === 'self') {
      const x0 = (ax[c.a] as number) + (w[c.a] as number);
      const cy = isContainer(c.a) ? (ay[c.a] as number) + o.headerHeight / 2 : (ay[c.a] as number) + (h[c.a] as number) / 2;
      const start = { x: x0, y: cy - 8 };
      const end = { x: x0, y: cy + 8 };
      const c1 = { x: x0 + LOOP_SIZE, y: cy - 8 };
      const c2 = { x: x0 + LOOP_SIZE, y: cy + 8 };
      routes[k] = {
        id: e.id,
        from: e.from,
        to: e.to,
        points: [start, c1, c2, end],
        path: `M${formatPoint(start)} C${formatPoint(c1)} ${formatPoint(c2)} ${formatPoint(end)}`,
        label: { x: x0 + LOOP_SIZE, y: cy },
        selfLoop: true,
        reversed: false,
        vertical: false
      };
      return;
    }
    if (c.kind === 'vertical') {
      const aIsOuter = c.ca === c.a;
      const outer = aIsOuter ? c.a : c.b;
      const inner = aIsOuter ? c.b : c.a;
      const top: Point = { x: (ax[outer] as number) + (w[outer] as number) / 2, y: (ay[outer] as number) + o.headerHeight };
      const bottom: Point = { x: (ax[inner] as number) + (w[inner] as number) / 2, y: ay[inner] as number };
      const points = aIsOuter ? [top, bottom] : [bottom, top];
      routes[k] = {
        id: e.id,
        from: e.from,
        to: e.to,
        points,
        path: `M${formatPoint(points[0] as Point)} L${formatPoint(points[1] as Point)}`,
        label: midpoint(points),
        selfLoop: false,
        reversed: false,
        vertical: true
      };
      return;
    }
    const lvl = levels.get(c.level);
    let waypoints: Point[] = [];
    let reversed = false;
    if (lvl) {
      const key = (lvl.localIndex.get(c.ca) as number) * lvl.members.length + (lvl.localIndex.get(c.cb) as number);
      const raw = lvl.result.waypoints.get(key);
      const ox = originX.get(c.level) as number;
      const oy = originY.get(c.level) as number;
      if (raw) waypoints = raw.map((p) => ({ x: p.x + ox, y: p.y + oy }));
      reversed = lvl.result.reversed.has(key);
    }
    const pa = centre(c.a);
    const pb = centre(c.b);
    const forward = LR ? pb.x >= pa.x : pb.y >= pa.y;
    // Parallel edges between the same two nodes fan out instead of overlapping.
    const par = parallelIndex[k] as { k: number; n: number };
    if (par.n > 1) {
      const shift = (par.k - (par.n - 1) / 2) * PARALLEL_STEP;
      if (waypoints.length > 0) waypoints = waypoints.map((p) => (LR ? { x: p.x, y: p.y + shift } : { x: p.x + shift, y: p.y }));
      else waypoints = [LR ? { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 + shift } : { x: (pa.x + pb.x) / 2 + shift, y: (pa.y + pb.y) / 2 }];
    }
    drafts.push({ edge: k, a: c.a, b: c.b, waypoints, forward, reversed });
  });

  // Ports: edges sharing a side of a node are spread along it in the order of
  // where they head, so they leave side by side instead of from one point.
  interface Port {
    draft: number;
    end: 'src' | 'dst';
    key: number;
  }
  const sides = new Map<string, Port[]>();
  const sideOf = (node: number, max: boolean): string => `${node}${max ? '+' : '-'}`;
  const addPort = (node: number, max: boolean, port: Port): void => {
    const key = sideOf(node, max);
    const list = sides.get(key);
    if (list) list.push(port);
    else sides.set(key, [port]);
  };
  const crossOfPoint = (p: Point): number => (LR ? p.y : p.x);
  drafts.forEach((d, di) => {
    const srcMax = d.forward;
    const first = d.waypoints[0] ?? centre(d.b);
    const last = d.waypoints[d.waypoints.length - 1] ?? centre(d.a);
    addPort(d.a, srcMax, { draft: di, end: 'src', key: crossOfPoint(first) });
    addPort(d.b, !srcMax, { draft: di, end: 'dst', key: crossOfPoint(last) });
  });
  const portPoint = new Map<string, Point>();
  for (const [key, list] of sides) {
    const node = Number.parseInt(key, 10);
    const max = key.endsWith('+');
    list.sort((p, q) => p.key - q.key || p.draft - q.draft || (p.end === 'src' ? -1 : 1) - (q.end === 'src' ? -1 : 1));
    list.forEach((port, i) => {
      const t = (i + 1) / (list.length + 1);
      let point: Point;
      if (LR) {
        const span = isContainer(node) ? o.headerHeight : (h[node] as number);
        point = { x: (ax[node] as number) + (max ? (w[node] as number) : 0), y: (ay[node] as number) + t * span };
      } else {
        point = { x: (ax[node] as number) + t * (w[node] as number), y: (ay[node] as number) + (max ? (h[node] as number) : 0) };
      }
      portPoint.set(`${port.draft}:${port.end}`, point);
    });
  }
  drafts.forEach((d, di) => {
    const e = input.edges[d.edge] as LayoutEdgeInput;
    const points = [portPoint.get(`${di}:src`) as Point, ...d.waypoints, portPoint.get(`${di}:dst`) as Point];
    routes[d.edge] = {
      id: e.id,
      from: e.from,
      to: e.to,
      points,
      path: curvePath(points, LR),
      label: midpoint(points),
      selfLoop: false,
      reversed: d.reversed,
      vertical: false
    };
  });

  // ---- output ----
  const outNodes: LayoutNode[] = ids.map((id, i) => ({
    id,
    x: ax[i] as number,
    y: ay[i] as number,
    width: w[i] as number,
    height: h[i] as number,
    depth: depth[i] as number,
    parent: (parent[i] as number) === -1 ? null : (ids[parent[i] as number] as string),
    container: isContainer(i),
    children: (children[i] as number[]).map((c) => ids[c] as string)
  }));
  const outEdges = routes.filter((r): r is LayoutEdge => r !== null);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const n of outNodes) {
    grow(n.x, n.y);
    grow(n.x + n.width, n.y + n.height);
  }
  for (const e of outEdges) for (const p of e.points) grow(p.x, p.y);
  const bounds: Rect = outNodes.length === 0 ? { x: 0, y: 0, width: 0, height: 0 } : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

  return {
    direction: o.direction,
    nodes: outNodes,
    byId: new Map(outNodes.map((n) => [n.id, n])),
    edges: outEdges,
    bounds,
    skippedEdges: skipped,
    stats: { crossings: ctx.crossings, layers: ctx.layers, dummyNodes: ctx.dummyUsed, levels: levels.size }
  };
}

function stripUndefined(options: LayoutOptions): Partial<Resolved> {
  const out: Partial<Resolved> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Union of the boxes of the named nodes, or null when none of them is laid out. */
export function boundsOf(layout: Layout, ids: Iterable<string>): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const id of ids) {
    const n = layout.byId.get(id);
    if (!n) continue;
    any = true;
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }
  return any ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}
