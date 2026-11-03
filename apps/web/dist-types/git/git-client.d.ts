import { type RemoteSession } from '../session/remote-session.js';
export interface GitFileStatus {
    path: string;
    /** Two-character porcelain code, e.g. "M ", "??". */
    code: string;
    index: string;
    worktree: string;
}
export interface GitStatus {
    branch: string;
    upstream?: string;
    ahead: number;
    behind: number;
    files: GitFileStatus[];
    clean: boolean;
}
export interface GitLogEntry {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    subject: string;
}
export declare class GitClient {
    private readonly session;
    private readonly dir;
    constructor(session: RemoteSession, dir: string);
    private run;
    isRepository(): Promise<boolean>;
    status(): Promise<GitStatus>;
    diff(path?: string, staged?: boolean): Promise<string>;
    branches(): Promise<{
        current: string;
        branches: string[];
    }>;
    log(limit?: number): Promise<GitLogEntry[]>;
    stage(paths: string[]): Promise<void>;
    unstage(paths: string[]): Promise<void>;
    commit(message: string): Promise<{
        hash: string;
        summary: string;
    }>;
    fetch(remote?: string): Promise<string>;
    /** Fast-forward only. Never rewrites history or discards local changes. */
    pull(): Promise<string>;
    /** Plain push only — force-push is not exposed anywhere in the UI. */
    push(setUpstream?: boolean): Promise<string>;
    checkout(branch: string): Promise<void>;
    createBranch(branch: string): Promise<void>;
}
//# sourceMappingURL=git-client.d.ts.map