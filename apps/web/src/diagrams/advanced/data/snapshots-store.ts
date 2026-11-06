/**
 * Snapshots of the drawn estate, kept in IndexedDB so a later scan can be
 * compared against them. One store, newest 30 per estate; `evidence.raw` is
 * dropped before storing because raw command output is large and may hold
 * secrets the user never meant to keep.
 */
import { wrap } from 'idb';
import type { IDBPDatabase } from 'idb';
import type { DiagramGraph, DiagramNode } from '../../model.js';
import { storageKeyFor } from '../../model.js';

export const SNAPSHOT_DB_NAME = 'webssh-diagrams';
export const MAX_SNAPSHOTS_PER_ESTATE = 30;
const STORE = 'snapshots';
const LABEL_MAX = 80;

export type SnapshotErrorKind = 'unavailable' | 'blocked' | 'quota' | 'corrupt' | 'failed';

/** Carries a message that is fit to show the user as is. */
export class SnapshotStoreError extends Error {
  constructor(
    readonly kind: SnapshotErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'SnapshotStoreError';
  }
}

export interface SnapshotMeta {
  id: string;
  estate: string;
  label: string;
  savedAt: number;
  collectedAt: number;
  title: string;
  nodeCount: number;
  edgeCount: number;
}

export interface SnapshotRecord extends SnapshotMeta {
  graph: DiagramGraph;
}

export interface SnapshotListing {
  snapshots: SnapshotMeta[];
  /** Records that could not be read and were left out of the list. */
  unreadable: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;
let lastSavedAt = 0;

/** Drop the cached connection (tests, and after a failed open). */
export function closeSnapshotDb(): void {
  const pending = dbPromise;
  dbPromise = null;
  void pending?.then((db) => db.close()).catch(() => undefined);
}

function openDatabase(): Promise<IDBPDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SNAPSHOT_DB_NAME, 1);
    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('byEstate', 'estate');
      }
    });
    request.addEventListener('blocked', () =>
      reject(new SnapshotStoreError('blocked', 'Snapshots are blocked by another tab that has an older version of Diagram Studio open. Close the other tab and try again.'))
    );
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB open failed')));
    request.addEventListener('success', () => {
      const raw = request.result;
      if (!raw.objectStoreNames.contains(STORE)) {
        raw.close();
        reject(new SnapshotStoreError('corrupt', `The ${SNAPSHOT_DB_NAME} database exists but has no snapshots store. Clear site data for this page to rebuild it.`));
        return;
      }
      resolve(wrap(raw) as unknown as IDBPDatabase);
    });
  });
}

function classify(error: unknown): SnapshotStoreError {
  if (error instanceof SnapshotStoreError) return error;
  const name = (error as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError') {
    return new SnapshotStoreError('quota', 'Browser storage is full, so the snapshot was not saved. Delete older snapshots or free disk space.');
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new SnapshotStoreError('failed', `Snapshot storage failed: ${detail}`);
}

async function database(): Promise<IDBPDatabase> {
  if (typeof indexedDB === 'undefined' || !indexedDB) {
    throw new SnapshotStoreError('unavailable', 'IndexedDB is not available in this browser (private mode or storage disabled), so snapshots cannot be kept.');
  }
  if (!dbPromise) {
    const opening = openDatabase();
    dbPromise = opening;
    opening.catch(() => {
      if (dbPromise === opening) dbPromise = null;
    });
  }
  return dbPromise;
}

function isMeta(value: unknown): value is SnapshotMeta {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.estate === 'string' &&
    typeof v.label === 'string' &&
    typeof v.title === 'string' &&
    typeof v.savedAt === 'number' &&
    typeof v.collectedAt === 'number' &&
    typeof v.nodeCount === 'number' &&
    typeof v.edgeCount === 'number'
  );
}

function isPlainObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNode(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const n = value as Record<string, unknown>;
  return (
    typeof n.id === 'string' &&
    typeof n.kind === 'string' &&
    typeof n.label === 'string' &&
    typeof n.status === 'string' &&
    isPlainObject(n.tags) &&
    isPlainObject(n.fields) &&
    isPlainObject(n.evidence)
  );
}

function isGraph(value: unknown): value is DiagramGraph {
  if (!isPlainObject(value)) return false;
  const g = value as Record<string, unknown>;
  return Array.isArray(g.nodes) && g.nodes.every(isNode) && Array.isArray(g.edges) && g.edges.every(isPlainObject);
}

function metaOf(record: SnapshotMeta): SnapshotMeta {
  const { id, estate, label, savedAt, collectedAt, title, nodeCount, edgeCount } = record;
  return { id, estate, label, savedAt, collectedAt, title, nodeCount, edgeCount };
}

function withoutRaw(node: DiagramNode): DiagramNode {
  const { raw, ...evidence } = node.evidence;
  return { ...node, evidence };
}

function nextSavedAt(): number {
  lastSavedAt = Math.max(Date.now(), lastSavedAt + 1);
  return lastSavedAt;
}

/**
 * Store a copy of `graph` under `estate` (default: its storage key) and prune
 * the estate to its newest 30 in the same transaction.
 */
export async function saveSnapshot(
  graph: DiagramGraph,
  label = '',
  estate: string = storageKeyFor(graph)
): Promise<{ snapshot: SnapshotMeta; pruned: number }> {
  try {
    const db = await database();
    const savedAt = nextSavedAt();
    const record: SnapshotRecord = {
      // Zero-padded time first, so primary-key order is chronological.
      id: `${String(savedAt).padStart(15, '0')}-${Math.random().toString(36).slice(2, 8)}`,
      estate,
      label: label.trim().slice(0, LABEL_MAX),
      savedAt,
      collectedAt: graph.collectedAt,
      title: graph.title,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      graph: { ...graph, nodes: graph.nodes.map(withoutRaw) }
    };
    const tx = db.transaction(STORE, 'readwrite');
    // An aborted transaction rejects `done`; the catch below reports the cause.
    tx.done.catch(() => undefined);
    try {
      const store = tx.objectStore(STORE);
      await store.put(record);
      const keys = (await store.index('byEstate').getAllKeys(estate)) as string[];
      const excess = keys.slice(0, Math.max(0, keys.length - MAX_SNAPSHOTS_PER_ESTATE));
      for (const key of excess) await store.delete(key);
      await tx.done;
      return { snapshot: metaOf(record), pruned: excess.length };
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      throw error;
    }
  } catch (error) {
    throw classify(error);
  }
}

/** Newest first. Records that fail validation are skipped and counted. */
export async function listSnapshots(estate: string): Promise<SnapshotListing> {
  try {
    const db = await database();
    const records = (await db.getAllFromIndex(STORE, 'byEstate', estate)) as unknown[];
    const snapshots: SnapshotMeta[] = [];
    let unreadable = 0;
    for (const record of records) {
      if (isMeta(record)) snapshots.push(metaOf(record));
      else unreadable += 1;
    }
    snapshots.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? 1 : -1));
    return { snapshots, unreadable };
  } catch (error) {
    throw classify(error);
  }
}

/** The full record, or null when it is not in this estate. Throws `corrupt` for a damaged record. */
export async function getSnapshot(estate: string, id: string): Promise<SnapshotRecord | null> {
  try {
    const db = await database();
    const record = (await db.get(STORE, id)) as unknown;
    if (!record || (record as { estate?: unknown }).estate !== estate) return null;
    if (!isMeta(record) || !isGraph((record as { graph?: unknown }).graph)) {
      throw new SnapshotStoreError('corrupt', 'This snapshot is damaged and cannot be opened. Delete it and save a new one.');
    }
    return record as SnapshotRecord;
  } catch (error) {
    throw classify(error);
  }
}

/** True when a snapshot was removed; false when it was already gone or belongs to another estate. */
export async function deleteSnapshot(estate: string, id: string): Promise<boolean> {
  try {
    const db = await database();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const record = (await store.get(id)) as { estate?: unknown } | undefined;
    if (!record || record.estate !== estate) {
      await tx.done;
      return false;
    }
    await store.delete(id);
    await tx.done;
    return true;
  } catch (error) {
    throw classify(error);
  }
}
