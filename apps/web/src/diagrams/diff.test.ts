import { describe, expect, it } from 'vitest';
import { diffGraphs, diffToHighlight, isEmptyDiff, mergeForDiff } from './diff';
import { makeEdge, makeGraph, makeNode } from './fixtures';

describe('graph diff', () => {
  const before = makeGraph(
    [
      makeNode('web', { status: 'healthy', fields: { replicas: 3 }, tags: { app: 'web' } }),
      makeNode('db', { status: 'healthy' }),
      makeNode('old-job')
    ],
    [makeEdge('web', 'db', 'connects'), makeEdge('web', 'old-job', 'depends-on')]
  );

  it('reports no change between identical graphs', () => {
    const diff = diffGraphs(before, before);
    expect(isEmptyDiff(diff)).toBe(true);
    expect(diff.unchangedNodes).toBe(3);
  });

  it('finds added, removed and changed nodes and edges', () => {
    const after = makeGraph(
      [
        makeNode('web', { status: 'warning', fields: { replicas: 2 }, tags: { app: 'web', tier: 'front' } }),
        makeNode('db', { status: 'healthy' }),
        makeNode('cache')
      ],
      [makeEdge('web', 'db', 'connects'), makeEdge('web', 'cache', 'connects')]
    );
    const diff = diffGraphs(before, after);
    expect(diff.addedNodes.map((n) => n.id)).toEqual(['cache']);
    expect(diff.removedNodes.map((n) => n.id)).toEqual(['old-job']);
    expect(diff.changedNodes.map((n) => n.id)).toEqual(['web']);
    expect(diff.changedNodes[0]?.changes).toEqual([
      { field: 'status', before: 'healthy', after: 'warning' },
      { field: 'tag:tier', before: undefined, after: 'front' },
      { field: 'field:replicas', before: 3, after: 2 }
    ]);
    expect(diff.addedEdges.map((e) => e.id)).toEqual(['connects:web->cache']);
    expect(diff.removedEdges.map((e) => e.id)).toEqual(['depends-on:web->old-job']);
    expect(diff.unchangedNodes).toBe(1);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it('treats a field that became null as a change, not as missing', () => {
    const a = makeGraph([makeNode('x', { fields: { cpu: 1 } })]);
    const b = makeGraph([makeNode('x', { fields: { cpu: null } })]);
    expect(diffGraphs(a, b).changedNodes[0]?.changes).toEqual([{ field: 'field:cpu', before: 1, after: null }]);
  });

  it('draws removed nodes by merging both sides, with the after copy winning', () => {
    const after = makeGraph([makeNode('web', { status: 'failed' })], [], { title: 'now' });
    const diff = diffGraphs(before, after);
    const merged = mergeForDiff(before, after, diff);
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(['db', 'old-job', 'web']);
    expect(merged.nodes.find((n) => n.id === 'web')?.status).toBe('failed');
    expect(merged.edges.map((e) => e.id).sort()).toEqual(['connects:web->db', 'depends-on:web->old-job']);
  });

  it('turns a diff into a highlight with a role per node and edge', () => {
    const after = makeGraph([makeNode('web', { status: 'failed' }), makeNode('cache')], [makeEdge('web', 'cache', 'connects')]);
    const highlight = diffToHighlight(diffGraphs(before, after), 'vs baseline');
    expect(highlight.nodes).toEqual({ cache: 'added', db: 'removed', 'old-job': 'removed', web: 'changed' });
    expect(highlight.edges['connects:web->cache']).toBe('added');
    expect(highlight.edges['connects:web->db']).toBe('removed');
    expect(highlight.detail).toBe('1 added, 2 removed, 1 changed; 1 edges added, 2 removed.');
    expect(highlight.dimOthers).toBe(true);
  });
});
