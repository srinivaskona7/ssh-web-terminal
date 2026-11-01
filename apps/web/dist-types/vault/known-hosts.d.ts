export interface KnownHostRecord {
    hostPort: string;
    host: string;
    port: number;
    keyType: string;
    fingerprint: string;
    publicKeyBase64: string;
    firstSeenAt: number;
    lastVerifiedAt: number;
}
export type HostKeyVerificationResult = {
    status: 'trusted';
    record: KnownHostRecord;
} | {
    status: 'unknown_tofu';
    host: string;
    port: number;
    keyType: string;
    fingerprint: string;
    publicKeyBase64: string;
} | {
    status: 'mismatch';
    host: string;
    port: number;
    keyType: string;
    expectedFingerprint: string;
    receivedFingerprint: string;
    existingRecord: KnownHostRecord;
};
export declare class KnownHostsStore {
    private records;
    static formatKey(host: string, port: number): string;
    loadRecords(items: KnownHostRecord[]): void;
    exportRecords(): KnownHostRecord[];
    verify(host: string, port: number, keyType: string, fingerprint: string, publicKeyBase64: string): HostKeyVerificationResult;
    trustNewHost(host: string, port: number, keyType: string, fingerprint: string, publicKeyBase64: string): KnownHostRecord;
    revokeHost(host: string, port: number): boolean;
}
//# sourceMappingURL=known-hosts.d.ts.map