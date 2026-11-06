import { describe, expect, it } from 'vitest';
import { makeEdge, makeGraph, makeNode } from '../../fixtures';
import { BLAST_ASSUMPTIONS, MAX_HOPS, blastHighlight, blastRadius, clampHops } from './blast-radius';
import { buildEstate } from './test-estate';

const estate = buildEstate();
const ids = (result: ReturnType<typeof blastRadius>) => result?.nodes.map((n) => n.id).sort() ?? [];

describe('clampHops', () => {
  it('keeps 1 to 5 and falls back for rubbish', () => {
    expect(MAX_HOPS).toBe(5);
    expect(clampHops(3)).toBe(3);
    expect(clampHops(0)).toBe(1);
    expect(clampHops(-4)).toBe(1);
    expect(clampHops(99)).toBe(5);
    expect(clampHops(2.7)).toBe(2);
    expect(clampHops(Number.NaN)).toBe(3);
    expect(clampHops(Number.POSITIVE_INFINITY)).toBe(5);
  });
});

describe('blastRadius: what breaks', () => {
  it('walks from a node to everything that depends on it, through dependency edges only', () => {
    const result = blastRadius(estate, 'k8s:node:worker-1', { mode: 'breaks', hops: 5 });
    expect(result?.startId).toBe('k8s:node:worker-1');
    expect(ids(result)).toEqual(
      [
        'k8s:pod:shop/web-7c9f-a1b2c',
        'k8s:pod:shop/web-7c9f-b2c3d',
        'k8s:pod:shop/web-7c9f-c3d4e',
        'k8s:pod:shop/db-0',
        'k8s:service:shop/web',
        'k8s:service:shop/web-public',
        'k8s:service:shop/db',
        'k8s:ingress:shop/web',
        'k8s:ingress:shop/secure'
      ].sort()
    );
    // Owners are not dependants: the Deployment and ReplicaSet are not in the blast radius.
    expect(ids(result)).not.toContain('k8s:deployment:shop/web');
    expect(ids(result)).not.toContain('k8s:replicaset:shop/web-7c9f');
  });

  it('reports hop distance and groups by kind with counts', () => {
    const result = blastRadius(estate, 'k8s:node:worker-1', { mode: 'breaks', hops: 5 });
    expect(result?.nodes.find((n) => n.id === 'k8s:pod:shop/db-0')?.distance).toBe(1);
    expect(result?.nodes.find((n) => n.id === 'k8s:service:shop/db')?.distance).toBe(2);
    expect(result?.nodes.find((n) => n.id === 'k8s:ingress:shop/web')?.distance).toBe(3);
    expect(result?.groups.map((g) => [g.label, g.ids.length])).toEqual([
      ['Pod', 4],
      ['Service', 3],
      ['Ingress', 2]
    ]);
    // Nearest first.
    const distances = result?.nodes.map((n) => n.distance) ?? [];
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it('stops at the hop limit', () => {
    expect(ids(blastRadius(estate, 'k8s:node:worker-1', { mode: 'breaks', hops: 1 })).length).toBe(4);
    expect(ids(blastRadius(estate, 'k8s:node:worker-1', { mode: 'breaks', hops: 2 })).length).toBe(7);
  });

  it('does not follow owns, orders-after or hop edges', () => {
    // app.service depends on postgres (depends-on) and is ordered after nginx (orders-after) and owns proc:node.
    expect(ids(blastRadius(estate, 'systemd:unit:postgres.service', { mode: 'breaks', hops: 5 }))).toEqual(['systemd:unit:app.service']);
    expect(ids(blastRadius(estate, 'systemd:unit:nginx.service', { mode: 'breaks', hops: 5 }))).toEqual([]);
    expect(ids(blastRadius(estate, 'ssh:relay', { mode: 'breaks', hops: 5 }))).toEqual([]);
  });

  it('lists affected nodes that are already failed', () => {
    const result = blastRadius(estate, 'docker:image:busybox:1.0', { mode: 'breaks', hops: 3 });
    expect(ids(result)).toEqual(['docker:container:debug']);
    expect(result?.alreadyFailed).toEqual(['docker:container:debug']);
    expect(blastRadius(estate, 'k8s:node:worker-1', { mode: 'breaks', hops: 1 })?.alreadyFailed).toEqual(['k8s:pod:shop/web-7c9f-c3d4e']);
  });

  it('takes everything a failed host contains, plus what depends on that', () => {
    const result = blastRadius(estate, 'host:prod-1', { mode: 'breaks', hops: 5 });
    expect(result?.hostFailure).toBe(true);
    const affected = ids(result);
    expect(affected).toContain('systemd:unit:nginx.service');
    expect(affected).toContain('docker:container:cache');
    expect(affected).toContain('compose:project:store');
    expect(affected).toContain('sock:listen:tcp:0.0.0.0:22');
    // Contained nodes are one hop away; the peer that connects to a contained listener is two.
    expect(result?.nodes.find((n) => n.id === 'systemd:unit:nginx.service')?.distance).toBe(1);
    expect(result?.nodes.find((n) => n.id === 'peer:10.0.0.5')?.distance).toBe(2);
    // Kubernetes objects are not under the host in the model, and the SSH path is not a dependency.
    expect(affected.some((id) => id.startsWith('k8s:'))).toBe(false);
    expect(affected.some((id) => id.startsWith('ssh:'))).toBe(false);
    expect(result?.assumptions.join(' ')).toMatch(/host.*contains/i);
  });

  it('with one hop, a failed host still takes its contents but not their dependants', () => {
    const affected = ids(blastRadius(estate, 'host:prod-1', { mode: 'breaks', hops: 1 }));
    expect(affected).toContain('systemd:unit:nginx.service');
    expect(affected).not.toContain('peer:10.0.0.5');
  });

  it('does not apply the host rule to other nodes', () => {
    expect(blastRadius(estate, 'k8s:node:worker-1', { mode: 'breaks', hops: 5 })?.hostFailure).toBe(false);
    expect(blastRadius(estate, 'host:prod-1', { mode: 'needs', hops: 5 })?.hostFailure).toBe(false);
  });
});

describe('blastRadius: what it needs', () => {
  it('walks forward along dependency edges', () => {
    const result = blastRadius(estate, 'k8s:ingress:shop/web', { mode: 'needs', hops: 5 });
    expect(ids(result)).toEqual(
      [
        'k8s:service:shop/web',
        'k8s:pod:shop/web-7c9f-a1b2c',
        'k8s:pod:shop/web-7c9f-b2c3d',
        'k8s:pod:shop/web-7c9f-c3d4e',
        'k8s:node:worker-1',
        'k8s:configmap:shop/web-config'
      ].sort()
    );
    expect(blastRadius(estate, 'k8s:ingress:shop/web', { mode: 'needs', hops: 2 })?.nodes.length).toBe(4);
  });

  it('does not follow owns or orders-after', () => {
    // app.service is ordered after nginx and owns proc:node, but only depends on postgres.
    expect(ids(blastRadius(estate, 'systemd:unit:app.service', { mode: 'needs', hops: 1 }))).toEqual(['systemd:unit:postgres.service']);
    expect(ids(blastRadius(estate, 'systemd:unit:app.service', { mode: 'needs', hops: 5 }))).toEqual(['sock:listen:tcp:127.0.0.1:5432', 'systemd:unit:postgres.service']);
  });
});

describe('blastRadius: edges and edge cases', () => {
  it('returns null for a node that is not in the graph and for an empty graph', () => {
    expect(blastRadius(estate, 'ghost', { mode: 'breaks', hops: 3 })).toBeNull();
    expect(blastRadius(makeGraph([]), 'a', { mode: 'breaks', hops: 3 })).toBeNull();
  });

  it('has an empty result for an isolated node', () => {
    const g = makeGraph([makeNode('a'), makeNode('b')], [makeEdge('b', 'a', 'owns')]);
    const result = blastRadius(g, 'a', { mode: 'breaks', hops: 3 });
    expect(result?.nodes).toEqual([]);
    expect(result?.groups).toEqual([]);
    expect(result?.edgeIds).toEqual([]);
  });

  it('handles cycles, self-loops and unknown status', () => {
    const g = makeGraph(
      [makeNode('a', { status: 'unknown' }), makeNode('b'), makeNode('c')],
      [makeEdge('b', 'a'), makeEdge('c', 'b'), makeEdge('a', 'c'), makeEdge('a', 'a')]
    );
    const result = blastRadius(g, 'a', { mode: 'breaks', hops: 5 });
    expect(ids(result)).toEqual(['b', 'c']);
    expect(result?.alreadyFailed).toEqual([]);
  });

  it('collects the dependency edges between the start and the affected nodes', () => {
    const g = makeGraph(
      [makeNode('db'), makeNode('api'), makeNode('web'), makeNode('other')],
      [makeEdge('api', 'db', 'connects'), makeEdge('web', 'api', 'routes'), makeEdge('web', 'db', 'connects'), makeEdge('other', 'web', 'owns')]
    );
    const result = blastRadius(g, 'db', { mode: 'breaks', hops: 5 });
    expect(result?.edgeIds.sort()).toEqual(['connects:api->db', 'connects:web->db', 'routes:web->api']);
  });

  it('keeps a 5,000-node chain bounded by the hop limit', () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => makeNode(`n${i}`));
    const edges = Array.from({ length: 4999 }, (_, i) => makeEdge(`n${i + 1}`, `n${i}`));
    const started = performance.now();
    expect(blastRadius(makeGraph(nodes, edges), 'n0', { mode: 'breaks', hops: 5 })?.nodes.length).toBe(5);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('blastHighlight', () => {
  it('marks the start primary, affected secondary and failed ones danger', () => {
    const result = blastRadius(estate, 'k8s:node:worker-1', { mode: 'breaks', hops: 1 });
    const highlight = blastHighlight(result!);
    expect(highlight.id).toBe('blast-radius');
    expect(highlight.dimOthers).toBe(true);
    expect(highlight.nodes['k8s:node:worker-1']).toBe('primary');
    expect(highlight.nodes['k8s:pod:shop/db-0']).toBe('secondary');
    expect(highlight.nodes['k8s:pod:shop/web-7c9f-c3d4e']).toBe('danger');
    expect(highlight.edges['scheduled-on:k8s:pod:shop/db-0->k8s:node:worker-1']).toBe('secondary');
    expect(highlight.title).toContain('worker-1');
    expect(highlight.detail).toMatch(/4 nodes/);
  });

  it('words the needs direction differently', () => {
    const highlight = blastHighlight(blastRadius(estate, 'k8s:ingress:shop/web', { mode: 'needs', hops: 1 })!);
    expect(highlight.title).toMatch(/needs/i);
    expect(highlight.nodes['k8s:service:shop/web']).toBe('secondary');
  });

  it('says so when nothing is affected', () => {
    const highlight = blastHighlight(blastRadius(estate, 'systemd:unit:nginx.service', { mode: 'breaks', hops: 5 })!);
    expect(highlight.detail).toMatch(/no other nodes/i);
    expect(highlight.nodes).toEqual({ 'systemd:unit:nginx.service': 'primary' });
  });
});

describe('assumptions', () => {
  it('names what is followed and what is ignored', () => {
    const text = BLAST_ASSUMPTIONS.join(' ');
    expect(text).toContain('selects');
    expect(text).toContain('owns');
    expect(text).toContain('orders-after');
    expect(text).toMatch(/redundan/i);
    expect(text).toMatch(/configuration/i);
  });

  it('adds the host rule only for a failed host', () => {
    expect(blastRadius(estate, 'host:prod-1', { mode: 'breaks', hops: 2 })?.assumptions.length).toBe(BLAST_ASSUMPTIONS.length + 1);
    expect(blastRadius(estate, 'k8s:node:worker-1', { mode: 'breaks', hops: 2 })?.assumptions.length).toBe(BLAST_ASSUMPTIONS.length);
  });
});
