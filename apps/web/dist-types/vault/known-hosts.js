export class KnownHostsStore {
    records = new Map();
    static formatKey(host, port) {
        const cleanHost = host.trim().toLowerCase();
        return port === 22 ? cleanHost : `[${cleanHost}]:${port}`;
    }
    loadRecords(items) {
        this.records.clear();
        for (const item of items) {
            this.records.set(item.hostPort, { ...item });
        }
    }
    exportRecords() {
        return Array.from(this.records.values()).map((r) => ({ ...r }));
    }
    verify(host, port, keyType, fingerprint, publicKeyBase64) {
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
    trustNewHost(host, port, keyType, fingerprint, publicKeyBase64) {
        const key = KnownHostsStore.formatKey(host, port);
        const existing = this.records.get(key);
        if (existing && (existing.fingerprint !== fingerprint || existing.keyType !== keyType)) {
            throw new Error(`Host key mismatch for ${key}: must explicitly revoke old key (${existing.fingerprint}) before trusting new key`);
        }
        const now = Date.now();
        const record = {
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
    revokeHost(host, port) {
        const key = KnownHostsStore.formatKey(host, port);
        return this.records.delete(key);
    }
}
//# sourceMappingURL=known-hosts.js.map