import { constantTimeEqual, extractRelayAuthToken, type PolicyCheckResult, type RelayEnv } from './policy.js';

export interface VerifiedSessionClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  /** `guest` tickets are scoped to one destination and need no account. */
  kind?: 'user' | 'guest';
  /** Guest ticket: the only host this ticket may reach. */
  dst?: string;
  /** Guest ticket: the only port this ticket may reach. */
  dpt?: number;
}

export interface AuthVerificationResult extends PolicyCheckResult {
  userId?: string;
  claims?: VerifiedSessionClaims;
}

const DEFAULT_ISSUER = 'webssh-studio-relay';
const DEFAULT_AUDIENCE = 'webssh-relay';
export const DEFAULT_SESSION_TTL_SECONDS = 900; // 15 minutes
export const MAX_SESSION_TTL_SECONDS = 3600; // 1 hour hard ceiling

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlEncodeString(str: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

function base64UrlDecodeBytes(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const bin = atob(padded + '='.repeat(padLen));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function randomHex(byteCount = 16): string {
  const buf = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function issueUserSessionToken(
  userId: string,
  env: RelayEnv,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<{ token: string; claims: VerifiedSessionClaims }> {
  const secret = (env.SESSION_SIGNING_SECRET ?? '').trim();
  if (!secret || secret.length < 16) {
    throw new Error('ERR_CONFIG_MISSING: SESSION_SIGNING_SECRET (min 16 chars) is required to issue session tokens.');
  }
  const cleanUser = userId.trim();
  if (!cleanUser) {
    throw new Error('User identity (sub) is required.');
  }
  const boundedTtl = Math.max(60, Math.min(ttlSeconds, MAX_SESSION_TTL_SECONDS));
  const claims: VerifiedSessionClaims = {
    iss: (env.SESSION_TOKEN_ISSUER ?? DEFAULT_ISSUER).trim() || DEFAULT_ISSUER,
    aud: (env.SESSION_TOKEN_AUDIENCE ?? DEFAULT_AUDIENCE).trim() || DEFAULT_AUDIENCE,
    sub: cleanUser,
    iat: nowSec,
    exp: nowSec + boundedTtl,
    jti: randomHex(12)
  };

  return {
    token: await signSessionClaims(claims, secret),
    claims
  };
}

async function signSessionClaims(
  claims: VerifiedSessionClaims,
  secret: string
): Promise<string> {
  const headerB64 = base64UrlEncodeString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await importHmacKey(secret);
  const sigBytes = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(signingInput) as BufferSource
    )
  );
  return `${signingInput}.${base64UrlEncodeBytes(sigBytes)}`;
}

export const DEFAULT_GUEST_TICKET_TTL_SECONDS = 300; // 5 minutes

/**
 * Issue a short-lived ticket for one destination. It replaces an account for
 * the guest flow: possession proves the Turnstile challenge passed, and the
 * `dst`/`dpt` claims stop it from being replayed against another host.
 */
export async function issueGuestTicket(
  host: string,
  port: number,
  env: RelayEnv,
  ttlSeconds = DEFAULT_GUEST_TICKET_TTL_SECONDS,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<{ token: string; claims: VerifiedSessionClaims }> {
  const secret = (env.SESSION_SIGNING_SECRET ?? '').trim();
  if (!secret || secret.length < 16) {
    throw new Error('ERR_CONFIG_MISSING: SESSION_SIGNING_SECRET (min 16 chars) is required to issue tickets.');
  }
  const cleanHost = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!cleanHost || cleanHost.length > 253 || !/^[a-z0-9._:-]+$/.test(cleanHost)) {
    throw new Error('A valid destination host is required.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('A valid destination port is required.');
  }
  const boundedTtl = Math.max(60, Math.min(ttlSeconds, MAX_SESSION_TTL_SECONDS));
  const claims: VerifiedSessionClaims = {
    iss: (env.SESSION_TOKEN_ISSUER ?? DEFAULT_ISSUER).trim() || DEFAULT_ISSUER,
    aud: (env.SESSION_TOKEN_AUDIENCE ?? DEFAULT_AUDIENCE).trim() || DEFAULT_AUDIENCE,
    sub: `guest-${randomHex(8)}`,
    iat: nowSec,
    exp: nowSec + boundedTtl,
    jti: randomHex(12),
    kind: 'guest',
    dst: cleanHost,
    dpt: port
  };
  return { token: await signSessionClaims(claims, secret), claims };
}

export async function verifyUserSessionToken(
  token: string,
  env: RelayEnv,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<AuthVerificationResult> {
  const secret = (env.SESSION_SIGNING_SECRET ?? '').trim();
  if (!secret) {
    return {
      ok: false,
      status: 503,
      code: 'ERR_CONFIG_MISSING',
      message: 'SESSION_SIGNING_SECRET is not configured on the Cloudflare Worker.'
    };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: 'Malformed session JWT.'
    };
  }

  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  let header: { alg?: string; typ?: string };
  let claims: VerifiedSessionClaims;
  let sigBytes: Uint8Array;

  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(headerB64))) as {
      alg?: string;
      typ?: string;
    };
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(payloadB64))) as VerifiedSessionClaims;
    sigBytes = base64UrlDecodeBytes(sigB64);
  } catch {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: 'Invalid base64url encoding in session JWT.'
    };
  }

  if (header.alg !== 'HS256') {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: `Unsupported JWT algorithm "${header.alg ?? 'none'}".`
    };
  }

  const key = await importHmacKey(secret);
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const validSig = await globalThis.crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes as BufferSource,
    signingInput as BufferSource
  );
  if (!validSig) {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: 'Session token signature verification failed.'
    };
  }

  const expectedIss = (env.SESSION_TOKEN_ISSUER ?? DEFAULT_ISSUER).trim() || DEFAULT_ISSUER;
  const expectedAud = (env.SESSION_TOKEN_AUDIENCE ?? DEFAULT_AUDIENCE).trim() || DEFAULT_AUDIENCE;

  if (claims.iss !== expectedIss) {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: `Invalid token issuer "${claims.iss}".`
    };
  }
  if (claims.aud !== expectedAud) {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: `Invalid token audience "${claims.aud}".`
    };
  }
  if (typeof claims.sub !== 'string' || !claims.sub.trim()) {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: 'Session token is missing user identity (sub).'
    };
  }
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: 'Session token is missing numeric exp/iat claims.'
    };
  }
  if (nowSec >= claims.exp) {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: 'User session token has expired. Please sign in again.'
    };
  }
  if (claims.iat > nowSec + 60) {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: 'Session token iat is in the future.'
    };
  }
  if (claims.kind === 'guest') {
    if (typeof claims.dst !== 'string' || !claims.dst.trim()) {
      return {
        ok: false,
        status: 401,
        code: 'ERR_RELAY_AUTH_FAILED',
        message: 'Guest ticket is missing its destination scope.'
      };
    }
    if (typeof claims.dpt !== 'number' || !Number.isInteger(claims.dpt)) {
      return {
        ok: false,
        status: 401,
        code: 'ERR_RELAY_AUTH_FAILED',
        message: 'Guest ticket is missing its destination port.'
      };
    }
  } else if (claims.kind !== undefined && claims.kind !== 'user') {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: `Unsupported ticket kind "${String(claims.kind)}".`
    };
  }
  if (claims.exp - claims.iat > MAX_SESSION_TTL_SECONDS) {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: 'Session token lifetime exceeds maximum permitted duration (3600s).'
    };
  }

  return {
    ok: true,
    status: 200,
    code: 'OK',
    message: 'Verified user session token',
    userId: claims.sub.trim(),
    claims
  };
}

export async function authenticateRelayRequest(
  request: Request,
  env: RelayEnv,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<AuthVerificationResult> {
  const signingSecret = (env.SESSION_SIGNING_SECRET ?? '').trim();
  const adminTokenEnabled = env.ENABLE_ADMIN_SHARED_TOKEN === '1';
  const adminSharedToken = (env.RELAY_AUTH_TOKEN ?? '').trim();

  if (!signingSecret && !(adminTokenEnabled && adminSharedToken)) {
    if (env.ALLOW_UNAUTHENTICATED_DEV === '1') {
      return {
        ok: true,
        status: 200,
        code: 'OK',
        message: 'Dev unauthenticated mode',
        userId: 'dev-user'
      };
    }
    return {
      ok: false,
      status: 503,
      code: 'ERR_CONFIG_MISSING',
      message:
        'Relay authentication is not configured. Set SESSION_SIGNING_SECRET (or ENABLE_ADMIN_SHARED_TOKEN=1 with RELAY_AUTH_TOKEN for tests).'
    };
  }

  const supplied = extractRelayAuthToken(request);
  if (!supplied) {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: 'Missing relay session token. Sign in to obtain a short-lived user session token.'
    };
  }

  // 1. Short-lived User Session JWT (3 dot-separated base64url segments)
  if (supplied.split('.').length === 3 && signingSecret) {
    return verifyUserSessionToken(supplied, env, nowSec);
  }

  // 2. Explicit Administrator / CI Test Shared Token mode (ONLY when ENABLE_ADMIN_SHARED_TOKEN === '1')
  if (adminTokenEnabled && adminSharedToken) {
    if (constantTimeEqual(supplied, adminSharedToken)) {
      return {
        ok: true,
        status: 200,
        code: 'OK',
        message: 'Authenticated via explicit admin/test shared token',
        userId: 'admin-shared'
      };
    }
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: 'Invalid admin/test relay token.'
    };
  }

  if (signingSecret) {
    return verifyUserSessionToken(supplied, env, nowSec);
  }

  return {
    ok: false,
    status: 401,
    code: 'ERR_RELAY_AUTH_FAILED',
    message: 'Shared token authentication is disabled in production; use a short-lived user session JWT.'
  };
}
