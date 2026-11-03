/**
 * Common surface every transport offers to the workspace modules.
 *
 * The Go gateway and the Cloudflare relay differ internally, but discovery,
 * recipes, jobs, Git, containers and Kubernetes only need this contract.
 */
export interface RemoteExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
export interface RemoteExecOptions {
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    timeoutMs?: number;
    signal?: AbortSignal;
}
export interface RemoteSession {
    readonly transport: 'cloudflare-relay' | 'go-gateway';
    readonly host: string;
    readonly user: string;
    readonly port: number;
    isConnected(): boolean;
    exec(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult>;
}
/** Validate a working directory before it is embedded in a command. */
export declare function validateRemoteDirectory(dir: string): string;
/** Validate a ref/branch/tag name so it can be passed as a single argument. */
export declare function validateGitRef(ref: string): string;
//# sourceMappingURL=remote-session.d.ts.map