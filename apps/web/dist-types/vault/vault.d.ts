import type { ControlMessage } from '@webssh/protocol';
import { type SshKeyAlgorithm } from './ssh-wire.js';
import { KnownHostsStore } from './known-hosts.js';
export interface VaultKeyMetadata {
    id: string;
    name: string;
    algorithm: SshKeyAlgorithm;
    authorizedKeyLine: string;
    publicKeyWireBase64: string;
    fingerprintSHA256: string;
    createdAt: number;
}
export interface VaultKeyRecord extends VaultKeyMetadata {
    privateKey: CryptoKey;
    publicKey?: CryptoKey;
}
export interface EncryptedEnvelope {
    kdf: 'argon2id-webcrypto-v1';
    saltBase64: string;
    ivBase64: string;
    ciphertextBase64: string;
}
/**
 * Derives an AES-256-GCM wrapping key from a user passphrase and 16-byte salt.
 * Combines memory-hard 64 KiB block mixing with PBKDF2-HMAC-SHA256 for browser compatibility without WASM/CDN dependencies.
 */
export declare function deriveVaultAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey>;
export declare function encryptJsonEnvelope<T>(data: T, aesKey: CryptoKey, salt: Uint8Array): Promise<EncryptedEnvelope>;
export declare function decryptJsonEnvelope<T>(envelope: EncryptedEnvelope, aesKey: CryptoKey): Promise<T>;
export declare class KeyVault {
    private dbPromise;
    private aesKey;
    private salt;
    private unlockedKeys;
    private autoLockMs;
    private autoLockTimer;
    readonly knownHosts: KnownHostsStore;
    constructor(autoLockMs?: number);
    private getDb;
    isUnlocked(): boolean;
    setAutoLockTimeoutMs(ms: number): void;
    touchActivity(): void;
    private resetAutoLockTimer;
    lock(): void;
    initializeOrUnlock(passphrase: string): Promise<void>;
    saveKnownHosts(): Promise<void>;
    private ensureUnlocked;
    generateKeyPair(name: string, preferredAlgorithm?: SshKeyAlgorithm): Promise<VaultKeyRecord>;
    importOpenSshEd25519Key(name: string, pemText: string): Promise<VaultKeyRecord>;
    listKeys(): VaultKeyMetadata[];
    getKeyRecord(id: string): VaultKeyRecord | undefined;
    deleteKey(id: string): Promise<void>;
    /**
     * Signs an SSH authentication challenge payload from the Go gateway (`sign_request` -> `sign_response`).
     * For ECDSA P-256, converts WebCrypto's 64-byte IEEE-P1363 (r || s) output into SSH mpint wire format.
     */
    signChallenge(keyId: string, challengeBytes: Uint8Array): Promise<{
        signatureSshBlob: Uint8Array;
        rawWebCryptoSignature: Uint8Array;
    }>;
    getAuthorizedKeysCommand(keyId: string): string;
    /**
     * Builds a one-time key deployment (`ssh-copy-id` equivalent) control message without storing the password.
     */
    buildOneTimeDeployMessage(params: {
        keyId: string;
        ephemeralPassword: string;
    }): Extract<ControlMessage, {
        type: 'deploy_key';
    }>;
}
//# sourceMappingURL=vault.d.ts.map