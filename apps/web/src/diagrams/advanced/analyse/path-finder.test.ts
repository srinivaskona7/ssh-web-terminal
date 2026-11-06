import { describe, expect, it } from 'vitest';
import { makeEdge, makeGraph, makeNode } from '../../fixtures';
import { findPaths, pathHighlight, searchNodes } from './path-finder';
import { buildEstate } from './test-estate';

const estate = buildEstate();
const abc = () => makeGraph([makeNode('a'), makeNode('b'), makeNode('c')], [makeEdge('a', 'b', 'routes'), makeEdge('b', 'c', 'mounts')]);

describe('findPaths', () => {
  it('finds the forward route with edge kinds and says the other way has none', () => {
    const report = findPaths(abc(), 'a', 'c');
    expect(report?.forward?.nodes).toEqual(['a', 'b', 'c']);
    expect(report?.forward?.hops.map((h) => [h.from, h.to, h.edgeKind, h.reversed])).toEqual([
      ['a', 'b', 'routes', false],
      ['b', 'c', 'mounts', false]
    ]);
    expect(report?.backward).toBeNull();
    expect(report?.summary).toMatch(/a reaches c in 2 hops/);
    expect(report?.summary).toMatch(/c does not reach a/);
  });

  it('falls back to ignoring direction and labels it', () => {
    const report = findPaths(abc(), 'c', 'a');
    expect(report?.forward).toBeNull();
    expect(report?.backward?.nodes).toEqual(['a', 'b', 'c']);
    const sideways = findPaths(makeGraph([makeNode('x'), makeNode('y'), makeNode('z')], [makeEdge('x', 'y'), makeEdge('z', 'y')]), 'x', 'z');
    expect(sideways?.forward).toBeNull();
    expect(sideways?.backward).toBeNull();
    expect(sideways?.undirected?.nodes).toEqual(['x', 'y', 'z']);
    expect(sideways?.undirected?.hops.map((h) => h.reversed)).toEqual([false, true]);
    expect(sideways?.summary).toMatch(/ignoring direction/i);
  });

  it('states plainly when there is no path at all', () => {
    const report = findPaths(makeGraph([makeNode('a'), makeNode('b')]), 'a', 'b');
    expect(report?.forward).toBeNull();
    expect(report?.undirected).toBeNull();
    expect(report?.summary).toMatch(/no path/i);
  });

  it('finds routes in both directions in a cycle', () => {
    const g = makeGraph([makeNode('a'), makeNode('b')], [makeEdge('a', 'b'), makeEdge('b', 'a')]);
    const report = findPaths(g, 'a', 'b');
    expect(report?.forward?.nodes).toEqual(['a', 'b']);
    expect(report?.backward?.nodes).toEqual(['b', 'a']);
    expect(report?.summary).toMatch(/both directions/i);
  });

  it('handles the same node twice, unknown ids and an empty graph', () => {
    expect(findPaths(abc(), 'a', 'a')?.summary).toMatch(/same node/i);
    expect(findPaths(abc(), 'a', 'ghost')).toBeNull();
    expect(findPaths(makeGraph([]), 'a', 'b')).toBeNull();
  });

  it('walks the estate from a browser to the host and from an ingress to a node', () => {
    expect(findPaths(estate, 'ssh:browser', 'host:prod-1')?.forward?.nodes).toEqual(['ssh:browser', 'ssh:relay', 'host:prod-1']);
    const route = findPaths(estate, 'k8s:ingress:shop/web', 'k8s:node:worker-1')?.forward;
    expect(route?.hops.map((h) => h.edgeKind)).toEqual(['routes', 'selects', 'scheduled-on']);
  });
});

describe('pathHighlight', () => {
  it('marks the ends primary, the middle secondary and fits the view', () => {
    const highlight = pathHighlight(findPaths(abc(), 'a', 'c')!);
    expect(highlight.id).toBe('path-finder');
    expect(highlight.fit).toBe(true);
    expect(highlight.nodes).toEqual({ a: 'primary', b: 'secondary', c: 'primary' });
    expect(highlight.edges).toEqual({ 'routes:a->b': 'secondary', 'mounts:b->c': 'secondary' });
    expect(highlight.dimOthers).toBe(true);
  });

  it('keeps just the two ends when there is no path', () => {
    const highlight = pathHighlight(findPaths(makeGraph([makeNode('a'), makeNode('b')]), 'a', 'b')!);
    expect(highlight.nodes).toEqual({ a: 'primary', b: 'primary' });
    expect(highlight.detail).toMatch(/no path/i);
  });

  it('draws both routes when each direction has one', () => {
    const g = makeGraph([makeNode('a'), makeNode('m'), makeNode('b')], [makeEdge('a', 'b'), makeEdge('b', 'm'), makeEdge('m', 'a')]);
    const highlight = pathHighlight(findPaths(g, 'a', 'b')!);
    expect(Object.keys(highlight.nodes).sort()).toEqual(['a', 'b', 'm']);
  });
});

describe('searchNodes', () => {
  it('matches label, id and kind label, case-insensitively, best first', () => {
    expect(searchNodes(estate, 'WORKER', 10).map((n) => n.id)).toEqual(['k8s:node:worker-1']);
    expect(searchNodes(estate, 'redis', 10).map((n) => n.id)).toContain('docker:image:redis:7');
    expect(searchNodes(estate, 'ingress', 10).length).toBe(3);
  });

  it('returns the first nodes for an empty query, respects the limit and survives odd input', () => {
    expect(searchNodes(estate, '', 5).length).toBe(5);
    expect(searchNodes(estate, '   ', 3).length).toBe(3);
    expect(searchNodes(estate, 'zzz-nothing', 5)).toEqual([]);
    expect(searchNodes(makeGraph([]), 'a', 5)).toEqual([]);
    expect(searchNodes(estate, '(((', 5)).toEqual([]);
  });

  it('puts label prefix matches before other matches', () => {
    const g = makeGraph([makeNode('x1', { label: 'my-web' }), makeNode('x2', { label: 'web' }), makeNode('x3', { label: 'webby' })]);
    expect(searchNodes(g, 'web', 10).map((n) => n.id)).toEqual(['x2', 'x3', 'x1']);
  });
});
