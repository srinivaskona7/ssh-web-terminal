/**
 * Server discovery and the typed capability model.
 *
 * Discovery is read-only: it never installs packages, edits configuration or
 * reads secret files. Everything here is derived from a single bounded POSIX
 * `sh` script whose output is parsed locally.
 */
export type CapabilityState = 'available' | 'installed' | 'outdated' | 'unsupported' | 'insufficient_resources' | 'requires_privilege' | 'requires_configuration';
export interface ToolCapability {
    id: string;
    name: string;
    state: CapabilityState;
    /** First version-looking token reported by the tool. */
    version?: string;
    path?: string;
    detail?: string;
}
export interface DiskUsage {
    mount: string;
    filesystem: string;
    totalMiB: number;
    usedMiB: number;
    availableMiB: number;
    usePercent: number;
}
export interface ListenerEntry {
    protocol: string;
    address: string;
    port: number;
    process?: string;
}
export interface ServerCapabilities {
    schemaVersion: 1;
    collectedAt: number;
    hostname: string;
    os: {
        family: string;
        distro: string;
        version: string;
        kernel: string;
        arch: string;
        virtualization?: string;
    };
    cpu: {
        cores: number;
        model: string;
    };
    memory: {
        totalMiB: number;
        availableMiB: number;
        swapMiB: number;
    };
    disks: DiskUsage[];
    user: {
        name: string;
        uid: number;
        groups: string[];
        shell: string;
        home: string;
        isRoot: boolean;
    };
    privilege: {
        /** `sudo` exists on PATH. */
        sudoAvailable: boolean;
        /** `sudo -n true` succeeded — privileged operations work without a prompt. */
        sudoNopasswd: boolean;
        /** Effective uid is 0. */
        isRoot: boolean;
    };
    packages: {
        manager: string | null;
        repositories: 'configured' | 'unconfigured' | 'unknown';
    };
    init: {
        manager: string | null;
        systemd: boolean;
    };
    tools: Record<string, ToolCapability>;
    listeners: ListenerEntry[];
    firewall: {
        tool: string | null;
        active: boolean | null;
    };
    time: {
        synchronized: boolean | null;
        detail: string;
    };
    warnings: string[];
}
/** Tools probed by name. Order is stable so the UI does not jump around. */
export declare const PROBED_TOOLS: ReadonlyArray<{
    id: string;
    name: string;
    category: string;
}>;
/**
 * Single read-only probe. Every external command is either a builtin or a
 * tool invoked with a version flag; nothing mutates state. The script is
 * static — no user input is interpolated.
 */
export declare function buildDiscoveryScript(): string;
export interface DiscoveryHints {
    /** The `sftp` subsystem was reachable on this host. */
    sftpAvailable?: boolean;
    /** Whether the SSH user can run `sudo` non-interactively. */
    sudoNopasswd?: boolean;
}
export declare function parseCapabilities(stdout: string, hints?: DiscoveryHints): ServerCapabilities;
/** Minimal shape the capability checks need from a live session. */
export interface CapabilityExec {
    execCommand(command: string, timeoutMs?: number): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
    getSftpClient(): Promise<unknown>;
}
/**
 * Run discovery against a live SSH session. Bounded to 20s and 4 MiB of
 * output; failures return a capabilities object carrying explicit warnings
 * rather than throwing — the workspace still works without discovery.
 */
export declare function discoverServer(session: CapabilityExec, hints?: DiscoveryHints): Promise<ServerCapabilities>;
//# sourceMappingURL=capabilities.d.ts.map