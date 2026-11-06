import { describe, expect, it } from 'vitest';
import { makeEdge, makeGraph, makeNode } from '../fixtures.js';
import { DEFAULT_VIEW, type ViewState } from '../model.js';
import { EDGE_KINDS, NODE_KINDS, applyView, c4NodeCounts, c4Preset, detectC4Level, parseLabelSelector } from './view.js';

const view = (patch: Partial<ViewState> = {}): ViewState => ({ ...DEFAULT_VIEW, ...patch });
const ids = (d: ReturnType<typeof applyView>): string[] => d.nodes.map((n) => n.id).sort();

describe('parseLabelSelector', () => {
  const node = (tags: Record<string, string>, extra = {}) => makeNode('k8s:pod:prod/web', { kind: 'k8s-pod', tags, ...extra });
  const matches = (text: string, n = node({ app: 'web', tier: 'fe' })): boolean => {
    const p = parseLabelSelector(text);
    if (!p.ok) throw new Error(p.error);
    return p.matches(n);
  };

  it('treats empty text as match-all', () => {
    const p = parseLabelSelector('  ');
    expect(p.ok && p.requirements).toEqual([]);
    expect(matches('')).toBe(true);
  });

  it('supports equality, inequality, existence and sets', () => {
    expect(matches('app=web')).toBe(true);
    expect(matches('app==web')).toBe(true);
    expect(matches('app=db')).toBe(false);
    expect(matches('app!=db')).toBe(true);
    expect(matches('app!=web')).toBe(false);
    expect(matches('missing!=x')).toBe(true);
    expect(matches('tier')).toBe(true);
    expect(matches('nope')).toBe(false);
    expect(matches('!nope')).toBe(true);
    expect(matches('!app')).toBe(false);
    expect(matches('app in (web,db)')).toBe(true);
    expect(matches('app IN (db, cache)')).toBe(false);
    expect(matches('app notin (db)')).toBe(true);
    expect(matches('app notin (web)')).toBe(false);
    expect(matches('nope notin (web)')).toBe(true);
    expect(matches('app=web,tier!=be')).toBe(true);
    expect(matches('app=web,tier!=fe')).toBe(false);
    expect(matches('app in (web,db),tier=fe')).toBe(true);
  });

  it('matches the virtual namespace and kind labels', () => {
    expect(matches('namespace=prod')).toBe(true);
    expect(matches('kind=k8s-pod')).toBe(true);
    expect(matches('namespace=dev')).toBe(false);
    const ns = makeNode('k8s:namespace:staging', { kind: 'k8s-namespace' });
    expect(matches('namespace=staging', ns)).toBe(true);
    const fielded = makeNode('x', { fields: { namespace: 'ops', kind: 'Deployment' } });
    expect(matches('namespace=ops,kind=Deployment', fielded)).toBe(true);
    const tagged = makeNode('k8s:pod:a/b', { tags: { namespace: 'real' } });
    expect(matches('namespace=real', tagged)).toBe(true);
    expect(matches('kind=custom', makeNode('x', { tags: { kind: 'tagkind' } }))).toBe(true);
  });

  it('reports malformed input instead of throwing', () => {
    for (const bad of ['a=', 'a in ()', 'a in (x', 'a in x)', ',', 'a,,b', '=b', 'a b', 'a in (x$)', '!', 'a=b c', '$bad=1', ')(', '!$x', 'a notin ( , )']) {
      const p = parseLabelSelector(bad);
      if (bad === 'a=') {
        expect(p.ok).toBe(true); // empty value is legal
      } else {
        expect(p.ok, bad).toBe(false);
        expect(p.ok === false && p.error.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('applyView', () => {
  const estate = () =>
    makeGraph(
      [
        makeNode('ns', { kind: 'k8s-namespace', status: 'healthy' }),
        makeNode('k8s:deployment:ns/web', { kind: 'k8s-deployment', parent: 'ns', status: 'healthy', tags: { app: 'web' } }),
        makeNode('k8s:pod:ns/web-1', { kind: 'k8s-pod', parent: 'ns', status: 'failed', tags: { app: 'web' } }),
        makeNode('k8s:pod:ns/db-1', { kind: 'k8s-pod', parent: 'ns', status: 'healthy', tags: { app: 'db' } }),
        makeNode('k8s:configmap:ns/cfg', { kind: 'k8s-configmap', parent: 'ns', status: 'unknown' }),
        makeNode('far', { kind: 'host', status: 'healthy' })
      ],
      [
        makeEdge('k8s:deployment:ns/web', 'k8s:pod:ns/web-1', 'owns'),
        makeEdge('k8s:pod:ns/web-1', 'k8s:pod:ns/db-1', 'connects'),
        makeEdge('k8s:pod:ns/web-1', 'k8s:configmap:ns/cfg', 'uses-config')
      ]
    );

  it('draws everything by default and reports nothing hidden', () => {
    const d = applyView(estate(), view());
    expect(d.nodes).toHaveLength(6);
    expect(d.edges).toHaveLength(3);
    expect(d.hidden).toEqual({ nodes: 0, edges: 0, capped: 0 });
    expect(d.nodes.find((n) => n.id === 'ns')!.childCount).toBe(4);
    expect(d.nodes.find((n) => n.id === 'k8s:pod:ns/web-1')!.depth).toBe(1);
    expect(applyView(null, view()).nodes).toEqual([]);
  });

  it('hides kinds and re-parents children to the nearest kept ancestor', () => {
    const d = applyView(estate(), view({ hiddenNodeKinds: ['k8s-namespace'] }));
    expect(d.nodes.find((n) => n.id === 'k8s:pod:ns/web-1')!.parent).toBeNull();
    expect(d.hidden.nodes).toBe(1);
    const e = applyView(estate(), view({ hiddenNodeKinds: ['k8s-pod'], hiddenEdgeKinds: ['owns'] }));
    expect(e.edges).toHaveLength(0);
    expect(e.hidden.edges).toBe(3);
  });

  it('filters by label selector and keeps containers; flags a bad selector', () => {
    const d = applyView(estate(), view({ labelSelector: 'app=db' }));
    expect(ids(d)).toEqual(['k8s:pod:ns/db-1', 'ns']);
    const bad = applyView(estate(), view({ labelSelector: 'app in (' }));
    expect(bad.selectorError).toBeTruthy();
    expect(bad.nodes).toHaveLength(6);
  });

  it('problems keeps failed nodes, direct neighbours and containers', () => {
    const d = applyView(estate(), view({ statusFilter: 'problems' }));
    expect(ids(d)).toEqual(['k8s:configmap:ns/cfg', 'k8s:deployment:ns/web', 'k8s:pod:ns/db-1', 'k8s:pod:ns/web-1', 'ns']);
    const healthy = makeGraph([makeNode('a', { status: 'healthy' })]);
    expect(applyView(healthy, view({ statusFilter: 'problems' })).nodes).toEqual([]);
  });

  it('focus keeps N hops and flags a missing focus node', () => {
    const one = applyView(estate(), view({ focus: { nodeId: 'k8s:pod:ns/db-1', hops: 1 } }));
    expect(ids(one)).toEqual(['k8s:pod:ns/db-1', 'k8s:pod:ns/web-1', 'ns']);
    const zero = applyView(estate(), view({ focus: { nodeId: 'far', hops: 0 } }));
    expect(ids(zero)).toEqual(['far']);
    const two = applyView(estate(), view({ focus: { nodeId: 'k8s:pod:ns/db-1', hops: 2 } }));
    expect(two.nodes).toHaveLength(5);
    const missing = applyView(estate(), view({ focus: { nodeId: 'ghost', hops: 1 } }));
    expect(missing.focusMissing).toBe(true);
    expect(missing.nodes).toHaveLength(6);
  });

  it('collapse hides descendants, counts them, and aggregates edges', () => {
    const g = estate();
    g.edges.push(makeEdge('far', 'k8s:pod:ns/web-1', 'connects'), makeEdge('far', 'k8s:pod:ns/db-1', 'connects'));
    const d = applyView(g, view({ collapsed: ['ns'] }));
    expect(ids(d)).toEqual(['far', 'ns']);
    const ns = d.nodes.find((n) => n.id === 'ns')!;
    expect(ns.collapsed).toBe(true);
    expect(ns.hiddenDescendants).toBe(4);
    expect(d.edges).toHaveLength(1);
    expect(d.edges[0]).toMatchObject({ id: 'agg:connects:far->ns', count: 2, aggregated: true });
    expect(d.hidden.nodes).toBe(4);
  });

  it('keeps a lone cross edge under its own id', () => {
    const g = makeGraph([makeNode('a'), makeNode('b', { parent: 'a' }), makeNode('c')], [makeEdge('c', 'b')]);
    const plain = applyView(g, view());
    expect(plain.edges[0]).toMatchObject({ id: 'depends-on:c->b', aggregated: false, count: 1 });
    expect(applyView(g, view({ collapsed: ['a'] })).edges[0]!.aggregated).toBe(true);
  });

  it('caps by priority: low-priority kinds go first, problems survive', () => {
    const nodes = [
      makeNode('h', { kind: 'host', status: 'healthy' }),
      makeNode('s1', { kind: 'k8s-secret', status: 'failed' }),
      makeNode('s2', { kind: 'k8s-secret', status: 'healthy' }),
      makeNode('c1', { kind: 'k8s-configmap', status: 'healthy' }),
      makeNode('d1', { kind: 'k8s-deployment', status: 'healthy' }),
      makeNode('d2', { kind: 'k8s-deployment', status: 'healthy' })
    ];
    const d = applyView(makeGraph(nodes, [makeEdge('d1', 's2')]), view(), { cap: 4 });
    expect(ids(d)).toEqual(['d1', 'd2', 'h', 's1']);
    expect(d.hidden.capped).toBe(2);
    expect(d.hidden.nodes).toBe(2);
    expect(d.edges).toEqual([]);
    expect(d.cap).toBe(4);
  });

  it('cap can drop a container and re-parent its children', () => {
    const nodes = [
      makeNode('ns', { kind: 'k8s-secret', status: 'healthy' }),
      makeNode('p', { kind: 'k8s-pod', status: 'failed', parent: 'ns' }),
      makeNode('q', { kind: 'k8s-pod', status: 'failed' })
    ];
    const d = applyView(makeGraph(nodes), view(), { cap: 2 });
    expect(ids(d)).toEqual(['p', 'q']);
    expect(d.nodes.find((n) => n.id === 'p')!.parent).toBeNull();
  });

  describe('groupBy', () => {
    const parentsOf = (g: ReturnType<typeof estate>, groupBy: ViewState['groupBy']) => Object.fromEntries(applyView(g, view({ groupBy })).nodes.map((n) => [n.id, n.parent]));

    it('namespace regroups by field or id', () => {
      const g = makeGraph([
        makeNode('k8s:namespace:prod', { kind: 'k8s-namespace' }),
        makeNode('k8s:pod:prod/a', { kind: 'k8s-pod' }),
        makeNode('x', { kind: 'k8s-service', fields: { namespace: 'prod' } }),
        makeNode('y', { kind: 'k8s-service', fields: { namespace: 'nowhere' }, parent: 'x' })
      ]);
      const p = parentsOf(g, 'namespace');
      expect(p['k8s:pod:prod/a']).toBe('k8s:namespace:prod');
      expect(p.x).toBe('k8s:namespace:prod');
      expect(p.y).toBe('x');
      expect(p['k8s:namespace:prod']).toBeNull();
    });

    it('k8s-node, owner, compose-project and docker-network follow their relation', () => {
      const g = makeGraph(
        [
          makeNode('k8s:node:n1', { kind: 'k8s-node' }),
          makeNode('pod', { kind: 'k8s-pod' }),
          makeNode('pod2', { kind: 'k8s-pod', fields: { node: 'n1' } }),
          makeNode('dep', { kind: 'k8s-deployment' }),
          makeNode('compose:project:app', { kind: 'compose-project' }),
          makeNode('svc', { kind: 'compose-service', fields: { composeProject: 'app' } }),
          makeNode('net', { kind: 'docker-network' }),
          makeNode('ctr', { kind: 'container' })
        ],
        [makeEdge('pod', 'k8s:node:n1', 'scheduled-on'), makeEdge('dep', 'pod', 'owns'), makeEdge('ctr', 'net', 'attached')]
      );
      expect(parentsOf(g, 'k8s-node').pod).toBe('k8s:node:n1');
      expect(parentsOf(g, 'k8s-node').pod2).toBe('k8s:node:n1');
      expect(parentsOf(g, 'owner').pod).toBe('dep');
      expect(parentsOf(g, 'compose-project').svc).toBe('compose:project:app');
      expect(parentsOf(g, 'docker-network').ctr).toBe('net');
    });

    it('none flattens and dissolves edge-less grouping nodes without counting them hidden', () => {
      const g = makeGraph([makeNode('ns', { kind: 'k8s-namespace' }), makeNode('p', { kind: 'k8s-pod', parent: 'ns' }), makeNode('used', { kind: 'k8s-namespace' })], [makeEdge('used', 'p')]);
      const d = applyView(g, view({ groupBy: 'none' }));
      expect(ids(d)).toEqual(['p', 'used']);
      expect(d.nodes.every((n) => n.parent === null)).toBe(true);
      expect(d.hidden.nodes).toBe(0);
    });

    it('breaks parent cycles from any rule', () => {
      const g = makeGraph([makeNode('a', { parent: 'b' }), makeNode('b', { parent: 'a' }), makeNode('c', { parent: 'c' }), makeNode('d', { parent: 'missing' })], [makeEdge('a', 'b', 'owns'), makeEdge('b', 'a', 'owns')]);
      for (const gb of ['parent', 'owner'] as const) {
        const d = applyView(g, view({ groupBy: gb }));
        expect(d.nodes).toHaveLength(4);
        expect(d.nodes.some((n) => n.parent === null && ['a', 'b'].includes(n.id))).toBe(true);
      }
    });
  });

  describe('C4 presets', () => {
    const g = makeGraph([makeNode('h', { kind: 'host' }), makeNode('d', { kind: 'k8s-deployment' }), makeNode('p', { kind: 'k8s-pod' })]);

    it('hide progressively finer kinds and are detected back', () => {
      expect(c4Preset('component')).toEqual([]);
      expect(ids(applyView(g, view({ hiddenNodeKinds: c4Preset('context') })))).toEqual(['h']);
      expect(ids(applyView(g, view({ hiddenNodeKinds: c4Preset('container') })))).toEqual(['d', 'h']);
      expect(detectC4Level({ hiddenNodeKinds: c4Preset('container') })).toBe('container');
      expect(detectC4Level({ hiddenNodeKinds: [] })).toBe('component');
      expect(detectC4Level({ hiddenNodeKinds: ['image'] })).toBeNull();
      expect(c4NodeCounts(g)).toEqual({ context: 1, container: 2, component: 3 });
      expect(c4NodeCounts(null)).toEqual({ context: 0, container: 0, component: 0 });
    });
  });

  it('exports every kind', () => {
    expect(NODE_KINDS).toHaveLength(33);
    expect(EDGE_KINDS).toHaveLength(15);
  });

  it('stays quick at 5,000 nodes', () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => makeNode(`n${i}`, { kind: 'k8s-pod', parent: i % 50 === 0 ? undefined : `n${i - (i % 50)}` }));
    const edges = nodes.slice(1).map((n, i) => makeEdge(`n${i}`, n.id));
    const start = performance.now();
    const d = applyView(makeGraph(nodes, edges), view());
    expect(d.nodes).toHaveLength(2000);
    expect(d.hidden.capped).toBe(3000);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});
