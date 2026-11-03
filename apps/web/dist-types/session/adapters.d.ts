/**
 * Normalise the two transports (browser SSH over the Cloudflare relay, and the
 * Go gateway) into the single `RemoteSession` contract used by the workspace
 * modules (discovery, recipes, containers, Kubernetes, automation).
 */
import type { RemoteExecOptions, RemoteExecResult, RemoteSession } from './remote-session.js';
/** The subset of the relay client this adapter needs. */
export interface RelayLikeClient {
    execStream?(command: string, options?: RemoteExecOptions): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
    execCommand(command: string, timeoutMs?: number): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
    sftpOp?(op: Record<string, unknown>): Promise<{
        ok: boolean;
        error?: string;
        dataBase64?: string;
        size?: number;
    }>;
    isConnected?: boolean;
    getSftpClient?(): Promise<unknown>;
}
export interface AdapterOptions {
    transport: 'cloudflare-relay' | 'go-gateway';
    host: string;
    user: string;
    port: number;
    isConnected?: () => boolean;
}
export interface WorkspaceRemoteSession extends RemoteSession {
    /** Write a file through SFTP; absent when the transport cannot do it. */
    writeFile?(path: string, data: Uint8Array): Promise<void>;
    /** Probe the SFTP subsystem without performing an operation. */
    probeSftp?(): Promise<boolean>;
    /** Streaming exec, exposed for recipe verification. Absent on plain execCommand clients. */
    execStream?(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult>;
}
export declare function createRemoteSession(client: RelayLikeClient, options: AdapterOptions): WorkspaceRemoteSession;
//# sourceMappingURL=adapters.d.ts.map