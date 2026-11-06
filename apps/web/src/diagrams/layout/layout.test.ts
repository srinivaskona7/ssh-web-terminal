import { describe, expect, it } from 'vitest';
import { boundsOf, layoutGraph, type Layout, type LayoutEdgeInput, type LayoutNodeInput } from './layout.js';

const node = (id: string, parent?: string, extra: Partial<LayoutNodeInput> = {}): LayoutNodeInput => ({ id, parent, ...extra });
const edge = (from: string, to: string, id = `${from}->${to}`): LayoutEdgeInput => ({ id, from, to });

function overlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function expectNoSiblingOverlap(layout: Layout): void {
  const groups = new Map<string | null, typeof layout.nodes>();
  for (const n of layout.nodes) groups.set(n.parent, [...(groups.get(n.parent) ?? []), n]);
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        expect(overlap(list[i]!, list[j]!), `${list[i]!.id} overlaps ${list[j]!.id}`).toBe(false);
      }
    }
  }
}

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('layoutGraph', () => {
  it('lays out nothing and one node', () => {
    const empty = layoutGraph({ nodes: [], edges: [] });
    expect(empty.nodes).toEqual([]);
    expect(empty.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    const one = layoutGraph({ nodes: [node('a')], edges: [] });
    expect(one.nodes).toHaveLength(1);
    expect(one.bounds.width).toBeGreaterThan(0);
  });

  it('puts a chain on increasing x for LR and increasing y for TB', () => {
    const input = { nodes: [node('a'), node('b'), node('c')], edges: [edge('a', 'b'), edge('b', 'c')] };
    const lr = layoutGraph(input, { direction: 'LR' });
    const a = lr.byId.get('a')!;
    const b = lr.byId.get('b')!;
    const c = lr.byId.get('c')!;
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(lr.direction).toBe('LR');
    const tb = layoutGraph(input, { direction: 'TB' });
    expect(tb.byId.get('a')!.y).toBeLessThan(tb.byId.get('b')!.y);
    expect(tb.byId.get('b')!.y).toBeLessThan(tb.byId.get('c')!.y);
  });

  it('is deterministic', () => {
    const rnd = seeded(7);
    const nodes = Array.from({ length: 40 }, (_, i) => node(`n${i}`));
    const edges = Array.from({ length: 70 }, (_, i) => edge(`n${Math.floor(rnd() * 40)}`, `n${Math.floor(rnd() * 40)}`, `e${i}`));
    const a = layoutGraph({ nodes, edges });
    const b = layoutGraph({ nodes, edges });
    expect(JSON.stringify([a.nodes, a.edges, a.bounds])).toBe(JSON.stringify([b.nodes, b.edges, b.bounds]));
  });

  it('nests children inside their container and keeps siblings apart', () => {
    const layout = layoutGraph({
      nodes: [node('ns'), node('p1', 'ns'), node('p2', 'ns'), node('p3', 'ns'), node('svc')],
      edges: [edge('svc', 'p1'), edge('svc', 'p2')]
    });
    const ns = layout.byId.get('ns')!;
    expect(ns.container).toBe(true);
    expect(ns.children).toEqual(['p1', 'p2', 'p3']);
    for (const id of ['p1', 'p2', 'p3']) {
      const c = layout.byId.get(id)!;
      expect(c.x).toBeGreaterThanOrEqual(ns.x);
      expect(c.y).toBeGreaterThanOrEqual(ns.y);
      expect(c.x + c.width).toBeLessThanOrEqual(ns.x + ns.width);
      expect(c.y + c.height).toBeLessThanOrEqual(ns.y + ns.height);
      expect(c.depth).toBe(1);
    }
    expectNoSiblingOverlap(layout);
  });

  it('honours a container minimum width', () => {
    const layout = layoutGraph({ nodes: [node('ns', undefined, { width: 600 }), node('p', 'ns')], edges: [] });
    expect(layout.byId.get('ns')!.width).toBeGreaterThanOrEqual(600);
  });

  it('lifts cross-container edges to the containers and routes container edges as vertical', () => {
    const layout = layoutGraph({
      nodes: [node('a'), node('a1', 'a'), node('b'), node('b1', 'b')],
      edges: [edge('a1', 'b1', 'cross'), edge('a', 'a1', 'down')]
    });
    expect(layout.byId.get('a')!.x).toBeLessThan(layout.byId.get('b')!.x);
    expect(layout.edges.find((e) => e.id === 'cross')!.vertical).toBe(false);
    expect(layout.edges.find((e) => e.id === 'down')!.vertical).toBe(true);
    expect(layout.stats.levels).toBeGreaterThanOrEqual(3);
    // vertical edge in either direction
    const up = layoutGraph({ nodes: [node('a'), node('a1', 'a')], edges: [edge('a1', 'a')] });
    expect(up.edges[0]!.vertical).toBe(true);
  });

  it('reverses exactly one edge of a two-cycle and keeps both drawn', () => {
    const layout = layoutGraph({ nodes: [node('a'), node('b')], edges: [edge('a', 'b'), edge('b', 'a')] });
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges.filter((e) => e.reversed)).toHaveLength(1);
    expect(layout.byId.get('a')!.x).not.toBe(layout.byId.get('b')!.x);
  });

  it('breaks a longer cycle', () => {
    const layout = layoutGraph({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
    });
    expect(layout.edges.filter((e) => e.reversed)).toHaveLength(1);
  });

  it('draws a self-loop as a loop on the right of the node', () => {
    const layout = layoutGraph({ nodes: [node('a')], edges: [edge('a', 'a')] });
    const e = layout.edges[0]!;
    expect(e.selfLoop).toBe(true);
    const a = layout.byId.get('a')!;
    expect(e.points[0]!.x).toBe(a.x + a.width);
    expect(layout.bounds.x + layout.bounds.width).toBeGreaterThan(a.x + a.width);
  });

  it('keeps duplicate and parallel edges apart', () => {
    const layout = layoutGraph({ nodes: [node('a'), node('b')], edges: [edge('a', 'b', 'e1'), edge('a', 'b', 'e2'), edge('b', 'a', 'e3')] });
    expect(layout.edges).toHaveLength(3);
    const paths = new Set(layout.edges.map((e) => e.path));
    expect(paths.size).toBe(3);
  });

  it('survives dangling parents, parent cycles and duplicate ids', () => {
    const layout = layoutGraph({
      nodes: [node('a', 'missing'), node('x', 'y'), node('y', 'x'), node('a'), node('self', 'self')],
      edges: [edge('a', 'x'), edge('x', 'y'), edge('ghost', 'a', 'dangling')]
    });
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['a', 'self', 'x', 'y']);
    expect(layout.skippedEdges).toEqual(['dangling']);
    expect(layout.edges.map((e) => e.id).sort()).toEqual(['a->x', 'x->y']);
    expect(Number.isFinite(layout.bounds.width)).toBe(true);
  });

  it('packs disconnected components into rows instead of one strip', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => node(`n${i}`));
    const layout = layoutGraph({ nodes, edges: [] });
    expect(layout.bounds.width / layout.bounds.height).toBeLessThan(6);
    expectNoSiblingOverlap(layout);
    const ys = new Set(layout.nodes.map((n) => n.y));
    expect(ys.size).toBeGreaterThan(1);
  });

  it('reduces crossings on a graph with an obvious uncrossed order', () => {
    const nodes = [...'abcdefgh'].map((id) => node(id));
    const left = ['a', 'b', 'c', 'd'];
    const right = ['e', 'f', 'g', 'h'];
    // a-h, b-g, c-f, d-e would cross fully if left in listing order
    const edges = left.map((l, i) => edge(l, right[3 - i]!));
    const layout = layoutGraph({ nodes, edges });
    expect(layout.stats.crossings).toBe(0);
  });

  it('routes long edges through dummy points and reports the stats', () => {
    const layout = layoutGraph({
      nodes: [node('a'), node('b'), node('c'), node('d')],
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('a', 'd', 'long')]
    });
    const long = layout.edges.find((e) => e.id === 'long')!;
    expect(long.points.length).toBeGreaterThan(2);
    expect(long.path.startsWith('M')).toBe(true);
    expect(layout.stats.dummyNodes).toBe(2);
    expect(layout.stats.layers).toBe(4);
  });

  it('gives TB edges tangents along y and falls back to direct routes past the dummy cap', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('a', 'd', 'long')];
    const nodes = ['a', 'b', 'c', 'd'].map((id) => node(id));
    const tb = layoutGraph({ nodes, edges }, { direction: 'TB' });
    expect(tb.edges.find((e) => e.id === 'long')!.points.length).toBeGreaterThan(2);
    const capped = layoutGraph({ nodes, edges }, { maxDummyNodes: 0 });
    expect(capped.edges.find((e) => e.id === 'long')!.points).toHaveLength(2);
    expect(capped.stats.dummyNodes).toBe(0);
  });

  it('keeps every node and edge point inside the bounds', () => {
    const layout = layoutGraph({
      nodes: [node('a'), node('b'), node('c', 'a'), node('d', 'a')],
      edges: [edge('c', 'd'), edge('d', 'b'), edge('b', 'b')]
    });
    const { x, y, width, height } = layout.bounds;
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(x);
      expect(n.x + n.width).toBeLessThanOrEqual(x + width + 1e-6);
      expect(n.y + n.height).toBeLessThanOrEqual(y + height + 1e-6);
    }
    for (const e of layout.edges) for (const p of e.points) expect(p.x).toBeLessThanOrEqual(x + width + 1e-6);
  });

  it('lays out 2,000 nodes in under 3 seconds', () => {
    const rnd = seeded(42);
    const count = 2000;
    const nodes = Array.from({ length: count }, (_, i) => node(`n${i}`, i >= 40 && i % 5 === 0 ? `n${i % 40}` : undefined));
    const edges: LayoutEdgeInput[] = [];
    for (let i = 1; i < count; i += 1) {
      edges.push(edge(`n${Math.floor(rnd() * i)}`, `n${i}`, `e${i}`));
      if (i % 3 === 0) edges.push(edge(`n${Math.floor(rnd() * count)}`, `n${i}`, `x${i}`));
    }
    const start = performance.now();
    const layout = layoutGraph({ nodes, edges });
    const elapsed = performance.now() - start;
    expect(layout.nodes).toHaveLength(count);
    expect(elapsed).toBeLessThan(3000);
  });

  it('does not overflow the stack on a 3,000-deep chain', () => {
    const nodes = Array.from({ length: 3000 }, (_, i) => node(`n${i}`));
    const edges = nodes.slice(1).map((n, i) => edge(`n${i}`, n.id));
    expect(() => layoutGraph({ nodes, edges })).not.toThrow();
  });

  it('boundsOf unions known nodes and ignores unknown ones', () => {
    const layout = layoutGraph({ nodes: [node('a'), node('b')], edges: [edge('a', 'b')] });
    expect(boundsOf(layout, ['zzz'])).toBeNull();
    const both = boundsOf(layout, ['a', 'b', 'zzz'])!;
    expect(both.width).toBeGreaterThan(layout.byId.get('a')!.width);
  });
});
