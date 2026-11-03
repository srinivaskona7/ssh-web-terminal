import { openDB } from 'idb';
/**
 * IndexedDB-backed job history. Records survive reloads so a job that keeps
 * running on the server is still visible (as `detached`) after the browser
 * reopens. Secrets are never stored — callers redact first.
 */
const DB_NAME = 'webssh-jobs';
const DB_VERSION = 1;
const STORE = 'jobs';
const MAX_RECORDS = 300;
let dbPromise = null;
function getDb() {
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
    async save(job) {
        const db = await getDb();
        await db.put(STORE, { ...job, updatedAt: Date.now() });
    }
    async get(id) {
        const db = await getDb();
        return (await db.get(STORE, id));
    }
    async list() {
        const db = await getDb();
        const jobs = (await db.getAll(STORE));
        return jobs.sort((a, b) => b.createdAt - a.createdAt);
    }
    async remove(id) {
        const db = await getDb();
        await db.delete(STORE, id);
    }
    /** Keep the newest MAX_RECORDS, dropping terminal jobs first. */
    async prune() {
        const db = await getDb();
        const jobs = await this.list();
        if (jobs.length <= MAX_RECORDS)
            return 0;
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
//# sourceMappingURL=job-store.js.map