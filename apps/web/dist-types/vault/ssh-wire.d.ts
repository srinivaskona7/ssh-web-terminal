export type SshKeyAlgorithm = 'ssh-ed25519' | 'ecdsa-sha2-nistp256';
export declare function writeSshBytes(parts: Uint8Array[]): Uint8Array;
export declare function readSshBytes(buf: Uint8Array, startOffset?: number): {
    value: Uint8Array;
    nextOffset: number;
};
export declare function bytesToBase64(bytes: Uint8Array): string;
export declare function base64ToBytes(b64: string): Uint8Array;
/**
 * Encodes an unsigned big-endian integer slice as an SSH mpint (RFC 4251 Section 5).
 */
export declare function encodeMpint(rawUnsigned: Uint8Array): Uint8Array;
/**
 * Converts a 64-byte WebCrypto ECDSA P-256 IEEE-P1363 (r || s) signature into an SSH mpint signature blob.
 */
export declare function p1363ToSshMpint(p1363: Uint8Array): Uint8Array;
/**
 * Converts an SSH mpint signature blob back into a 64-byte IEEE-P1363 (r || s) buffer.
 */
export declare function sshMpintToP1363(sshBlob: Uint8Array): Uint8Array;
/**
 * Computes an OpenSSH SHA256 fingerprint ("SHA256:...") from an SSH wire public key blob.
 */
export declare function computeSshFingerprint(sshWireBlob: Uint8Array): Promise<string>;
/**
 * Exports a WebCrypto public key into OpenSSH wire blob and authorized_keys line format.
 */
export declare function exportOpenSshPublicKey(publicKey: CryptoKey, algorithm: SshKeyAlgorithm, comment?: string): Promise<{
    wireBlob: Uint8Array;
    authorizedKeyLine: string;
    fingerprintSHA256: string;
}>;
/**
 * Builds a one-click shell command snippet for deploying an OpenSSH public key line to ~/.ssh/authorized_keys.
 */
export declare function formatAuthorizedKeysSnippet(authorizedKeyLine: string): string;
/**
 * Wraps a 32-byte Ed25519 private seed into RFC 8410 PKCS#8 DER format for WebCrypto importKey('pkcs8').
 */
export declare function wrapEd25519SeedAsPkcs8(seed32: Uint8Array): Uint8Array;
/**
 * Builds an unencrypted OpenSSH Ed25519 private key PEM string from a 32-byte seed and 32-byte public key.
 */
export declare function encodeOpenSshEd25519PrivateKeyPem(seed32: Uint8Array, pub32: Uint8Array, comment?: string): string;
/**
 * Parses an OpenSSH Ed25519 private key PEM into its 32-byte seed, 32-byte public key, and comment.
 */
export declare function parseOpenSshEd25519PrivateKeyPem(pemText: string): {
    seed32: Uint8Array;
    pub32: Uint8Array;
    comment: string;
};
//# sourceMappingURL=ssh-wire.d.ts.map