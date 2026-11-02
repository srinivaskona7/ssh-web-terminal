export interface ServerVitalsSnapshot {
    cpuPercent: number;
    ramUsedGiB: number;
    ramTotalGiB: number;
    diskIoMbps: number;
    netRxMbps: number;
    netTxMbps: number;
    loadAvg: [number, number, number];
}
export interface RemoteProcessEntry {
    pid: number;
    user: string;
    cpuPercent: number;
    memPercent: number;
    command: string;
    state: 'running' | 'sleeping' | 'stopped';
}
export interface RemoteContainerEntry {
    id: string;
    name: string;
    image: string;
    runtime: 'docker' | 'k8s';
    status: 'Running' | 'Restarting';
    ports: string;
}
export interface ListeningPortEntry {
    proto: 'tcp' | 'udp';
    bindAddress: string;
    port: number;
    pid: number;
    process: string;
    webPreviewable: boolean;
}
export type TunnelType = 'L' | 'R' | 'D';
export interface SshTunnelRule {
    id: string;
    name: string;
    type: TunnelType;
    bindAddress: string;
    localPort: number;
    remoteHost: string;
    remotePort: number;
    active: boolean;
    bytesTransferred: number;
}
export interface CommandBlockEntry {
    id: string;
    command: string;
    outputLines: string[];
    timestamp: string;
    durationMs: number;
    exitCode: number;
    collapsed: boolean;
}
export interface ChmodPermissions {
    ownerRead: boolean;
    ownerWrite: boolean;
    ownerExec: boolean;
    groupRead: boolean;
    groupWrite: boolean;
    groupExec: boolean;
    publicRead: boolean;
    publicWrite: boolean;
    publicExec: boolean;
}
export interface DiffLineEntry {
    lineNumber: number;
    before: string;
    after: string;
    status: 'unchanged' | 'modified' | 'added' | 'removed';
}
export interface SshCertificateInfo {
    keyId: string;
    certType: 'user' | 'host';
    principals: string[];
    validAfter: string;
    validBefore: string;
    caFingerprint: string;
    extensions: string[];
}
export interface PlaybookHostResult {
    hostAlias: string;
    hostAddress: string;
    exitCode: number;
    durationMs: number;
    output: string;
}
export declare function computeGhostAutocomplete(currentInput: string, history?: readonly string[]): string;
export interface DangerousCommandCheck {
    dangerous: boolean;
    reason: string;
}
export declare function detectDangerousCommand(command: string): DangerousCommandCheck;
export declare function redactSecretsInText(text: string, enabled: boolean): string;
export declare function formatChmodOctal(perms: ChmodPermissions): {
    octal: string;
    symbolic: string;
};
export declare function computeSideBySideDiff(originalText: string, modifiedText: string): DiffLineEntry[];
export declare const DATABASE_TUNNEL_TEMPLATES: readonly Omit<SshTunnelRule, 'id'>[];
//# sourceMappingURL=advanced-features.d.ts.map