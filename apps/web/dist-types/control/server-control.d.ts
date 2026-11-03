import type { RemoteSession } from '../session/remote-session.js';
export interface ServerMetrics {
    /** CPU busy percentage over the sample window, or null when /proc is unavailable. */
    cpuPercent: number | null;
    loadAverage: [number, number, number] | null;
    memory: {
        totalMiB: number;
        usedMiB: number;
        availableMiB: number;
        swapUsedMiB: number;
    } | null;
    disks: Array<{
        mount: string;
        sizeKiB: number;
        usedKiB: number;
        availableKiB: number;
        usedPercent: number;
    }>;
    uptimeSeconds: number | null;
    /** Network receive/transmit in KiB/s over the sample window. */
    network: {
        rxKiBps: number;
        txKiBps: number;
    } | null;
    /** Kernel reports pending reboot (Debian/Ubuntu). */
    rebootRequired: boolean | null;
    collectedAt: number;
}
export interface RemoteProcess {
    pid: number;
    user: string;
    cpuPercent: number;
    memoryPercent: number;
    elapsed: string;
    command: string;
}
export interface RemoteService {
    name: string;
    load: string;
    active: string;
    sub: string;
    description: string;
}
/**
 * One script, one connection round trip. `sleep` gives a real CPU/network delta
 * instead of a lifetime average that never moves.
 */
export declare function buildMetricsScript(): string;
export declare function parseMetricsOutput(stdout: string, collectedAt?: number): ServerMetrics;
export declare function sampleMetrics(session: RemoteSession): Promise<ServerMetrics>;
export declare function parseProcessList(stdout: string): RemoteProcess[];
export declare function listProcesses(session: RemoteSession, limit?: number): Promise<RemoteProcess[]>;
export declare function parseServiceList(stdout: string): RemoteService[];
export declare function listServices(session: RemoteSession): Promise<RemoteService[]>;
export type ServiceAction = 'start' | 'stop' | 'restart';
/**
 * Actions run through `sudo -n` only. Without passwordless sudo the command
 * fails fast and the UI reports the privilege requirement instead of hanging on
 * a prompt that the browser cannot answer.
 */
export declare function controlService(session: RemoteSession, name: string, action: ServiceAction, asRoot: boolean): Promise<string>;
export declare function serviceLogs(session: RemoteSession, name: string, lines?: number): Promise<string>;
export declare function rebootRequiredPackages(session: RemoteSession): Promise<string[]>;
/**
 * Reboot or power off the server. Both are accepted only from a UI that has
 * already required an explicit typed confirmation; the command fails fast when
 * passwordless sudo is not configured.
 */
export declare function powerAction(session: RemoteSession, action: 'reboot' | 'poweroff', asRoot: boolean): Promise<string>;
//# sourceMappingURL=server-control.d.ts.map