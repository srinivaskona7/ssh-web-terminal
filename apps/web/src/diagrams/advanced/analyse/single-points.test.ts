import { describe, expect, it } from 'vitest';
import { makeEdge, makeGraph, makeNode } from '../../fixtures';
import { findSinglePoints, singlePointsHighlight } from './single-points';
import { buildEstate } from './test-estate';

const estate = buildEstate();
const chain = () => makeGraph([makeNode('a'), makeNode('b'), makeNode('c')], [makeEdge('a', 'b'), makeEdge('b', 'c')]);

describe('findSinglePoints', () => {
  it('flags the middle of a chain as a cut node and both links as bridges, each with a reason', () => {
    const result = findSinglePoints(chain());
    const cut = result.findings.filter((f) => f.kind === 'cut-node');
    expect(cut.map((f) => f.nodeIds)).toEqual([['b']]);
    expect(cut[0]?.why).toMatch(/removing b/i);
    const bridges = result.findings.filter((f) => f.kind === 'bridge');
    expect(bridges.map((f) => f.edgeIds[0]).sort()).toEqual(['depends-on:a->b', 'depends-on:b->c']);
    expect(bridges[0]?.why).toMatch(/only link/i);
    expect(result.nodeIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('finds nothing in a ring, a pair of parallel edges or an empty graph', () => {
    const ring = makeGraph([makeNode('a'), makeNode('b'), makeNode('c')], [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'a')]);
    expect(findSinglePoints(ring).findings).toEqual([]);
    const parallel = makeGraph([makeNode('a'), makeNode('b')], [makeEdge('a', 'b', 'routes'), makeEdge('a', 'b', 'connects')]);
    expect(findSinglePoints(parallel).findings).toEqual([]);
    expect(findSinglePoints(makeGraph([])).findings).toEqual([]);
  });

  it('ignores ownership and start order when judging connectivity', () => {
    const g = makeGraph([makeNode('a'), makeNode('b'), makeNode('c')], [makeEdge('a', 'b', 'owns'), makeEdge('b', 'c', 'orders-after')]);
    expect(findSinglePoints(g).findings).toEqual([]);
  });

  it('flags a Deployment or StatefulSet with exactly one replica, not several, not unreported', () => {
    const workload = (id: string, kind: 'k8s-deployment' | 'k8s-statefulset', replicas: number | string | null) => makeNode(id, { kind, fields: { replicas } });
    const g = makeGraph([workload('one', 'k8s-deployment', 1), workload('three', 'k8s-deployment', 3), workload('none', 'k8s-statefulset', null), workload('text', 'k8s-statefulset', '1'), workload('zero', 'k8s-deployment', 0)]);
    const flagged = findSinglePoints(g).findings.filter((f) => f.kind === 'single-replica');
    expect(flagged.map((f) => f.nodeIds[0]).sort()).toEqual(['one', 'text']);
    expect(flagged[0]?.why).toMatch(/one replica/i);
  });

  it('does not flag replicas on other kinds', () => {
    const g = makeGraph([makeNode('pod', { kind: 'k8s-pod', fields: { replicas: 1 } })]);
    expect(findSinglePoints(g).findings).toEqual([]);
  });

  it('on the estate: names the database StatefulSet and the node that holds the database pod', () => {
    const result = findSinglePoints(estate);
    expect(result.findings.some((f) => f.kind === 'single-replica' && f.nodeIds[0] === 'k8s:statefulset:shop/db')).toBe(true);
    expect(result.findings.some((f) => f.kind === 'cut-node' && f.nodeIds[0] === 'k8s:node:worker-1')).toBe(true);
    expect(result.nodeIds.length).toBeGreaterThan(2);
    expect(new Set(result.nodeIds).size).toBe(result.nodeIds.length);
  });

  it('ranks the node that cuts off most first', () => {
    const g = makeGraph(
      ['h', 'x', 'l1', 'l2', 'l3', 'y'].map((id) => makeNode(id)),
      [makeEdge('x', 'h'), makeEdge('h', 'l1'), makeEdge('h', 'l2'), makeEdge('h', 'l3'), makeEdge('y', 'x')]
    );
    const cut = findSinglePoints(g).findings.filter((f) => f.kind === 'cut-node');
    expect(cut.map((f) => f.nodeIds[0])).toEqual(['h', 'x']);
  });

  it('handles 5,000 nodes', () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => makeNode(`n${i}`));
    const edges = Array.from({ length: 4999 }, (_, i) => makeEdge(`n${i}`, `n${i + 1}`));
    expect(findSinglePoints(makeGraph(nodes, edges)).findings.filter((f) => f.kind === 'cut-node').length).toBe(4998);
  });
});

describe('singlePointsHighlight', () => {
  it('marks cut nodes and single replicas danger, bridges and their ends secondary', () => {
    const highlight = singlePointsHighlight(findSinglePoints(chain()));
    expect(highlight?.id).toBe('single-points');
    expect(highlight?.nodes['b']).toBe('danger');
    expect(highlight?.nodes['a']).toBe('secondary');
    expect(highlight?.edges['depends-on:a->b']).toBe('danger');
    expect(highlight?.dimOthers).toBe(true);
  });

  it('is null when there is nothing to show', () => {
    expect(singlePointsHighlight(findSinglePoints(makeGraph([])))).toBeNull();
  });
});
