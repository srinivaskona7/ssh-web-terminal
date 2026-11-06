import { describe, expect, it } from 'vitest';
import { makeEdge, makeGraph, makeNode } from '../../fixtures';
import { cyclesHighlight, findCycles } from './cycles';
import { buildEstate } from './test-estate';

const estate = buildEstate();
const nodes = (...ids: string[]) => ids.map((id) => makeNode(id));

describe('findCycles', () => {
  it('finds a loop, lists its members by label and gives one concrete walk around it', () => {
    const g = makeGraph(nodes('a', 'b', 'c', 'd'), [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'a'), makeEdge('c', 'd')]);
    const [cycle, ...rest] = findCycles(g).cycles;
    expect(rest).toEqual([]);
    expect(cycle?.nodeIds).toEqual(['a', 'b', 'c']);
    expect(cycle?.loop).toEqual(['a', 'b', 'c']);
    expect(cycle?.edgeIds.sort()).toEqual(['depends-on:a->b', 'depends-on:b->c', 'depends-on:c->a']);
    expect(cycle?.selfLoop).toBe(false);
  });

  it('reports a self-loop on its own', () => {
    const [cycle] = findCycles(makeGraph(nodes('a', 'b'), [makeEdge('a', 'a'), makeEdge('a', 'b')])).cycles;
    expect(cycle?.selfLoop).toBe(true);
    expect(cycle?.nodeIds).toEqual(['a']);
    expect(cycle?.loop).toEqual(['a']);
    expect(cycle?.edgeIds).toEqual(['depends-on:a->a']);
  });

  it('keeps separate loops separate, biggest first', () => {
    const g = makeGraph(nodes('a', 'b', 'x', 'y', 'z'), [makeEdge('a', 'b'), makeEdge('b', 'a'), makeEdge('x', 'y'), makeEdge('y', 'z'), makeEdge('z', 'x')]);
    expect(findCycles(g).cycles.map((c) => c.nodeIds.length)).toEqual([3, 2]);
  });

  it('follows only depends-on, orders-after, owns, flow and custom', () => {
    const g = makeGraph(nodes('a', 'b'), [makeEdge('a', 'b', 'routes'), makeEdge('b', 'a', 'selects')]);
    expect(findCycles(g).cycles).toEqual([]);
    const mixed = makeGraph(nodes('a', 'b'), [makeEdge('a', 'b', 'orders-after'), makeEdge('b', 'a', 'owns')]);
    expect(findCycles(mixed).cycles.length).toBe(1);
    expect(findCycles(mixed).cycles[0]?.edgeKinds.sort()).toEqual(['orders-after', 'owns']);
  });

  it('does not call a chain or a diamond a cycle, and survives an empty graph', () => {
    const diamond = makeGraph(nodes('a', 'b', 'c', 'd'), [makeEdge('a', 'b'), makeEdge('a', 'c'), makeEdge('b', 'd'), makeEdge('c', 'd')]);
    expect(findCycles(diamond).cycles).toEqual([]);
    expect(findCycles(makeGraph([])).cycles).toEqual([]);
  });

  it('finds the sync-a / sync-b loop in the estate and nothing else', () => {
    const { cycles } = findCycles(estate);
    expect(cycles.length).toBe(1);
    expect(cycles[0]?.nodeIds).toEqual(['systemd:unit:sync-a.service', 'systemd:unit:sync-b.service']);
  });

  it('handles a 5,000-node ring', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `n${i}`);
    const edges = ids.map((id, i) => makeEdge(id, ids[(i + 1) % ids.length] ?? id));
    const [cycle] = findCycles(makeGraph(ids.map((id) => makeNode(id)), edges)).cycles;
    expect(cycle?.nodeIds.length).toBe(5000);
    expect(cycle?.loop.length).toBe(5000);
  });
});

describe('cyclesHighlight', () => {
  it('marks members and loop edges danger', () => {
    const result = findCycles(estate);
    const highlight = cyclesHighlight(result.cycles[0]!);
    expect(highlight.id).toBe('cycles');
    expect(highlight.nodes['systemd:unit:sync-a.service']).toBe('danger');
    expect(highlight.edges['depends-on:systemd:unit:sync-a.service->systemd:unit:sync-b.service']).toBe('danger');
    expect(highlight.dimOthers).toBe(true);
  });
});
