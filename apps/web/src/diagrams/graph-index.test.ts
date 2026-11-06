import { describe, expect, it } from 'vitest';
import { makeEdge, makeGraph, makeNode } from './fixtures';
import { ancestors, descendants, indexGraph, neighbours } from './graph-index';

describe('graph index', () => {
  const graph = makeGraph(
    [
      makeNode('ns'),
      makeNode('dep', { parent: 'ns' }),
      makeNode('pod', { parent: 'dep' }),
      makeNode('svc', { parent: 'ns' }),
      makeNode('lonely')
    ],
    [makeEdge('svc', 'pod', 'selects'), makeEdge('dep', 'pod', 'owns')]
  );
  const index = indexGraph(graph);

  it('maps edges in both directions', () => {
    expect(index.out.get('svc')?.map((e) => e.to)).toEqual(['pod']);
    expect(index.in.get('pod')?.map((e) => e.from).sort()).toEqual(['dep', 'svc']);
    expect(index.out.get('lonely')).toBeUndefined();
  });

  it('lists descendants nearest first and ancestors nearest first', () => {
    expect(descendants(index, 'ns')).toEqual(['dep', 'svc', 'pod']);
    expect(ancestors(index, 'pod')).toEqual(['dep', 'ns']);
    expect(ancestors(index, 'ns')).toEqual([]);
  });

  it('survives a containment cycle', () => {
    const cyclic = indexGraph(makeGraph([makeNode('a', { parent: 'b' }), makeNode('b', { parent: 'a' })]));
    expect(descendants(cyclic, 'a')).toEqual(['b']);
    expect(ancestors(cyclic, 'a')).toEqual(['b']);
  });

  it('ignores edges to nodes the graph does not contain', () => {
    const dangling = indexGraph(makeGraph([makeNode('a')], [makeEdge('a', 'ghost')]));
    expect(dangling.out.get('a')).toBeUndefined();
  });

  it('returns neighbours across both edge directions', () => {
    expect(neighbours(index, 'pod').map((n) => n.id).sort()).toEqual(['dep', 'svc']);
  });

  it('does not treat a self-parent as a child', () => {
    const selfish = indexGraph(makeGraph([makeNode('a', { parent: 'a' })]));
    expect(selfish.children.size).toBe(0);
  });
});
