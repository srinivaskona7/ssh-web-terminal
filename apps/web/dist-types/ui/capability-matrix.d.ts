/**
 * Honest capability matrix shown in the workspace.
 *
 * `verified` means a unit or integration test in this repository exercises the
 * behaviour. `implemented` means the code path exists but has not been proven
 * against a real server in this build. `conditional` needs a prerequisite the
 * UI cannot supply (the Go gateway, passwordless sudo, a package, a cluster).
 * `unsupported` is deliberate: the product does not attempt it.
 */
export type CapabilityStatus = 'verified' | 'implemented' | 'conditional' | 'unsupported';
export interface CapabilityEntry {
    id: string;
    name: string;
    category: 'Connection & identity' | 'Terminal' | 'Files & editor' | 'Discovery & install' | 'Operations' | 'Automation & delivery';
    status: CapabilityStatus;
    detail: string;
    /** What the user must have or do for this to work. */
    requires?: string;
}
export declare const CAPABILITY_MATRIX: readonly CapabilityEntry[];
export declare function capabilityCounts(entries?: readonly CapabilityEntry[]): Record<CapabilityStatus, number>;
//# sourceMappingURL=capability-matrix.d.ts.map