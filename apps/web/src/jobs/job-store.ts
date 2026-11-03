import { openDB, type IDBPDatabase } from 'idb';
import type { JobRecord } from './types.js';

/**
 * IndexedDB-backed job history. Records survive reloads so a job that keeps
 * running on the server is still visible (as `detached`) after the browser
 * reopens. Secrets are never stored — callers redact first.
 */

const DB_NAME = 'webssh-jobs';
const DB_VERSION = 1;
const STORE = 'jobs';
const MAX_RECORDS = 300;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
          store.createIndex('state', 'state');
        }
      }
    });
  }
  return dbPromise;
}

export class JobStore {
  async save(job: JobRecord): Promise<void> {
    const db = await getDb();
    await db.put(STORE, { ...job, updatedAt: Date.now() });
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const db = await getDb();
    return (await db.get(STORE, id)) as JobRecord | undefined;
  }

  async list(): Promise<JobRecord[]> {
    const db = await getDb();
    const jobs = (await db.getAll(STORE)) as JobRecord[];
    return jobs.sort((a, b) => b.createdAt - a.createdAt);
  }

  async remove(id: string): Promise<void> {
    const db = await getDb();
    await db.delete(STORE, id);
  }

  /** Keep the newest MAX_RECORDS, dropping terminal jobs first. */
  async prune(): Promise<number> {
    const db = await getDb();
    const jobs = await this.list();
    if (jobs.length <= MAX_RECORDS) return 0;
    const excess = jobs.length - MAX_RECORDS;
    const removable = jobs
      .filter((job) => job.state !== 'running' && job.state !== 'detached')
      .slice(-excess);
    for (const job of removable) {
      await db.delete(STORE, job.id);
    }
    return removable.length;
  }
}

export const jobStore = new JobStore();
