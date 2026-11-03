import type { JobRecord } from './types.js';
export declare class JobStore {
    save(job: JobRecord): Promise<void>;
    get(id: string): Promise<JobRecord | undefined>;
    list(): Promise<JobRecord[]>;
    remove(id: string): Promise<void>;
    /** Keep the newest MAX_RECORDS, dropping terminal jobs first. */
    prune(): Promise<number>;
}
export declare const jobStore: JobStore;
//# sourceMappingURL=job-store.d.ts.map