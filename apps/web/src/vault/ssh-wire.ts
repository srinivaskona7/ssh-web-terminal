export type SshKeyAlgorithm = 'ssh-ed25519' | 'ecdsa-sha2-nistp256';

export function writeSshBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += 4 + part.byteLength;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.byteLength, false);
    offset += 4;
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function readSshBytes(buf: Uint8Array, startOffset = 0): { value: Uint8Array; nextOffset: number } {
  if (startOffset + 4 > buf.byteLength) {
    throw new Error('SSH wire buffer truncated at length prefix');
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = view.getUint32(startOffset, false);
  const nextOffset = startOffset + 4 + len;
  if (nextOffset > buf.byteLength) {
    throw new Error('SSH wire buffer truncated at payload');
  }
  return {
    value: buf.subarray(startOffset + 4, nextOffset),
    nextOffset
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Encodes an unsigned big-endian integer slice as an SSH mpint (RFC 4251 Section 5).
 */
export function encodeMpint(rawUnsigned: Uint8Array): Uint8Array {
  let start = 0;
  while (start < rawUnsigned.byteLength && rawUnsigned[start] === 0) {
    start++;
  }
  if (start === rawUnsigned.byteLength) {
    return new Uint8Array(0);
  }
  const trimmed = rawUnsigned.subarray(start);
  if ((trimmed[0]! & 0x80) !== 0) {
    const padded = new Uint8Array(trimmed.byteLength + 1);
    padded[0] = 0;
    padded.set(trimmed, 1);
    return padded;
  }
  return new Uint8Array(trimmed);
}

/**
 * Converts a 64-byte WebCrypto ECDSA P-256 IEEE-P1363 (r || s) signature into an SSH mpint signature blob.
 */
export function p1363ToSshMpint(p1363: Uint8Array): Uint8Array {
  if (p1363.byteLength !== 64) {
    throw new Error(`Expected 64-byte IEEE-P1363 signature, got ${p1363.byteLength}`);
  }
  const rRaw = p1363.subarray(0, 32);
  const sRaw = p1363.subarray(32, 64);
  const rMpint = encodeMpint(rRaw);
  const sMpint = encodeMpint(sRaw);
  if (rMpint.byteLength === 0 || sMpint.byteLength === 0) {
    throw new Error('Invalid ECDSA signature with zero component');
  }
  return writeSshBytes([rMpint, sMpint]);
}

/**
 * Converts an SSH mpint signature blob back into a 64-byte IEEE-P1363 (r || s) buffer.
 */
export function sshMpintToP1363(sshBlob: Uint8Array): Uint8Array {
  const rPart = readSshBytes(sshBlob, 0);
  const sPart = readSshBytes(sshBlob, rPart.nextOffset);
  if (sPart.nextOffset !== sshBlob.byteLength) {
    throw new Error('Trailing bytes in SSH mpint signature blob');
  }
  const out = new Uint8Array(64);
  const rTrimmed = rPart.value[0] === 0 ? rPart.value.subarray(1) : rPart.value;
  const sTrimmed = sPart.value[0] === 0 ? sPart.value.subarray(1) : sPart.value;
  if (rTrimmed.byteLength > 32 || sTrimmed.byteLength > 32) {
    throw new Error('ECDSA P-256 component exceeds 32 bytes');
  }
  out.set(rTrimmed, 32 - rTrimmed.byteLength);
  out.set(sTrimmed, 64 - sTrimmed.byteLength);
  return out;
}

/**
 * Computes an OpenSSH SHA256 fingerprint ("SHA256:...") from an SSH wire public key blob.
 */
export async function computeSshFingerprint(sshWireBlob: Uint8Array): Promise<string> {
  const hashBuf = await crypto.subtle.digest('SHA-256', sshWireBlob.buffer.slice(
    sshWireBlob.byteOffset,
    sshWireBlob.byteOffset + sshWireBlob.byteLength
  ) as ArrayBuffer);
  const b64 = bytesToBase64(new Uint8Array(hashBuf)).replace(/=+$/, '');
  return `SHA256:${b64}`;
}

/**
 * Exports a WebCrypto public key into OpenSSH wire blob and authorized_keys line format.
 */
export async function exportOpenSshPublicKey(
  publicKey: CryptoKey,
  algorithm: SshKeyAlgorithm,
  comment = 'webssh-studio'
): Promise<{ wireBlob: Uint8Array; authorizedKeyLine: string; fingerprintSHA256: string }> {
  const enc = new TextEncoder();
  let wireBlob: Uint8Array;

  if (algorithm === 'ssh-ed25519') {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
    wireBlob = writeSshBytes([enc.encode('ssh-ed25519'), raw]);
  } else {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
    wireBlob = writeSshBytes([
      enc.encode('ecdsa-sha2-nistp256'),
      enc.encode('nistp256'),
      raw
    ]);
  }

  const fingerprintSHA256 = await computeSshFingerprint(wireBlob);
  const b64 = bytesToBase64(wireBlob);
  const safeComment = comment
    .split(String.fromCharCode(10))
    .join(' ')
    .split(String.fromCharCode(13))
    .join(' ')
    .trim();
  const authorizedKeyLine = safeComment
    ? `${algorithm} ${b64} ${safeComment}`
    : `${algorithm} ${b64}`;

  return { wireBlob, authorizedKeyLine, fingerprintSHA256 };
}

/**
 * Builds a one-click shell command snippet for deploying an OpenSSH public key line to ~/.ssh/authorized_keys.
 */
export function formatAuthorizedKeysSnippet(authorizedKeyLine: string): string {
  const escaped = authorizedKeyLine.replace(/'/g, `'''`);
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${escaped}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}

/**
 * Wraps a 32-byte Ed25519 private seed into RFC 8410 PKCS#8 DER format for WebCrypto importKey('pkcs8').
 */
export function wrapEd25519SeedAsPkcs8(seed32: Uint8Array): Uint8Array {
  if (seed32.byteLength !== 32) {
    throw new Error(`Expected 32-byte Ed25519 seed, got ${seed32.byteLength}`);
  }
  const header = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
  ]);
  const out = new Uint8Array(header.byteLength + 32);
  out.set(header, 0);
  out.set(seed32, header.byteLength);
  return out;
}

/**
 * Builds an unencrypted OpenSSH Ed25519 private key PEM string from a 32-byte seed and 32-byte public key.
 */
export function encodeOpenSshEd25519PrivateKeyPem(
  seed32: Uint8Array,
  pub32: Uint8Array,
  comment = 'imported@webssh'
): string {
  const enc = new TextEncoder();
  const magic = enc.encode('openssh-key-v1' + String.fromCharCode(0));
  const pubBlob = writeSshBytes([enc.encode('ssh-ed25519'), pub32]);
  const priv64 = new Uint8Array(64);
  priv64.set(seed32, 0);
  priv64.set(pub32, 32);

  const checkInt = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
  const innerUnpadded = concatBytes([
    checkInt,
    checkInt,
    writeSshBytes([
      enc.encode('ssh-ed25519'),
      pub32,
      priv64,
      enc.encode(comment)
    ])
  ]);
  const padLen = (8 - (innerUnpadded.byteLength % 8)) % 8;
  const pad = new Uint8Array(padLen);
  for (let i = 0; i < padLen; i++) {
    pad[i] = i + 1;
  }
  const privateSection = concatBytes([innerUnpadded, pad]);

  const countBuf = new Uint8Array([0, 0, 0, 1]);
  const outer = concatBytes([
    magic,
    writeSshBytes([enc.encode('none'), enc.encode('none'), new Uint8Array(0)]),
    countBuf,
    writeSshBytes([pubBlob]),
    writeSshBytes([privateSection])
  ]);
  const b64 = bytesToBase64(outer);
  return ['-----BEGIN OPENSSH PRIVATE KEY-----', b64, '-----END OPENSSH PRIVATE KEY-----'].join(
    String.fromCharCode(10)
  );
}

/**
 * Parses an OpenSSH Ed25519 private key PEM into its 32-byte seed, 32-byte public key, and comment.
 */
export function parseOpenSshEd25519PrivateKeyPem(pemText: string): {
  seed32: Uint8Array;
  pub32: Uint8Array;
  comment: string;
} {
  const match = pemText.match(
    /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/
  );
  if (!match || !match[1]) {
    throw new Error('Invalid OpenSSH private key PEM header');
  }
  const raw = base64ToBytes(match[1]);
  const magic = 'openssh-key-v1' + String.fromCharCode(0);
  for (let i = 0; i < magic.length; i++) {
    if (raw[i] !== magic.charCodeAt(i)) {
      throw new Error('Invalid OpenSSH key magic header');
    }
  }
  let offset = magic.length;
  const cipher = readSshBytes(raw, offset);
  offset = cipher.nextOffset;
  const kdf = readSshBytes(raw, offset);
  offset = kdf.nextOffset;
  const kdfOpts = readSshBytes(raw, offset);
  offset = kdfOpts.nextOffset;

  const dec = new TextDecoder();
  if (dec.decode(cipher.value) !== 'none' || dec.decode(kdf.value) !== 'none') {
    throw new Error('Encrypted OpenSSH private keys must be decrypted before import');
  }

  const numKeys = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(offset, false);
  if (numKeys !== 1) {
    throw new Error(`Expected 1 key in OpenSSH container, found ${numKeys}`);
  }
  offset += 4;
  const pubBlob = readSshBytes(raw, offset);
  offset = pubBlob.nextOffset;
  const privSection = readSshBytes(raw, offset);

  const privBytes = privSection.value;
  if (privBytes.byteLength < 8) {
    throw new Error('OpenSSH private section truncated');
  }
  const view = new DataView(privBytes.buffer, privBytes.byteOffset, privBytes.byteLength);
  if (view.getUint32(0, false) !== view.getUint32(4, false)) {
    throw new Error('OpenSSH private key checkint mismatch');
  }
  let pOff = 8;
  const keyType = readSshBytes(privBytes, pOff);
  pOff = keyType.nextOffset;
  if (dec.decode(keyType.value) !== 'ssh-ed25519') {
    throw new Error(`Unsupported OpenSSH key type: ${dec.decode(keyType.value)}`);
  }
  const pubPart = readSshBytes(privBytes, pOff);
  pOff = pubPart.nextOffset;
  const privPart = readSshBytes(privBytes, pOff);
  pOff = privPart.nextOffset;
  const commentPart = readSshBytes(privBytes, pOff);

  if (pubPart.value.byteLength !== 32 || privPart.value.byteLength !== 64) {
    throw new Error('Invalid Ed25519 key lengths in OpenSSH private key');
  }
  const seed32 = new Uint8Array(privPart.value.subarray(0, 32));
  const pub32 = new Uint8Array(pubPart.value);
  const comment = dec.decode(commentPart.value);

  // Zeroize intermediate buffers
  privPart.value.fill(0);
  raw.fill(0);

  return { seed32, pub32, comment };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) {
    len += c.byteLength;
  }
  const out = new Uint8Array(len);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
