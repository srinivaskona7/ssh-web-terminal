import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  KeyVault,
  KnownHostsStore,
  encodeOpenSshEd25519PrivateKeyPem,
  formatAuthorizedKeysSnippet,
  p1363ToSshMpint,
  sshMpintToP1363,
  validateAndInspectPrivateKeyPem,
  wrapEd25519SeedAsPkcs8
} from './index.js';

describe('Vault & Remote-Signer Auth (M3)', () => {
  it('generates non-extractable Ed25519 and ECDSA P-256 keys and signs challenges', async () => {
    const vault = new KeyVault(60_000);
    await vault.initializeOrUnlock('correct-horse-battery-staple');
    expect(vault.isUnlocked()).toBe(true);

    const edKey = await vault.generateKeyPair('prod-ed25519', 'ssh-ed25519');
    expect(edKey.privateKey.extractable).toBe(false);
    expect(edKey.authorizedKeyLine).toContain('prod-ed25519');
    expect(edKey.fingerprintSHA256.startsWith('SHA256:')).toBe(true);

    const ecdsaKey = await vault.generateKeyPair('prod-ecdsa', 'ecdsa-sha2-nistp256');
    expect(ecdsaKey.privateKey.extractable).toBe(false);
    expect(ecdsaKey.algorithm).toBe('ecdsa-sha2-nistp256');

    const challenge = new TextEncoder().encode('ssh-connection-session-challenge-payload');
    const edSig = await vault.signChallenge(edKey.id, challenge);
    expect(edSig.signatureSshBlob.byteLength).toBeGreaterThan(0);

    const ecdsaSig = await vault.signChallenge(ecdsaKey.id, challenge);
    expect(ecdsaSig.rawWebCryptoSignature.byteLength).toBe(64);
    const roundTrip = sshMpintToP1363(ecdsaSig.signatureSshBlob);
    expect(Array.from(roundTrip)).toEqual(Array.from(ecdsaSig.rawWebCryptoSignature));

    const cmd = vault.getAuthorizedKeysCommand(edKey.id);
    expect(cmd).toContain('~/.ssh/authorized_keys');
    expect(formatAuthorizedKeysSnippet("ssh-ed25519 AAAA user's-key")).toContain('chmod 600');

    const deployMsg = vault.buildOneTimeDeployMessage({
      keyId: edKey.id,
      ephemeralPassword: 'one-time-password'
    });
    expect(deployMsg.type).toBe('deploy_key');
    expect(deployMsg.publicKey).toBe(edKey.authorizedKeyLine);
  });

  it('imports OpenSSH Ed25519 private keys as non-extractable CryptoKeys', async () => {
    const vault = new KeyVault(60_000);
    await vault.initializeOrUnlock('correct-horse-battery-staple');

    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = i + 1;
    const pkcs8 = wrapEd25519SeedAsPkcs8(seed);
    const tempPriv = await crypto.subtle.importKey('pkcs8', pkcs8.buffer as ArrayBuffer, { name: 'Ed25519' }, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', tempPriv);
    const b64Url = jwk.x!;
    const b64 = b64Url.replace(/-/g, '+').replace(/_/g, '/');
    const pubRaw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

    const pem = encodeOpenSshEd25519PrivateKeyPem(seed, pubRaw, 'imported-ed25519');
    const imported = await vault.importOpenSshEd25519Key('imported-ed25519', pem);
    expect(imported.privateKey.extractable).toBe(false);
    expect(imported.algorithm).toBe('ssh-ed25519');

    const sig = await vault.signChallenge(imported.id, new Uint8Array([1, 2, 3, 4]));
    expect(sig.signatureSshBlob.byteLength).toBe(64);
  });

  it('round-trips arbitrary valid 64-byte IEEE-P1363 signatures to SSH mpint format', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }).filter((arr) => arr.some((b) => b !== 0)),
        fc.uint8Array({ minLength: 32, maxLength: 32 }).filter((arr) => arr.some((b) => b !== 0)),
        (r, s) => {
          const p1363 = new Uint8Array(64);
          p1363.set(r, 0);
          p1363.set(s, 32);
          const sshBlob = p1363ToSshMpint(p1363);
          const decoded = sshMpintToP1363(sshBlob);
          expect(Array.from(decoded)).toEqual(Array.from(p1363));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('enforces passphrase lock, wrong passphrase rejection, and idle auto-lock', async () => {
    const vault = new KeyVault(30);
    await vault.initializeOrUnlock('correct-horse-battery-staple');
    expect(vault.isUnlocked()).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    expect(vault.isUnlocked()).toBe(false);
    expect(() => vault.listKeys()).toThrow('Vault is locked');

    await expect(vault.initializeOrUnlock('wrong-passphrase')).rejects.toThrow();
    vault.setAutoLockTimeoutMs(60_000);
    await vault.initializeOrUnlock('correct-horse-battery-staple');
    expect(vault.isUnlocked()).toBe(true);
  });

  it('enforces TOFU host-key verification and blocks mismatches until revoked', () => {
    const store = new KnownHostsStore();

    const first = store.verify('prod.example.com', 22, 'ssh-ed25519', 'SHA256:aaa111', 'AAAA111');
    expect(first.status).toBe('unknown_tofu');

    store.trustNewHost('prod.example.com', 22, 'ssh-ed25519', 'SHA256:aaa111', 'AAAA111');

    const second = store.verify('prod.example.com', 22, 'ssh-ed25519', 'SHA256:aaa111', 'AAAA111');
    expect(second.status).toBe('trusted');

    const mismatch = store.verify('prod.example.com', 22, 'ssh-ed25519', 'SHA256:evil999', 'AAAA999');
    expect(mismatch.status).toBe('mismatch');
    if (mismatch.status === 'mismatch') {
      expect(mismatch.expectedFingerprint).toBe('SHA256:aaa111');
      expect(mismatch.receivedFingerprint).toBe('SHA256:evil999');
    }

    expect(() =>
      store.trustNewHost('prod.example.com', 22, 'ssh-ed25519', 'SHA256:evil999', 'AAAA999')
    ).toThrow(/mismatch/);

    expect(store.revokeHost('prod.example.com', 22)).toBe(true);
    const reTrusted = store.trustNewHost('prod.example.com', 22, 'ssh-ed25519', 'SHA256:evil999', 'AAAA999');
    expect(reTrusted.fingerprint).toBe('SHA256:evil999');
  });

  it('validates OpenSSH and PEM private keys accurately without fabricating chmod permissions', async () => {
    const seed = new Uint8Array(32).fill(7);
    const pub = new Uint8Array(32).fill(9);
    const pem = encodeOpenSshEd25519PrivateKeyPem(seed, pub, 'ops@prod');

    const validRes = await validateAndInspectPrivateKeyPem(pem);
    expect(validRes.valid).toBe(true);
    expect(validRes.format).toBe('openssh');
    expect(validRes.keyType).toBe('ssh-ed25519');
    expect(validRes.encrypted).toBe(false);
    expect(validRes.fingerprint?.startsWith('SHA256:')).toBe(true);

    const invalidRes = await validateAndInspectPrivateKeyPem('not-a-private-key');
    expect(invalidRes.valid).toBe(false);
    expect(invalidRes.error).toContain('Invalid private key');
  });
});
