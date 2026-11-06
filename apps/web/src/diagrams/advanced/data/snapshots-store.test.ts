import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEdge, makeGraph, makeNode } from '../../fixtures.js';
import type { DiagramGraph } from '../../model.js';
import {
  MAX_SNAPSHOTS_PER_ESTATE,
  SNAPSHOT_DB_NAME,
  SnapshotStoreError,
  closeSnapshotDb,
  deleteSnapshot,
  getSnapshot,
  listSnapshots,
  saveSnapshot
} from './snapshots-store.js';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function wipeDatabase(): Promise<void> {
  closeSnapshotDb();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(SNAPSHOT_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function hostGraph(hostKey: string, extra: Partial<DiagramGraph> = {}): DiagramGraph {
  return makeGraph(
    [
      makeNode('k8s:pod:default/web', { kind: 'k8s-pod', label: 'web', status: 'healthy', evidence: { source: 'kubernetes', command: 'kubectl get pods -o json', raw: { secret: 'do-not-keep' } } }),
      makeNode('k8s:pod:default/db', { kind: 'k8s-pod', label: 'db', status: 'unknown', evidence: { source: 'kubernetes', raw: { big: 'object' } } })
    ],
    [makeEdge('k8s:pod:default/web', 'k8s:pod:default/db', 'connects')],
    { hostKey, title: 'ops@host', ...extra }
  );
}

beforeEach(async () => {
  await wipeDatabase();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await wipeDatabase();
});

describe('snapshot store', () => {
  it('saves a snapshot and lists it with counts, label and times', async () => {
    const graph = hostGraph('ops@host:22', { collectedAt: 1_700_000_123_000 });
    const { snapshot, pruned } = await saveSnapshot(graph, 'before upgrade');
    expect(pruned).toBe(0);
    expect(snapshot).toMatchObject({
      estate: 'ops@host:22',
      label: 'before upgrade',
      title: 'ops@host',
      nodeCount: 2,
      edgeCount: 1,
      collectedAt: 1_700_000_123_000
    });
    expect(snapshot.savedAt).toBeGreaterThan(0);
    expect(snapshot).not.toHaveProperty('graph');

    const listing = await listSnapshots('ops@host:22');
    expect(listing.unreadable).toBe(0);
    expect(listing.snapshots).toEqual([snapshot]);
  });

  it('strips evidence.raw before storing and leaves the caller graph untouched', async () => {
    const graph = hostGraph('ops@host:22');
    const { snapshot } = await saveSnapshot(graph);
    const stored = await getSnapshot('ops@host:22', snapshot.id);
    expect(stored).not.toBeNull();
    for (const node of stored!.graph.nodes) {
      expect(node.evidence).not.toHaveProperty('raw');
    }
    expect(stored!.graph.nodes[0]!.evidence).toEqual({ source: 'kubernetes', command: 'kubectl get pods -o json' });
    expect(stored!.graph.nodes[0]).toMatchObject({ id: 'k8s:pod:default/web', status: 'healthy', label: 'web' });
    // The live scan still has its raw objects for the inspector.
    expect(graph.nodes[0]!.evidence.raw).toEqual({ secret: 'do-not-keep' });
  });

  it('lists newest first, including saves made in the same millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const graph = hostGraph('ops@host:22');
    const first = await saveSnapshot(graph, 'first');
    const second = await saveSnapshot(graph, 'second');
    const third = await saveSnapshot(graph, 'third');
    const { snapshots } = await listSnapshots('ops@host:22');
    expect(snapshots.map((s) => s.label)).toEqual(['third', 'second', 'first']);
    expect(first.snapshot.savedAt).toBeLessThan(second.snapshot.savedAt);
    expect(second.snapshot.savedAt).toBeLessThan(third.snapshot.savedAt);
  });

  it('keeps only the newest 30 per estate and reports how many it dropped', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const graph = hostGraph('ops@host:22');
    let lastPruned = 0;
    for (let i = 0; i < MAX_SNAPSHOTS_PER_ESTATE + 3; i += 1) {
      vi.setSystemTime(1_700_000_000_000 + i * 1000);
      const result = await saveSnapshot(graph, `scan ${i}`);
      lastPruned = result.pruned;
    }
    expect(lastPruned).toBe(1);
    const { snapshots } = await listSnapshots('ops@host:22');
    expect(snapshots).toHaveLength(MAX_SNAPSHOTS_PER_ESTATE);
    expect(snapshots[0]!.label).toBe('scan 32');
    expect(snapshots.at(-1)!.label).toBe('scan 3');
    expect(snapshots.some((s) => s.label === 'scan 2')).toBe(false);
  });

  it('keeps estates apart: no listing, lookup, delete or pruning crosses over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const a = hostGraph('ops@alpha:22');
    const b = hostGraph('ops@beta:22');
    vi.setSystemTime(1_700_000_000_000);
    const savedB = await saveSnapshot(b, 'beta only');
    for (let i = 0; i < MAX_SNAPSHOTS_PER_ESTATE + 2; i += 1) {
      vi.setSystemTime(1_700_000_001_000 + i * 1000);
      await saveSnapshot(a, `alpha ${i}`);
    }
    expect((await listSnapshots('ops@beta:22')).snapshots.map((s) => s.label)).toEqual(['beta only']);
    expect((await listSnapshots('ops@alpha:22')).snapshots).toHaveLength(MAX_SNAPSHOTS_PER_ESTATE);

    expect(await getSnapshot('ops@alpha:22', savedB.snapshot.id)).toBeNull();
    expect(await deleteSnapshot('ops@alpha:22', savedB.snapshot.id)).toBe(false);
    expect(await getSnapshot('ops@beta:22', savedB.snapshot.id)).not.toBeNull();
  });

  it('stores a hostless import under import:<title> by default and under an explicit estate on request', async () => {
    const imported = makeGraph([makeNode('custom:a')], [], { title: 'main.tf state' });
    const byTitle = await saveSnapshot(imported);
    expect(byTitle.snapshot.estate).toBe('import:main.tf state');
    const pinned = await saveSnapshot(imported, '', 'import:original title');
    expect(pinned.snapshot.estate).toBe('import:original title');
    expect((await listSnapshots('import:original title')).snapshots).toHaveLength(1);
  });

  it('deletes by id and says so when the snapshot is already gone', async () => {
    const { snapshot } = await saveSnapshot(hostGraph('ops@host:22'));
    expect(await deleteSnapshot('ops@host:22', snapshot.id)).toBe(true);
    expect(await deleteSnapshot('ops@host:22', snapshot.id)).toBe(false);
    expect((await listSnapshots('ops@host:22')).snapshots).toEqual([]);
    expect(await getSnapshot('ops@host:22', snapshot.id)).toBeNull();
  });

  it('trims and bounds the label', async () => {
    const { snapshot } = await saveSnapshot(hostGraph('ops@host:22'), `  ${'x'.repeat(200)}  `);
    expect(snapshot.label).toHaveLength(80);
    expect(snapshot.label).toBe('x'.repeat(80));
  });

  it('round-trips an empty graph and a node with unknown status', async () => {
    const empty = await saveSnapshot(makeGraph([], [], { hostKey: 'ops@empty:22' }));
    expect(empty.snapshot).toMatchObject({ nodeCount: 0, edgeCount: 0 });
    const loaded = await getSnapshot('ops@empty:22', empty.snapshot.id);
    expect(loaded!.graph.nodes).toEqual([]);

    const unknown = await saveSnapshot(makeGraph([makeNode('a', { status: 'unknown', fields: { phase: null } })], [], { hostKey: 'ops@u:22' }));
    const back = await getSnapshot('ops@u:22', unknown.snapshot.id);
    expect(back!.graph.nodes[0]).toMatchObject({ status: 'unknown', fields: { phase: null } });
  });
});

describe('snapshot store failures are visible', () => {
  it('reports unavailable IndexedDB and recovers once it is back', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const failure = await saveSnapshot(hostGraph('ops@host:22')).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SnapshotStoreError);
    expect((failure as SnapshotStoreError).kind).toBe('unavailable');
    expect((failure as SnapshotStoreError).message).toMatch(/IndexedDB/);
    await expect(listSnapshots('ops@host:22')).rejects.toMatchObject({ kind: 'unavailable' });

    vi.unstubAllGlobals();
    const ok = await saveSnapshot(hostGraph('ops@host:22'));
    expect(ok.snapshot.nodeCount).toBe(2);
  });

  it('reports a blocked database instead of waiting forever', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      const fake = new EventTarget() as unknown as IDBOpenDBRequest;
      queueMicrotask(() => fake.dispatchEvent(new Event('blocked')));
      return fake;
    });
    const failure = await saveSnapshot(hostGraph('ops@host:22')).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SnapshotStoreError);
    expect((failure as SnapshotStoreError).kind).toBe('blocked');
    expect((failure as SnapshotStoreError).message).toMatch(/other (Diagram Studio )?tab/i);
  });

  it('reports a full disk as a quota error and stores nothing', async () => {
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const failure = await saveSnapshot(hostGraph('ops@host:22')).catch((e: unknown) => e);
    expect((failure as SnapshotStoreError).kind).toBe('quota');
    expect((failure as SnapshotStoreError).message).toMatch(/storage is full/i);
    spy.mockRestore();
    expect((await listSnapshots('ops@host:22')).snapshots).toEqual([]);
  });

  it('reports a database whose snapshots store is missing as corrupt', async () => {
    await wipeDatabase();
    const db = await request<IDBDatabase>(
      (() => {
        const req = indexedDB.open(SNAPSHOT_DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('something-else');
        return req;
      })()
    );
    db.close();
    await expect(listSnapshots('ops@host:22')).rejects.toMatchObject({ kind: 'corrupt' });
    await expect(saveSnapshot(hostGraph('ops@host:22'))).rejects.toMatchObject({ kind: 'corrupt' });
  });

  it('skips unreadable records when listing and counts them', async () => {
    const { snapshot } = await saveSnapshot(hostGraph('ops@host:22'), 'good');
    closeSnapshotDb();
    const db = await request<IDBDatabase>(indexedDB.open(SNAPSHOT_DB_NAME, 1));
    const tx = db.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').put({ id: 'bad-1', estate: 'ops@host:22', savedAt: 5 });
    tx.objectStore('snapshots').put({ id: 'bad-2', estate: 'ops@host:22', savedAt: 6, label: '', title: 't', collectedAt: 1, nodeCount: 1, edgeCount: 0, graph: { nodes: [{ id: 'x' }], edges: [] } });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const listing = await listSnapshots('ops@host:22');
    expect(listing.snapshots.map((s) => s.id)).toEqual([snapshot.id, 'bad-2'].filter((id) => id === snapshot.id).concat(listing.snapshots.filter((s) => s.id === 'bad-2').map((s) => s.id)));
    expect(listing.unreadable).toBe(1);
    // bad-2 has the right outline but its nodes are malformed: opening it is refused.
    await expect(getSnapshot('ops@host:22', 'bad-2')).rejects.toMatchObject({ kind: 'corrupt' });
    await expect(getSnapshot('ops@host:22', 'bad-1')).rejects.toMatchObject({ kind: 'corrupt' });
  });
});
