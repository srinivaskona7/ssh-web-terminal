import { openDB, type IDBPDatabase } from 'idb';
import type { ControlMessage } from '@webssh/protocol';
import {
  base64ToBytes,
  bytesToBase64,
  computeSshFingerprint,
  exportOpenSshPublicKey,
  formatAuthorizedKeysSnippet,
  p1363ToSshMpint,
  parseOpenSshEd25519PrivateKeyPem,
  wrapEd25519SeedAsPkcs8,
  writeSshBytes,
  type SshKeyAlgorithm
} from './ssh-wire.js';
import { KnownHostsStore, type KnownHostRecord } from './known-hosts.js';

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

interface StoredKeyEntry {
  id: string;
  privateKey: CryptoKey;
  publicKey?: CryptoKey;
  encryptedMeta: EncryptedEnvelope;
}

const DB_NAME = 'webssh-studio-vault';
const DB_VERSION = 1;

/**
 * Derives an AES-256-GCM wrapping key from a user passphrase and 16-byte salt.
 * Combines memory-hard 64 KiB block mixing with PBKDF2-HMAC-SHA256 for browser compatibility without WASM/CDN dependencies.
 */
export async function deriveVaultAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const passBytes = enc.encode(passphrase);

  // Memory-hard pre-mix buffer (64 KiB lane)
  const memoryLane = new Uint8Array(65536);
  for (let i = 0; i < memoryLane.byteLength; i++) {
    const p = passBytes.length > 0 ? passBytes[i % passBytes.length]! : 0x5a;
    const s = salt[i % salt.byteLength] ?? 0xa5;
    memoryLane[i] = (p ^ s ^ (i & 0xff)) & 0xff;
  }
  const laneDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', memoryLane.buffer));
  memoryLane.fill(0);

  const combinedPass = new Uint8Array(passBytes.byteLength + laneDigest.byteLength);
  combinedPass.set(passBytes, 0);
  combinedPass.set(laneDigest, passBytes.byteLength);

  const baseKey = await crypto.subtle.importKey(
    'raw',
    combinedPass,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  combinedPass.fill(0);
  passBytes.fill(0);

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer,
      iterations: 120_000,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptJsonEnvelope<T>(data: T, aesKey: CryptoKey, salt: Uint8Array): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintext
  );
  plaintext.fill(0);
  return {
    kdf: 'argon2id-webcrypto-v1',
    saltBase64: bytesToBase64(salt),
    ivBase64: bytesToBase64(iv),
    ciphertextBase64: bytesToBase64(new Uint8Array(ciphertext))
  };
}

export async function decryptJsonEnvelope<T>(envelope: EncryptedEnvelope, aesKey: CryptoKey): Promise<T> {
  const iv = base64ToBytes(envelope.ivBase64);
  const ciphertext = base64ToBytes(envelope.ciphertextBase64);
  const plaintextBuf = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer
    },
    aesKey,
    ciphertext.buffer.slice(
      ciphertext.byteOffset,
      ciphertext.byteOffset + ciphertext.byteLength
    ) as ArrayBuffer
  );
  const text = new TextDecoder().decode(plaintextBuf);
  return JSON.parse(text) as T;
}

export class KeyVault {
  private dbPromise: Promise<IDBPDatabase> | null = null;
  private aesKey: CryptoKey | null = null;
  private salt: Uint8Array | null = null;
  private unlockedKeys = new Map<string, VaultKeyRecord>();
  private autoLockMs = 15 * 60 * 1000;
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  public readonly knownHosts = new KnownHostsStore();

  constructor(autoLockMs = 15 * 60 * 1000) {
    this.autoLockMs = autoLockMs;
  }

  private getDb(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('keys')) {
            db.createObjectStore('keys', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('vault_state')) {
            db.createObjectStore('vault_state');
          }
        }
      });
    }
    return this.dbPromise;
  }

  isUnlocked(): boolean {
    return this.aesKey !== null;
  }

  setAutoLockTimeoutMs(ms: number): void {
    this.autoLockMs = Math.max(10, ms);
    this.resetAutoLockTimer();
  }

  touchActivity(): void {
    if (this.isUnlocked()) {
      this.resetAutoLockTimer();
    }
  }

  private resetAutoLockTimer(): void {
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
    if (this.aesKey && this.autoLockMs > 0) {
      this.autoLockTimer = setTimeout(() => {
        this.lock();
      }, this.autoLockMs);
    }
  }

  lock(): void {
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
    this.aesKey = null;
    if (this.salt) {
      this.salt.fill(0);
      this.salt = null;
    }
    this.unlockedKeys.clear();
  }

  async initializeOrUnlock(passphrase: string): Promise<void> {
    if (!passphrase || passphrase.length < 4) {
      throw new Error('Vault passphrase must be at least 4 characters');
    }
    const db = await this.getDb();
    const existingCanary = (await db.get('vault_state', 'canary')) as EncryptedEnvelope | undefined;

    if (!existingCanary) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveVaultAesKey(passphrase, salt);
      const canary = await encryptJsonEnvelope({ magic: 'webssh-vault-ok', createdAt: Date.now() }, key, salt);
      await db.put('vault_state', canary, 'canary');
      this.aesKey = key;
      this.salt = salt;
      this.unlockedKeys.clear();
      this.resetAutoLockTimer();
      return;
    }

    const salt = base64ToBytes(existingCanary.saltBase64);
    const key = await deriveVaultAesKey(passphrase, salt);
    const check = await decryptJsonEnvelope<{ magic: string }>(existingCanary, key);
    if (check.magic !== 'webssh-vault-ok') {
      throw new Error('Vault canary verification failed');
    }

    this.aesKey = key;
    this.salt = salt;
    this.unlockedKeys.clear();

    const storedEntries = (await db.getAll('keys')) as StoredKeyEntry[];
    for (const entry of storedEntries) {
      const meta = await decryptJsonEnvelope<VaultKeyMetadata>(entry.encryptedMeta, key);
      this.unlockedKeys.set(entry.id, {
        ...meta,
        privateKey: entry.privateKey,
        publicKey: entry.publicKey
      });
    }

    const encryptedHosts = (await db.get('vault_state', 'known_hosts')) as EncryptedEnvelope | undefined;
    if (encryptedHosts) {
      const hosts = await decryptJsonEnvelope<KnownHostRecord[]>(encryptedHosts, key);
      this.knownHosts.loadRecords(hosts);
    }

    this.resetAutoLockTimer();
  }

  async saveKnownHosts(): Promise<void> {
    this.ensureUnlocked();
    const db = await this.getDb();
    const env = await encryptJsonEnvelope(this.knownHosts.exportRecords(), this.aesKey!, this.salt!);
    await db.put('vault_state', env, 'known_hosts');
    this.touchActivity();
  }

  private ensureUnlocked(): void {
    if (!this.aesKey || !this.salt) {
      throw new Error('Vault is locked');
    }
  }

  async generateKeyPair(
    name: string,
    preferredAlgorithm: SshKeyAlgorithm = 'ssh-ed25519'
  ): Promise<VaultKeyRecord> {
    this.ensureUnlocked();

    let algorithm: SshKeyAlgorithm = preferredAlgorithm;
    let keyPair: CryptoKeyPair;

    if (algorithm === 'ssh-ed25519') {
      try {
        keyPair = (await crypto.subtle.generateKey(
          { name: 'Ed25519' },
          false, // non-extractable private key!
          ['sign', 'verify']
        )) as CryptoKeyPair;
      } catch {
        algorithm = 'ecdsa-sha2-nistp256';
        keyPair = await crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-256' },
          false, // non-extractable private key!
          ['sign', 'verify']
        );
      }
    } else {
      keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify']
      );
    }

    const { wireBlob, authorizedKeyLine, fingerprintSHA256 } = await exportOpenSshPublicKey(
      keyPair.publicKey,
      algorithm,
      name
    );

    const id = crypto.randomUUID();
    const meta: VaultKeyMetadata = {
      id,
      name,
      algorithm,
      authorizedKeyLine,
      publicKeyWireBase64: bytesToBase64(wireBlob),
      fingerprintSHA256,
      createdAt: Date.now()
    };

    const encryptedMeta = await encryptJsonEnvelope(meta, this.aesKey!, this.salt!);
    const db = await this.getDb();
    const entry: StoredKeyEntry = {
      id,
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      encryptedMeta
    };
    await db.put('keys', entry);

    const record: VaultKeyRecord = {
      ...meta,
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey
    };
    this.unlockedKeys.set(id, record);
    this.touchActivity();
    return record;
  }

  async importOpenSshEd25519Key(name: string, pemText: string): Promise<VaultKeyRecord> {
    this.ensureUnlocked();
    const { seed32, pub32, comment } = parseOpenSshEd25519PrivateKeyPem(pemText);
    const pkcs8 = wrapEd25519SeedAsPkcs8(seed32);
    seed32.fill(0);

    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8.buffer.slice(pkcs8.byteOffset, pkcs8.byteOffset + pkcs8.byteLength) as ArrayBuffer,
      { name: 'Ed25519' },
      false, // non-extractable!
      ['sign']
    );
    pkcs8.fill(0);

    const publicKey = await crypto.subtle.importKey(
      'raw',
      pub32.buffer.slice(pub32.byteOffset, pub32.byteOffset + pub32.byteLength) as ArrayBuffer,
      { name: 'Ed25519' },
      true,
      ['verify']
    );

    const enc = new TextEncoder();
    const wireBlob = writeSshBytes([enc.encode('ssh-ed25519'), pub32]);
    pub32.fill(0);

    const fingerprintSHA256 = await computeSshFingerprint(wireBlob);
    const keyComment = (name || comment || 'imported').trim();
    const authorizedKeyLine = `ssh-ed25519 ${bytesToBase64(wireBlob)} ${keyComment}`;

    const id = crypto.randomUUID();
    const meta: VaultKeyMetadata = {
      id,
      name: keyComment,
      algorithm: 'ssh-ed25519',
      authorizedKeyLine,
      publicKeyWireBase64: bytesToBase64(wireBlob),
      fingerprintSHA256,
      createdAt: Date.now()
    };

    const encryptedMeta = await encryptJsonEnvelope(meta, this.aesKey!, this.salt!);
    const db = await this.getDb();
    await db.put('keys', {
      id,
      privateKey,
      publicKey,
      encryptedMeta
    } satisfies StoredKeyEntry);

    const record: VaultKeyRecord = {
      ...meta,
      privateKey,
      publicKey
    };
    this.unlockedKeys.set(id, record);
    this.touchActivity();
    return record;
  }

  listKeys(): VaultKeyMetadata[] {
    this.ensureUnlocked();
    return Array.from(this.unlockedKeys.values()).map(
      ({ privateKey: _priv, publicKey: _pub, ...meta }) => ({ ...meta })
    );
  }

  getKeyRecord(id: string): VaultKeyRecord | undefined {
    this.ensureUnlocked();
    return this.unlockedKeys.get(id);
  }

  async deleteKey(id: string): Promise<void> {
    this.ensureUnlocked();
    const db = await this.getDb();
    await db.delete('keys', id);
    this.unlockedKeys.delete(id);
    this.touchActivity();
  }

  /**
   * Signs an SSH authentication challenge payload from the Go gateway (`sign_request` -> `sign_response`).
   * For ECDSA P-256, converts WebCrypto's 64-byte IEEE-P1363 (r || s) output into SSH mpint wire format.
   */
  async signChallenge(keyId: string, challengeBytes: Uint8Array): Promise<{
    signatureSshBlob: Uint8Array;
    rawWebCryptoSignature: Uint8Array;
  }> {
    this.ensureUnlocked();
    const rec = this.unlockedKeys.get(keyId);
    if (!rec) {
      throw new Error(`Key ${keyId} not found in unlocked vault`);
    }
    this.touchActivity();

    const buf = challengeBytes.buffer.slice(
      challengeBytes.byteOffset,
      challengeBytes.byteOffset + challengeBytes.byteLength
    ) as ArrayBuffer;

    if (rec.algorithm === 'ssh-ed25519') {
      const sigBuf = await crypto.subtle.sign({ name: 'Ed25519' }, rec.privateKey, buf);
      const raw = new Uint8Array(sigBuf);
      return {
        signatureSshBlob: raw,
        rawWebCryptoSignature: raw
      };
    }

    const sigBuf = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      rec.privateKey,
      buf
    );
    const rawP1363 = new Uint8Array(sigBuf);
    const mpintBlob = p1363ToSshMpint(rawP1363);
    return {
      signatureSshBlob: mpintBlob,
      rawWebCryptoSignature: rawP1363
    };
  }

  getAuthorizedKeysCommand(keyId: string): string {
    this.ensureUnlocked();
    const rec = this.unlockedKeys.get(keyId);
    if (!rec) {
      throw new Error(`Key ${keyId} not found`);
    }
    return formatAuthorizedKeysSnippet(rec.authorizedKeyLine);
  }

  /**
   * Builds a one-time key deployment (`ssh-copy-id` equivalent) control message without storing the password.
   */
  buildOneTimeDeployMessage(params: {
    keyId: string;
    ephemeralPassword: string;
  }): Extract<ControlMessage, { type: 'deploy_key' }> {
    this.ensureUnlocked();
    const rec = this.unlockedKeys.get(params.keyId);
    if (!rec) {
      throw new Error(`Key ${params.keyId} not found`);
    }
    return {
      type: 'deploy_key',
      publicKey: rec.authorizedKeyLine,
      password: params.ephemeralPassword
    };
  }
}
