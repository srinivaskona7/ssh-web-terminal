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

export type HostKeyVerificationResult =
  | { status: 'trusted'; record: KnownHostRecord }
  | {
      status: 'unknown_tofu';
      host: string;
      port: number;
      keyType: string;
      fingerprint: string;
      publicKeyBase64: string;
    }
  | {
      status: 'mismatch';
      host: string;
      port: number;
      keyType: string;
      expectedFingerprint: string;
      receivedFingerprint: string;
      existingRecord: KnownHostRecord;
    };

export class KnownHostsStore {
  private records = new Map<string, KnownHostRecord>();

  static formatKey(host: string, port: number): string {
    const cleanHost = host.trim().toLowerCase();
    return port === 22 ? cleanHost : `[${cleanHost}]:${port}`;
  }

  loadRecords(items: KnownHostRecord[]): void {
    this.records.clear();
    for (const item of items) {
      this.records.set(item.hostPort, { ...item });
    }
  }

  exportRecords(): KnownHostRecord[] {
    return Array.from(this.records.values()).map((r) => ({ ...r }));
  }

  verify(
    host: string,
    port: number,
    keyType: string,
    fingerprint: string,
    publicKeyBase64: string
  ): HostKeyVerificationResult {
    const key = KnownHostsStore.formatKey(host, port);
    const existing = this.records.get(key);
    if (!existing) {
      return {
        status: 'unknown_tofu',
        host,
        port,
        keyType,
        fingerprint,
        publicKeyBase64
      };
    }

    if (existing.fingerprint !== fingerprint || existing.keyType !== keyType) {
      return {
        status: 'mismatch',
        host,
        port,
        keyType,
        expectedFingerprint: existing.fingerprint,
        receivedFingerprint: fingerprint,
        existingRecord: { ...existing }
      };
    }

    existing.lastVerifiedAt = Date.now();
    return {
      status: 'trusted',
      record: { ...existing }
    };
  }

  trustNewHost(
    host: string,
    port: number,
    keyType: string,
    fingerprint: string,
    publicKeyBase64: string
  ): KnownHostRecord {
    const key = KnownHostsStore.formatKey(host, port);
    const existing = this.records.get(key);
    if (existing && (existing.fingerprint !== fingerprint || existing.keyType !== keyType)) {
      throw new Error(
        `Host key mismatch for ${key}: must explicitly revoke old key (${existing.fingerprint}) before trusting new key`
      );
    }
    const now = Date.now();
    const record: KnownHostRecord = {
      hostPort: key,
      host: host.trim().toLowerCase(),
      port,
      keyType,
      fingerprint,
      publicKeyBase64,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastVerifiedAt: now
    };
    this.records.set(key, record);
    return { ...record };
  }

  revokeHost(host: string, port: number): boolean {
    const key = KnownHostsStore.formatKey(host, port);
    return this.records.delete(key);
  }
}
