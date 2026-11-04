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
        offset?: number;
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
    /** Read a file through SFTP as text; absent when the transport cannot do it. */
    readFile?(path: string): Promise<string>;
    /** List a directory through SFTP; absent when the transport cannot do it. */
    listDir?(path: string): Promise<SftpEntryInfo[]>;
    /** Rename or move a path through SFTP. */
    renamePath?(from: string, to: string): Promise<void>;
    /** Delete a single file through SFTP. Never used on directories. */
    removePath?(path: string): Promise<void>;
    /** Create a directory through SFTP. */
    makeDir?(path: string): Promise<void>;
    /** Probe the SFTP subsystem without performing an operation. */
    probeSftp?(): Promise<boolean>;
    /** Streaming exec, exposed for recipe verification. Absent on plain execCommand clients. */
    execStream?(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult>;
}
/** The entry fields the in-app IDE needs; extra transport fields are ignored. */
export interface SftpEntryInfo {
    name: string;
    path: string;
    isDir: boolean;
    isSymlink: boolean;
    size: number;
    modTime: number;
}
export declare function createRemoteSession(client: RelayLikeClient, options: AdapterOptions): WorkspaceRemoteSession;
//# sourceMappingURL=adapters.d.ts.map