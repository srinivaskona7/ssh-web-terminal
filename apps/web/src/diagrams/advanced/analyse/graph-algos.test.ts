import { describe, expect, it } from 'vitest';
import { makeEdge, makeGraph, makeNode } from '../../fixtures';
import { indexGraph } from '../../graph-index';
import type { DiagramGraph, EdgeKind } from '../../model';
import {
  CYCLE_EDGE_KINDS,
  DEPENDENCY_EDGE_KINDS,
  articulationPointsAndBridges,
  degrees,
  isDependencyEdge,
  reachable,
  shortestPath,
  stronglyConnectedComponents
} from './graph-algos';

function nodesNamed(...ids: string[]) {
  return ids.map((id) => makeNode(id));
}

function chain(length: number, kind: EdgeKind = 'depends-on'): DiagramGraph {
  const nodes = Array.from({ length }, (_, i) => makeNode(`n${i}`));
  const edges = Array.from({ length: Math.max(0, length - 1) }, (_, i) => makeEdge(`n${i}`, `n${i + 1}`, kind));
  return makeGraph(nodes, edges);
}

function ring(length: number): DiagramGraph {
  const g = chain(length);
  g.edges.push(makeEdge(`n${length - 1}`, 'n0'));
  return g;
}

function star(leaves: number): DiagramGraph {
  const nodes = [makeNode('hub'), ...Array.from({ length: leaves }, (_, i) => makeNode(`leaf${i}`))];
  const edges = Array.from({ length: leaves }, (_, i) => makeEdge(`leaf${i}`, 'hub', 'connects'));
  return makeGraph(nodes, edges);
}

const BIG = 5000;

describe('edge kind sets', () => {
  it('treats the kinds that mean "needs" as dependencies and ownership and ordering as not', () => {
    for (const kind of ['selects', 'routes', 'mounts', 'uses-config', 'depends-on', 'connects', 'attached', 'runs', 'scheduled-on', 'listens', 'flow', 'custom'] as EdgeKind[]) {
      expect(DEPENDENCY_EDGE_KINDS.has(kind), kind).toBe(true);
    }
    expect(DEPENDENCY_EDGE_KINDS.has('owns')).toBe(false);
    expect(DEPENDENCY_EDGE_KINDS.has('orders-after')).toBe(false);
    expect(DEPENDENCY_EDGE_KINDS.has('hop')).toBe(false);
    expect(isDependencyEdge(makeEdge('a', 'b', 'mounts'))).toBe(true);
    expect(isDependencyEdge(makeEdge('a', 'b', 'owns'))).toBe(false);
  });

  it('lists the kinds that can form a dependency cycle', () => {
    expect([...CYCLE_EDGE_KINDS].sort()).toEqual(['custom', 'depends-on', 'flow', 'orders-after', 'owns']);
  });
});

describe('reachable', () => {
  const graph = makeGraph(nodesNamed('a', 'b', 'c', 'd', 'x', 'y'), [
    makeEdge('a', 'b'),
    makeEdge('b', 'c'),
    makeEdge('c', 'd'),
    makeEdge('x', 'y')
  ]);
  const index = indexGraph(graph);

  it('walks forward and reports hop distance, start at 0', () => {
    expect([...reachable(index, 'a', 'forward')]).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3]
    ]);
  });

  it('walks backward to the nodes that can reach the start', () => {
    expect(Object.fromEntries(reachable(index, 'd', 'backward'))).toEqual({ d: 0, c: 1, b: 2, a: 3 });
  });

  it('stops at the hop limit', () => {
    expect(Object.fromEntries(reachable(index, 'a', 'forward', { maxHops: 2 }))).toEqual({ a: 0, b: 1, c: 2 });
    expect(Object.fromEntries(reachable(index, 'a', 'forward', { maxHops: 0 }))).toEqual({ a: 0 });
  });

  it('never reaches a disconnected part', () => {
    const seen = reachable(index, 'a', 'forward');
    expect(seen.has('x')).toBe(false);
    expect(seen.has('y')).toBe(false);
  });

  it('terminates on cycles and self-loops', () => {
    const g = makeGraph(nodesNamed('a', 'b', 'c'), [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'a'), makeEdge('b', 'b')]);
    expect(Object.fromEntries(reachable(indexGraph(g), 'a', 'forward'))).toEqual({ a: 0, b: 1, c: 2 });
  });

  it('honours the edge filter', () => {
    const g = makeGraph(nodesNamed('a', 'b', 'c'), [makeEdge('a', 'b', 'owns'), makeEdge('b', 'c', 'depends-on')]);
    const ix = indexGraph(g);
    expect([...reachable(ix, 'a', 'forward', { edgeFilter: isDependencyEdge }).keys()]).toEqual(['a']);
    expect([...reachable(ix, 'a', 'forward').keys()]).toEqual(['a', 'b', 'c']);
  });

  it('accepts several starts, all at distance 0', () => {
    const seen = reachable(index, ['a', 'x'], 'forward');
    expect(seen.get('a')).toBe(0);
    expect(seen.get('x')).toBe(0);
    expect(seen.get('y')).toBe(1);
  });

  it('ignores a start that is not in the graph and works on an empty graph', () => {
    expect(reachable(index, 'ghost', 'forward').size).toBe(0);
    expect(reachable(indexGraph(makeGraph([])), 'a', 'backward').size).toBe(0);
  });

  it('walks a 5,000-node chain without recursion', () => {
    const big = indexGraph(chain(BIG));
    const started = performance.now();
    const fwd = reachable(big, 'n0', 'forward');
    const back = reachable(big, `n${BIG - 1}`, 'backward');
    expect(fwd.size).toBe(BIG);
    expect(fwd.get(`n${BIG - 1}`)).toBe(BIG - 1);
    expect(back.size).toBe(BIG);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('shortestPath', () => {
  const graph = makeGraph(nodesNamed('a', 'b', 'c', 'd', 'e', 'lonely'), [
    makeEdge('a', 'b', 'routes'),
    makeEdge('b', 'c', 'selects'),
    makeEdge('a', 'd', 'depends-on'),
    makeEdge('d', 'e', 'depends-on'),
    makeEdge('e', 'c', 'depends-on')
  ]);
  const index = indexGraph(graph);

  it('finds the fewest-hop directed path with its edges', () => {
    const path = shortestPath(index, 'a', 'c', { directed: true });
    expect(path?.nodes).toEqual(['a', 'b', 'c']);
    expect(path?.steps.map((s) => [s.from, s.to, s.edge.kind, s.reversed])).toEqual([
      ['a', 'b', 'routes', false],
      ['b', 'c', 'selects', false]
    ]);
  });

  it('finds nothing against the edge direction when directed, but walks it when undirected', () => {
    expect(shortestPath(index, 'c', 'a', { directed: true })).toBeNull();
    const back = shortestPath(index, 'c', 'a', { directed: false });
    expect(back?.nodes).toEqual(['c', 'b', 'a']);
    expect(back?.steps.every((s) => s.reversed)).toBe(true);
    expect(back?.steps[0]?.edge.kind).toBe('selects');
  });

  it('returns a zero-hop path from a node to itself', () => {
    expect(shortestPath(index, 'a', 'a', { directed: true })).toEqual({ nodes: ['a'], steps: [] });
  });

  it('returns null for a disconnected pair and for unknown nodes', () => {
    expect(shortestPath(index, 'a', 'lonely', { directed: false })).toBeNull();
    expect(shortestPath(index, 'a', 'ghost', { directed: false })).toBeNull();
    expect(shortestPath(index, 'ghost', 'a', { directed: true })).toBeNull();
  });

  it('honours the edge filter', () => {
    const onlyDepends = shortestPath(index, 'a', 'c', { directed: true, edgeFilter: (e) => e.kind === 'depends-on' });
    expect(onlyDepends?.nodes).toEqual(['a', 'd', 'e', 'c']);
  });

  it('copes with cycles and self-loops on the way', () => {
    const g = makeGraph(nodesNamed('a', 'b', 'c'), [makeEdge('a', 'a'), makeEdge('a', 'b'), makeEdge('b', 'a'), makeEdge('b', 'c')]);
    expect(shortestPath(indexGraph(g), 'a', 'c', { directed: true })?.nodes).toEqual(['a', 'b', 'c']);
  });

  it('finds the end of a 5,000-node chain', () => {
    const big = indexGraph(chain(BIG));
    const started = performance.now();
    const path = shortestPath(big, 'n0', `n${BIG - 1}`, { directed: true });
    expect(path?.nodes.length).toBe(BIG);
    expect(path?.steps.length).toBe(BIG - 1);
    expect(shortestPath(big, `n${BIG - 1}`, 'n0', { directed: true })).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('articulationPointsAndBridges', () => {
  it('flags the middle of a path and every link of it', () => {
    const g = chain(5);
    const result = articulationPointsAndBridges(indexGraph(g));
    expect(result.articulationPoints.map((p) => p.id).sort()).toEqual(['n1', 'n2', 'n3']);
    expect(result.bridges.length).toBe(4);
    const mid = result.articulationPoints.find((p) => p.id === 'n2');
    expect(mid).toEqual({ id: 'n2', pieces: 2, cutOff: 2 });
    const second = result.articulationPoints.find((p) => p.id === 'n1');
    expect(second).toEqual({ id: 'n1', pieces: 2, cutOff: 1 });
  });

  it('ranks by how many nodes a failure cuts off', () => {
    const result = articulationPointsAndBridges(indexGraph(chain(5)));
    expect(result.articulationPoints[0]?.id).toBe('n2');
  });

  it('finds nothing in a plain cycle', () => {
    const result = articulationPointsAndBridges(indexGraph(ring(6)));
    expect(result.articulationPoints).toEqual([]);
    expect(result.bridges).toEqual([]);
  });

  it('flags the shared vertex of two triangles but no bridge', () => {
    const g = makeGraph(nodesNamed('a', 'b', 'x', 'c', 'd'), [
      makeEdge('a', 'b'),
      makeEdge('b', 'x'),
      makeEdge('x', 'a'),
      makeEdge('x', 'c'),
      makeEdge('c', 'd'),
      makeEdge('d', 'x')
    ]);
    const result = articulationPointsAndBridges(indexGraph(g));
    expect(result.articulationPoints).toEqual([{ id: 'x', pieces: 2, cutOff: 2 }]);
    expect(result.bridges).toEqual([]);
  });

  it('does not call one of two parallel edges a bridge', () => {
    const g = makeGraph(nodesNamed('a', 'b'), [makeEdge('a', 'b', 'depends-on'), makeEdge('a', 'b', 'connects'), makeEdge('b', 'a', 'mounts')]);
    const result = articulationPointsAndBridges(indexGraph(g));
    expect(result.bridges).toEqual([]);
    expect(result.articulationPoints).toEqual([]);
  });

  it('calls a single edge between two nodes a bridge', () => {
    const g = makeGraph(nodesNamed('a', 'b'), [makeEdge('a', 'b')]);
    const result = articulationPointsAndBridges(indexGraph(g));
    expect(result.bridges.map((b) => b.edge.id)).toEqual(['depends-on:a->b']);
    expect(result.articulationPoints).toEqual([]);
  });

  it('ranks bridges by the smaller side they cut off', () => {
    const result = articulationPointsAndBridges(indexGraph(chain(5)));
    expect(result.bridges.map((b) => b.smallerSide)).toEqual([2, 2, 1, 1]);
  });

  it('ignores self-loops', () => {
    const g = makeGraph(nodesNamed('a', 'b'), [makeEdge('a', 'a'), makeEdge('a', 'b')]);
    const result = articulationPointsAndBridges(indexGraph(g));
    expect(result.bridges.map((b) => b.edge.id)).toEqual(['depends-on:a->b']);
  });

  it('ignores edge direction', () => {
    const g = makeGraph(nodesNamed('a', 'b', 'c'), [makeEdge('a', 'b'), makeEdge('c', 'b')]);
    const result = articulationPointsAndBridges(indexGraph(g));
    expect(result.articulationPoints).toEqual([{ id: 'b', pieces: 2, cutOff: 1 }]);
  });

  it('treats every connected part on its own and skips isolated nodes', () => {
    const g = makeGraph(nodesNamed('a', 'b', 'c', 'x', 'y', 'z', 'lonely'), [
      makeEdge('a', 'b'),
      makeEdge('b', 'c'),
      makeEdge('x', 'y'),
      makeEdge('y', 'z')
    ]);
    const result = articulationPointsAndBridges(indexGraph(g));
    expect(result.articulationPoints.map((p) => p.id).sort()).toEqual(['b', 'y']);
    expect(result.bridges.length).toBe(4);
  });

  it('honours the edge filter', () => {
    const g = makeGraph(nodesNamed('a', 'b', 'c'), [makeEdge('a', 'b', 'owns'), makeEdge('b', 'c', 'depends-on')]);
    const filtered = articulationPointsAndBridges(indexGraph(g), { edgeFilter: isDependencyEdge });
    expect(filtered.bridges.map((b) => b.edge.kind)).toEqual(['depends-on']);
    expect(filtered.articulationPoints).toEqual([]);
  });

  it('is empty for an empty graph', () => {
    expect(articulationPointsAndBridges(indexGraph(makeGraph([])))).toEqual({ articulationPoints: [], bridges: [] });
  });

  it('survives a 5,000-node chain and a 5,000-leaf star', () => {
    const started = performance.now();
    const c = articulationPointsAndBridges(indexGraph(chain(BIG)));
    expect(c.articulationPoints.length).toBe(BIG - 2);
    expect(c.bridges.length).toBe(BIG - 1);
    const s = articulationPointsAndBridges(indexGraph(star(BIG)));
    expect(s.articulationPoints).toEqual([{ id: 'hub', pieces: BIG, cutOff: BIG - 1 }]);
    expect(s.bridges.length).toBe(BIG);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('survives a 5,000-node ring', () => {
    const result = articulationPointsAndBridges(indexGraph(ring(BIG)));
    expect(result.articulationPoints).toEqual([]);
    expect(result.bridges).toEqual([]);
  });
});

describe('stronglyConnectedComponents', () => {
  const sorted = (groups: string[][]) => groups.map((g) => [...g].sort()).sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));

  it('groups a directed cycle', () => {
    const g = makeGraph(nodesNamed('a', 'b', 'c', 'd'), [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'a'), makeEdge('c', 'd')]);
    expect(sorted(stronglyConnectedComponents(indexGraph(g)))).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('gives every node of a DAG its own component', () => {
    const result = stronglyConnectedComponents(indexGraph(chain(4)));
    expect(result.length).toBe(4);
    expect(result.every((g) => g.length === 1)).toBe(true);
  });

  it('separates two cycles joined by a one-way edge', () => {
    const g = makeGraph(nodesNamed('a', 'b', 'c', 'd'), [makeEdge('a', 'b'), makeEdge('b', 'a'), makeEdge('b', 'c'), makeEdge('c', 'd'), makeEdge('d', 'c')]);
    expect(sorted(stronglyConnectedComponents(indexGraph(g)))).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('leaves a self-loop as a singleton component', () => {
    const g = makeGraph(nodesNamed('a'), [makeEdge('a', 'a')]);
    expect(stronglyConnectedComponents(indexGraph(g))).toEqual([['a']]);
  });

  it('keeps disconnected nodes as singletons', () => {
    const g = makeGraph(nodesNamed('a', 'b', 'c'), [makeEdge('a', 'b'), makeEdge('b', 'a')]);
    expect(sorted(stronglyConnectedComponents(indexGraph(g)))).toEqual([['a', 'b'], ['c']]);
  });

  it('honours the edge filter', () => {
    const g = makeGraph(nodesNamed('a', 'b'), [makeEdge('a', 'b', 'depends-on'), makeEdge('b', 'a', 'connects')]);
    const ix = indexGraph(g);
    expect(sorted(stronglyConnectedComponents(ix))).toEqual([['a', 'b']]);
    expect(stronglyConnectedComponents(ix, { edgeFilter: (e) => e.kind === 'depends-on' }).length).toBe(2);
  });

  it('is empty for an empty graph', () => {
    expect(stronglyConnectedComponents(indexGraph(makeGraph([])))).toEqual([]);
  });

  it('finds one component in a 5,000-node ring and 5,000 singletons in a chain', () => {
    const started = performance.now();
    const r = stronglyConnectedComponents(indexGraph(ring(BIG)));
    expect(r.length).toBe(1);
    expect(r[0]?.length).toBe(BIG);
    expect(stronglyConnectedComponents(indexGraph(chain(BIG))).length).toBe(BIG);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('degrees', () => {
  it('counts distinct neighbours per direction and skips self-loops', () => {
    const g = makeGraph(nodesNamed('a', 'b', 'c', 'lonely'), [
      makeEdge('a', 'b', 'depends-on'),
      makeEdge('a', 'b', 'connects'),
      makeEdge('c', 'b'),
      makeEdge('b', 'b'),
      makeEdge('b', 'c', 'mounts')
    ]);
    const d = degrees(indexGraph(g));
    expect(d.get('b')).toEqual({ in: 2, out: 1, total: 3 });
    expect(d.get('a')).toEqual({ in: 0, out: 1, total: 1 });
    expect(d.get('lonely')).toEqual({ in: 0, out: 0, total: 0 });
  });

  it('honours the edge filter', () => {
    const g = makeGraph(nodesNamed('a', 'b'), [makeEdge('a', 'b', 'owns')]);
    expect(degrees(indexGraph(g), { edgeFilter: isDependencyEdge }).get('b')).toEqual({ in: 0, out: 0, total: 0 });
  });

  it('is empty for an empty graph and fast for a 5,000-leaf star', () => {
    expect(degrees(indexGraph(makeGraph([]))).size).toBe(0);
    const started = performance.now();
    const d = degrees(indexGraph(star(BIG)));
    expect(d.get('hub')).toEqual({ in: BIG, out: 0, total: BIG });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
