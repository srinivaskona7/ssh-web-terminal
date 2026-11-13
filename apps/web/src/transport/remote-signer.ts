import type { ControlMessage, JumpHop } from '@webssh/protocol';

export type SignRequestMessage = Extract<ControlMessage, { type: 'sign_request' }>;

/** Signs a gateway or relay challenge with one browser key; resolves the base64 signature. */
export type RemoteSignFn = (request: SignRequestMessage) => Promise<string>;

export interface SignRoutingParams {
  authMethod?: 'password' | 'private_key' | 'remote_signer';
  /** Fingerprint of the target's remote-signer key. */
  keyFingerprint?: string;
  jumpHops?: JumpHop[];
  /** Browser keys by fingerprint; a request is only ever signed by the key it names. */
  signers?: Record<string, RemoteSignFn>;
  /** Single-key signer kept for callers that predate `signers`. */
  onSignRequest?: RemoteSignFn;
}

export type SignVerdict = { ok: true; signatureBase64: string } | { ok: false; reason: string };

const hopCredentialFields = [
  'authMethod',
  'password',
  'publicKey',
  'privateKeyPem',
  'privateKeyPassphrase',
  'keyFingerprint'
] as const;

/** A hop with any credential signs in with only its own; a bare hop inherits the target's. */
export function hopHasOwnCredential(hop: JumpHop): boolean {
  return hopCredentialFields.some((field) => Boolean(hop[field]));
}

/** The hop as sent on the wire: address plus only the credential fields it actually has. */
export function toWireJumpHop(hop: JumpHop): JumpHop {
  const wire: JumpHop = { host: hop.host, port: hop.port, user: hop.user };
  for (const field of hopCredentialFields) {
    const value = hop[field];
    if (value) (wire as unknown as Record<string, string>)[field] = value;
  }
  return wire;
}

/**
 * Decide which browser key, if any, may answer a sign request. The fingerprint must be the one
 * configured for the hop (or target) asking, and only that key signs it.
 */
export async function routeSignRequest(
  params: SignRoutingParams,
  request: SignRequestMessage
): Promise<SignVerdict> {
  let who = 'the target';
  let authMethod = params.authMethod;
  let expected = params.keyFingerprint;
  if (request.hopIndex !== undefined) {
    const hops = params.jumpHops ?? [];
    const index = request.hopIndex;
    if (!Number.isInteger(index) || index < 1 || index > hops.length) {
      return { ok: false, reason: `sign request names jump hop ${index}, which is not in the jump chain` };
    }
    const hop = hops[index - 1]!;
    if (hopHasOwnCredential(hop)) {
      who = `jump hop ${index} (${hop.user}@${hop.host}:${hop.port})`;
      authMethod = hop.authMethod;
      expected = hop.keyFingerprint;
    }
  }
  if (authMethod !== 'remote_signer') {
    return { ok: false, reason: `${who} signs in with ${authMethod ?? 'no method'}, not a browser key` };
  }
  if (!expected) return { ok: false, reason: `${who} names no key fingerprint` };
  if (request.keyFingerprint !== expected) {
    return {
      ok: false,
      reason: `${who} is configured for ${expected}, but the request asks for ${request.keyFingerprint}`
    };
  }
  let signer: RemoteSignFn | undefined;
  if (params.signers) {
    if (Object.prototype.hasOwnProperty.call(params.signers, expected)) signer = params.signers[expected];
    if (!signer) return { ok: false, reason: `no key in this browser matches ${expected}` };
  } else {
    signer = params.onSignRequest;
  }
  if (!signer) return { ok: false, reason: 'no browser key signer is configured' };
  try {
    const signatureBase64 = await signer(request);
    if (!signatureBase64) return { ok: false, reason: `key ${expected} returned no signature` };
    return { ok: true, signatureBase64 };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `key ${expected} could not sign: ${detail}` };
  }
}

/** The vault key a sign request names, matched by fingerprint; undefined when none matches. */
export function selectSigningKey<K extends { fingerprintSHA256: string }>(
  keys: readonly K[],
  keyFingerprint: string
): K | undefined {
  if (!keyFingerprint) return undefined;
  return keys.find((key) => key.fingerprintSHA256 === keyFingerprint);
}

/**
 * The secrets a connect message may carry for one auth method. The gateway offers password auth
 * whenever a password is present, so a key login must never ship a leftover typed password.
 */
export function scopeConnectSecrets(
  authMethod: 'password' | 'private_key' | 'remote_signer',
  secrets: { password?: string; privateKeyPassphrase?: string }
): { password?: string; privateKeyPassphrase?: string } {
  if (authMethod === 'password') return { password: secrets.password };
  if (authMethod === 'private_key') return { privateKeyPassphrase: secrets.privateKeyPassphrase || undefined };
  return {};
}
