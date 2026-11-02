export interface RelayEnv {
  ALLOWED_ORIGINS?: string;
  ALLOWED_SSH_TARGETS?: string;
  ALLOWED_SSH_PORTS?: string;
  RELAY_AUTH_TOKEN?: string;
  CONNECT_TIMEOUT_MS?: string;
  IDLE_TIMEOUT_MS?: string;
  ALLOW_LOOPBACK_FOR_TESTS?: string;
  ALLOW_UNAUTHENTICATED_DEV?: string;
}

export interface PolicyCheckResult {
  ok: boolean;
  status: number;
  code:
    | 'OK'
    | 'ERR_CONFIG_MISSING'
    | 'ERR_ORIGIN_DENIED'
    | 'ERR_RELAY_AUTH_FAILED'
    | 'ERR_DESTINATION_DENIED'
    | 'ERR_INVALID_TARGET'
    | 'ERR_NON_SSH_BANNER';
  message: string;
}

export const MAX_WS_MESSAGE_BYTES = 256 * 1024; // 256 KiB max single frame
export const MAX_BUFFERED_AMOUNT_BYTES = 1024 * 1024; // 1 MiB backpressure limit
export const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength || bufA.byteLength === 0) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return diff === 0;
}

export function validateOrigin(originHeader: string | null, allowedOriginsRaw?: string): PolicyCheckResult {
  const raw = (allowedOriginsRaw ?? '').trim();
  if (!raw) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_ORIGIN_DENIED',
      message: 'ALLOWED_ORIGINS is not configured on the Cloudflare Worker.'
    };
  }
  const allowedList = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (allowedList.includes('*')) {
    return { ok: true, status: 200, code: 'OK', message: 'Origin allowed (*)' };
  }

  const origin = (originHeader ?? '').trim().toLowerCase();
  if (!origin) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_ORIGIN_DENIED',
      message: 'Missing Origin header; direct non-browser requests are denied.'
    };
  }

  if (!allowedList.includes(origin)) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_ORIGIN_DENIED',
      message: `Origin "${originHeader}" is not permitted by ALLOWED_ORIGINS.`
    };
  }

  return { ok: true, status: 200, code: 'OK', message: 'Origin verified' };
}

export function extractRelayAuthToken(request: Request): string {
  const authHeader = request.headers.get('Authorization')?.trim() ?? '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const xHeader = request.headers.get('X-Relay-Token')?.trim() ?? '';
  if (xHeader) {
    return xHeader;
  }
  const protoHeader = request.headers.get('Sec-WebSocket-Protocol') ?? '';
  for (const part of protoHeader.split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('token.')) {
      return trimmed.slice('token.'.length);
    }
  }
  try {
    const url = new URL(request.url);
    return url.searchParams.get('token')?.trim() ?? '';
  } catch {
    return '';
  }
}

export function validateRelayAuthToken(request: Request, env: RelayEnv): PolicyCheckResult {
  const expected = (env.RELAY_AUTH_TOKEN ?? '').trim();
  if (!expected) {
    if (env.ALLOW_UNAUTHENTICATED_DEV === '1') {
      return { ok: true, status: 200, code: 'OK', message: 'Dev unauthenticated mode' };
    }
    return {
      ok: false,
      status: 503,
      code: 'ERR_CONFIG_MISSING',
      message: 'RELAY_AUTH_TOKEN secret is not configured on the Cloudflare Worker.'
    };
  }

  const supplied = extractRelayAuthToken(request);
  if (!supplied || !constantTimeEqual(supplied, expected)) {
    return {
      ok: false,
      status: 401,
      code: 'ERR_RELAY_AUTH_FAILED',
      message: 'Invalid or missing Cloudflare Worker Relay authentication token.'
    };
  }

  return { ok: true, status: 200, code: 'OK', message: 'Authenticated' };
}

function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    acc = ((acc << 8) | n) >>> 0;
  }
  return acc;
}

function isBlockedInternalOrMetadataHost(host: string, allowLoopbackForTests: boolean): string | null {
  const lower = host.toLowerCase();
  if (
    lower === 'metadata.google.internal' ||
    lower === 'metadata' ||
    lower === 'instance-data' ||
    lower.endsWith('.internal') ||
    lower.endsWith('.local')
  ) {
    return `Host "${host}" is a restricted internal/metadata hostname`;
  }

  if (lower === 'localhost' || lower === '::1' || lower === '[::1]') {
    if (allowLoopbackForTests) return null;
    return `Loopback target "${host}" is blocked`;
  }

  const ipv4 = parseIPv4(lower);
  if (ipv4 !== null) {
    const firstOctet = (ipv4 >>> 24) & 0xff;
    const secondOctet = (ipv4 >>> 16) & 0xff;

    // 127.0.0.0/8 loopback
    if (firstOctet === 127) {
      return allowLoopbackForTests ? null : `Loopback IPv4 ${host} is blocked`;
    }
    // 0.0.0.0/8 unspecified
    if (firstOctet === 0) {
      return `Unspecified IPv4 ${host} is blocked`;
    }
    // 169.254.0.0/16 cloud metadata / link-local (ALWAYS blocked even in test mode)
    if (firstOctet === 169 && secondOctet === 254) {
      return `Cloud metadata / link-local IPv4 ${host} (169.254.0.0/16) is strictly blocked`;
    }
    // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 private/CGNAT
    if (
      firstOctet === 10 ||
      (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
      (firstOctet === 192 && secondOctet === 168) ||
      (firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127) ||
      firstOctet >= 224
    ) {
      return `Private, CGNAT, or multicast IPv4 ${host} is blocked on public Cloudflare Relay`;
    }
  }

  if (lower.includes(':')) {
    const cleanV6 = lower.replace(/^\[|\]$/g, '');
    if (cleanV6 === '::' || cleanV6.startsWith('fe80:') || cleanV6.startsWith('fc') || cleanV6.startsWith('fd')) {
      return `Link-local or unique-local IPv6 ${host} is blocked`;
    }
  }

  return null;
}

function matchesTargetPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p || p === '*') {
    // Unrestricted wildcard "*" is intentionally forbidden to prevent open TCP proxying
    return false;
  }

  // CIDR match for IPv4 (e.g. 203.0.113.0/24)
  if (p.includes('/')) {
    const [cidrIp, prefixStr] = p.split('/');
    const prefix = Number(prefixStr);
    const hostInt = parseIPv4(h);
    const netInt = cidrIp ? parseIPv4(cidrIp) : null;
    if (hostInt !== null && netInt !== null && Number.isInteger(prefix) && prefix >= 1 && prefix <= 32) {
      const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
      return (hostInt & mask) >>> 0 === (netInt & mask) >>> 0;
    }
    return false;
  }

  // Glob wildcard pattern (e.g. "ec2-*.compute.amazonaws.com" or "*.example.com")
  if (p.includes('*')) {
    const patternParts = p.split('*').map((segment) => segment.replace(/\./g, '[.]'));
    const re = new RegExp(`^${patternParts.join('[a-z0-9.-]+')}$`, 'i');
    return re.test(h);
  }

  return h === p;
}

export function validateDestination(host: string, port: number, env: RelayEnv): PolicyCheckResult {
  const trimmedHost = host.trim();
  if (!trimmedHost || trimmedHost.length > 253 || !/^[a-zA-Z0-9._:-]+$/.test(trimmedHost)) {
    return {
      ok: false,
      status: 400,
      code: 'ERR_INVALID_TARGET',
      message: `Invalid SSH target hostname or IP "${host}".`
    };
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      ok: false,
      status: 400,
      code: 'ERR_INVALID_TARGET',
      message: `Invalid SSH TCP port "${port}".`
    };
  }

  const allowLoopback = env.ALLOW_LOOPBACK_FOR_TESTS === '1';
  const internalBlockReason = isBlockedInternalOrMetadataHost(trimmedHost, allowLoopback);
  if (internalBlockReason) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_DESTINATION_DENIED',
      message: internalBlockReason
    };
  }

  const allowedPortsRaw = (env.ALLOWED_SSH_PORTS ?? '22,2222').trim();
  const allowedPorts = allowedPortsRaw
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);

  if (!allowedPorts.includes(port)) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_DESTINATION_DENIED',
      message: `Destination port ${port} is not in ALLOWED_SSH_PORTS (${allowedPorts.join(', ')}).`
    };
  }

  const rawTargets = (env.ALLOWED_SSH_TARGETS ?? '').trim();
  const patterns = rawTargets
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (patterns.length === 0) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_DESTINATION_DENIED',
      message:
        'ALLOWED_SSH_TARGETS is empty on the Cloudflare Worker. Configure approved SSH hostnames/CIDRs in wrangler.jsonc or Worker secrets.'
    };
  }

  if (patterns.includes('*')) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_DESTINATION_DENIED',
      message: 'Unrestricted wildcard "*" in ALLOWED_SSH_TARGETS is forbidden; specify explicit hosts, CIDRs, or subdomain patterns.'
    };
  }

  const matched = patterns.some((pattern) => matchesTargetPattern(trimmedHost, pattern));
  if (!matched) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_DESTINATION_DENIED',
      message: `Destination "${trimmedHost}:${port}" is not permitted by ALLOWED_SSH_TARGETS.`
    };
  }

  return {
    ok: true,
    status: 200,
    code: 'OK',
    message: `Destination ${trimmedHost}:${port} permitted`
  };
}

export function verifySshServerBanner(chunk: Uint8Array): PolicyCheckResult {
  const preview = new TextDecoder().decode(chunk.subarray(0, Math.min(chunk.byteLength, 64)));
  if (!preview.startsWith('SSH-2.0-') && !preview.startsWith('SSH-1.99-')) {
    return {
      ok: false,
      status: 502,
      code: 'ERR_NON_SSH_BANNER',
      message: 'Remote endpoint did not present an RFC 4253 SSH-2.0 banner; non-SSH TCP traffic is blocked.'
    };
  }
  return {
    ok: true,
    status: 200,
    code: 'OK',
    message: 'Valid SSH-2.0 banner'
  };
}
