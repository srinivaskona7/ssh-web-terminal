export type DestinationMode = 'allowlist' | 'public';

export interface DurableObjectIdLike {
  toString(): string;
}

export interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface RelayEnv {
  DESTINATION_MODE?: DestinationMode;
  ALLOWED_ORIGINS?: string;
  ALLOWED_SSH_TARGETS?: string;
  ALLOWED_SSH_PORTS?: string;
  SESSION_SIGNING_SECRET?: string;
  SESSION_TOKEN_ISSUER?: string;
  SESSION_TOKEN_AUDIENCE?: string;
  AUTH_USERS_JSON?: string;
  ENABLE_ADMIN_SHARED_TOKEN?: string;
  RELAY_AUTH_TOKEN?: string;
  CONNECT_TIMEOUT_MS?: string;
  IDLE_TIMEOUT_MS?: string;
  MAX_CONCURRENT_SESSIONS_PER_USER?: string;
  MAX_CONNECTION_ATTEMPTS_PER_MIN?: string;
  USER_QUOTA_DO?: DurableObjectNamespaceLike;
  ALLOW_LOOPBACK_FOR_TESTS?: string;
  ALLOW_UNAUTHENTICATED_DEV?: string;
  ALLOW_IN_MEMORY_QUOTA_FOR_TESTS?: string;
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
    | 'ERR_NON_SSH_BANNER'
    | 'ERR_RATE_LIMITED';
  message: string;
  resolvedIp?: string;
  originalHost?: string;
}

export type DnsResolverFn = (hostname: string) => Promise<string[]>;

export const MAX_WS_MESSAGE_BYTES = 256 * 1024; // 256 KiB max single frame
export const MAX_BUFFERED_AMOUNT_BYTES = 1024 * 1024; // 1 MiB backpressure limit
export const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_CONCURRENT_PER_USER = 5;
export const DEFAULT_MAX_ATTEMPTS_PER_MIN = 20;

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

/**
 * Rejects alternative/ambiguous IP encodings (octal 0177.0.0.1, hex 0x7f000001,
 * integer/dword 2130706433, or shorthand 2/3-part numeric IPs like 127.1 or 10.1.1).
 */
export function detectAlternativeIpEncoding(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (!h || h.includes(':')) return null;

  // Single integer/dword or hex host (e.g. "2130706433" or "0x7f000001")
  if (/^[0-9]+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) {
    return `Ambiguous integer/hex IP encoding "${host}" is forbidden`;
  }

  const labels = h.split('.');
  const allNumericOrHexOrOctal = labels.every(
    (lbl) => /^[0-9]+$/.test(lbl) || /^0x[0-9a-f]+$/.test(lbl)
  );
  if (allNumericOrHexOrOctal) {
    if (labels.length !== 4) {
      return `Shorthand or non-canonical IPv4 encoding "${host}" is forbidden`;
    }
    for (const lbl of labels) {
      if (lbl.startsWith('0x')) {
        return `Hexadecimal IPv4 octet "${lbl}" in "${host}" is forbidden`;
      }
      if (lbl.length > 1 && lbl.startsWith('0')) {
        return `Octal / leading-zero IPv4 octet "${lbl}" in "${host}" is forbidden`;
      }
    }
  }
  return null;
}

/**
 * Parses a canonical 4-octet decimal IPv4 string into an unsigned 32-bit integer.
 * Rejects leading zeros, hex, or out-of-range octets.
 */
export function parseCanonicalIPv4(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    acc = ((acc << 8) | n) >>> 0;
  }
  return acc;
}

/**
 * Parses an IPv6 literal (with optional `::` compression and optional trailing IPv4 dotted-quad)
 * into eight 16-bit words. Returns null if not a valid IPv6 literal.
 */
export function parseIPv6Words(rawIp: string): Uint16Array | null {
  let s = rawIp.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1);
  }
  // Reject zone indices (%eth0)
  if (s.includes('%') || !s.includes(':')) return null;

  // Handle embedded trailing IPv4 (e.g. ::ffff:127.0.0.1 or 64:ff9b::10.0.0.1)
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseCanonicalIPv4(tail);
    if (v4 === null) return null;
    const hi = (v4 >>> 16) & 0xffff;
    const lo = v4 & 0xffff;
    s = `${s.slice(0, lastColon)}:${hi.toString(16)}:${lo.toString(16)}`;
  }

  const doubleColonParts = s.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(':');
    const nums: number[] = [];
    for (const tok of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
      nums.push(Number.parseInt(tok, 16));
    }
    return nums;
  };

  if (doubleColonParts.length === 1) {
    const words = parseSide(doubleColonParts[0]!);
    if (!words || words.length !== 8) return null;
    return new Uint16Array(words);
  }

  const left = parseSide(doubleColonParts[0]!);
  const right = parseSide(doubleColonParts[1]!);
  if (!left || !right || left.length + right.length >= 8) return null;

  const zeroFill = 8 - (left.length + right.length);
  const out = new Uint16Array(8);
  let idx = 0;
  for (const w of left) out[idx++] = w;
  for (let z = 0; z < zeroFill; z++) out[idx++] = 0;
  for (const w of right) out[idx++] = w;
  return out;
}

/**
 * Validates whether an IPv4 32-bit integer is globally routable on the public internet.
 * Rejects private, loopback, link-local, metadata, CGNAT, documentation, benchmarking,
 * protocol-assignment, multicast, reserved, and broadcast ranges.
 */
export function checkGloballyRoutableIPv4(
  ipv4: number,
  options: { allowLoopbackForTests?: boolean; allowDocIps?: boolean } = {}
): string | null {
  const b0 = (ipv4 >>> 24) & 0xff;
  const b1 = (ipv4 >>> 16) & 0xff;
  const b2 = (ipv4 >>> 8) & 0xff;

  // 0.0.0.0/8 Unspecified ("This network")
  if (b0 === 0) return 'Unspecified IPv4 range 0.0.0.0/8 is blocked';
  // 10.0.0.0/8 RFC 1918 Private
  if (b0 === 10) return 'Private IPv4 range 10.0.0.0/8 is blocked';
  // 100.64.0.0/10 RFC 6598 Shared CGNAT
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return 'CGNAT IPv4 range 100.64.0.0/10 is blocked';
  // 127.0.0.0/8 Loopback
  if (b0 === 127) {
    return options.allowLoopbackForTests ? null : 'Loopback IPv4 range 127.0.0.0/8 is blocked';
  }
  // 169.254.0.0/16 Link-local & Cloud Metadata (ALWAYS blocked)
  if (b0 === 169 && b1 === 254) {
    return 'Cloud metadata / link-local IPv4 range 169.254.0.0/16 is strictly blocked';
  }
  // 172.16.0.0/12 RFC 1918 Private
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return 'Private IPv4 range 172.16.0.0/12 is blocked';
  // 192.0.0.0/24 IETF Protocol Assignments
  if (b0 === 192 && b1 === 0 && b2 === 0) return 'Reserved IPv4 range 192.0.0.0/24 is blocked';
  // 192.0.2.0/24 TEST-NET-1 Documentation
  if (b0 === 192 && b1 === 0 && b2 === 2 && !options.allowDocIps) {
    return 'Documentation IPv4 range 192.0.2.0/24 is blocked';
  }
  // 192.88.99.0/24 6to4 Relay Anycast
  if (b0 === 192 && b1 === 88 && b2 === 99) return '6to4 relay IPv4 range 192.88.99.0/24 is blocked';
  // 192.168.0.0/16 RFC 1918 Private
  if (b0 === 192 && b1 === 168) return 'Private IPv4 range 192.168.0.0/16 is blocked';
  // 198.18.0.0/15 Benchmarking
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return 'Benchmarking IPv4 range 198.18.0.0/15 is blocked';
  // 198.51.100.0/24 TEST-NET-2 Documentation
  if (b0 === 198 && b1 === 51 && b2 === 100 && !options.allowDocIps) {
    return 'Documentation IPv4 range 198.51.100.0/24 is blocked';
  }
  // 203.0.113.0/24 TEST-NET-3 Documentation
  if (b0 === 203 && b1 === 0 && b2 === 113 && !options.allowDocIps) {
    return 'Documentation IPv4 range 203.0.113.0/24 is blocked in public mode';
  }
  // 224.0.0.0/4 Multicast & 240.0.0.0/4 Reserved/Broadcast
  if (b0 >= 224) return 'Multicast or reserved IPv4 range 224.0.0.0/3 is blocked';

  return null;
}

/**
 * Validates whether an IPv6 address (8x16-bit words) is a globally routable public unicast IPv6.
 * Rejects unspecified, loopback, IPv4-mapped (::ffff:0:0/96), IPv4-compatible, NAT64, 6to4,
 * Teredo, documentation (2001:db8::/32), unique-local (fc00::/7), link-local (fe80::/10),
 * and multicast (ff00::/8).
 */
export function checkGloballyRoutableIPv6(
  words: Uint16Array,
  options: { allowLoopbackForTests?: boolean } = {}
): string | null {
  const w0 = words[0]!;
  const w1 = words[1]!;
  const w2 = words[2]!;
  const w3 = words[3]!;
  const w4 = words[4]!;
  const w5 = words[5]!;
  const w6 = words[6]!;
  const w7 = words[7]!;

  const allZeroPrefix = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0;
  // ::/128 Unspecified
  if (allZeroPrefix && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 0) {
    return 'Unspecified IPv6 address :: is blocked';
  }
  // ::1/128 Loopback
  if (allZeroPrefix && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1) {
    return options.allowLoopbackForTests ? null : 'Loopback IPv6 address ::1 is blocked';
  }
  // IPv4-mapped IPv6 (::ffff:0:0/96) or IPv4-translated (::ffff:0:0:0/96) or IPv4-compatible (::w.x.y.z)
  if (allZeroPrefix && ((w4 === 0 && w5 === 0xffff) || (w4 === 0xffff && w5 === 0) || (w4 === 0 && w5 === 0))) {
    return 'IPv4-mapped or IPv4-compatible IPv6 addresses (::ffff:0:0/96) are forbidden';
  }
  // NAT64 (64:ff9b::/96 and 64:ff9b:1::/48)
  if (w0 === 0x0064 && w1 === 0xff9b) {
    return 'NAT64 IPv6 transition range 64:ff9b::/96 is blocked';
  }
  // 6to4 (2002::/16)
  if (w0 === 0x2002) {
    return '6to4 IPv6 transition range 2002::/16 is blocked';
  }
  // Teredo (2001:0000::/32)
  if (w0 === 0x2001 && w1 === 0x0000) {
    return 'Teredo IPv6 range 2001::/32 is blocked';
  }
  // Documentation (2001:db8::/32)
  if (w0 === 0x2001 && w1 === 0x0db8) {
    return 'Documentation IPv6 range 2001:db8::/32 is blocked';
  }
  // ORCHID (2001:10::/28)
  if (w0 === 0x2001 && (w1 & 0xfff0) === 0x0010) {
    return 'ORCHID IPv6 range 2001:10::/28 is blocked';
  }
  // Unique-Local (fc00::/7)
  if ((w0 & 0xfe00) === 0xfc00) {
    return 'Unique-local private IPv6 range fc00::/7 is blocked';
  }
  // Link-Local (fe80::/10)
  if ((w0 & 0xffc0) === 0xfe80) {
    return 'Link-local IPv6 range fe80::/10 is blocked';
  }
  // Multicast (ff00::/8)
  if ((w0 & 0xff00) === 0xff00) {
    return 'Multicast IPv6 range ff00::/8 is blocked';
  }
  // Require Global Unicast 2000::/3
  if ((w0 & 0xe000) !== 0x2000) {
    return 'Non-global-unicast IPv6 address is blocked';
  }

  return null;
}

function matchesTargetPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p || p === '*') {
    return false;
  }

  if (p.includes('/')) {
    const [cidrIp, prefixStr] = p.split('/');
    const prefix = Number(prefixStr);
    const hostInt = parseCanonicalIPv4(h);
    const netInt = cidrIp ? parseCanonicalIPv4(cidrIp) : null;
    if (hostInt !== null && netInt !== null && Number.isInteger(prefix) && prefix >= 1 && prefix <= 32) {
      const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
      return (hostInt & mask) >>> 0 === (netInt & mask) >>> 0;
    }
    return false;
  }

  if (p.includes('*')) {
    const patternParts = p.split('*').map((segment) => segment.replace(/\./g, '[.]'));
    const re = new RegExp(`^${patternParts.join('[a-z0-9.-]+')}$`, 'i');
    return re.test(h);
  }

  return h === p;
}

/**
 * Default DNS-over-HTTPS (DoH) resolver querying Cloudflare 1.1.1.1 JSON API for A and AAAA records.
 */
export async function defaultDohResolver(hostname: string): Promise<string[]> {
  const results: string[] = [];
  for (const recordType of ['A', 'AAAA'] as const) {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${recordType}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/dns-json' }
    });
    if (!res.ok) continue;
    const data = (await res.json()) as {
      Answer?: Array<{ type: number; data: string }>;
    };
    for (const ans of data.Answer ?? []) {
      if ((ans.type === 1 || ans.type === 28) && typeof ans.data === 'string') {
        results.push(ans.data.trim());
      }
    }
  }
  return results;
}

/**
 * Synchronous destination check (validates literal IPs and hostname syntax/allowlist).
 */
export function validateDestination(host: string, port: number, env: RelayEnv): PolicyCheckResult {
  const trimmedHost = host.trim();
  const mode: DestinationMode = env.DESTINATION_MODE === 'public' ? 'public' : 'allowlist';

  if (!trimmedHost || trimmedHost.length > 253 || !/^[a-zA-Z0-9._:\-[\]]+$/.test(trimmedHost)) {
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

  const altEncodingErr = detectAlternativeIpEncoding(trimmedHost);
  if (altEncodingErr) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_DESTINATION_DENIED',
      message: altEncodingErr
    };
  }

  const lower = trimmedHost.toLowerCase();
  const allowLoopback = env.ALLOW_LOOPBACK_FOR_TESTS === '1';

  if (
    lower === 'metadata.google.internal' ||
    lower === 'metadata' ||
    lower === 'instance-data' ||
    lower.endsWith('.internal') ||
    lower.endsWith('.local') ||
    lower.endsWith('.localhost')
  ) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_DESTINATION_DENIED',
      message: `Host "${trimmedHost}" is a restricted internal/metadata hostname`
    };
  }

  if (lower === 'localhost') {
    if (!allowLoopback) {
      return {
        ok: false,
        status: 403,
        code: 'ERR_DESTINATION_DENIED',
        message: 'Loopback target "localhost" is blocked'
      };
    }
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

  if (patterns.includes('*')) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_DESTINATION_DENIED',
      message: 'Unrestricted wildcard "*" in ALLOWED_SSH_TARGETS is forbidden; use DESTINATION_MODE="public" for validated public routing.'
    };
  }

  // Check if target is an IPv4 or IPv6 literal
  const ipv4 = parseCanonicalIPv4(lower);
  if (ipv4 !== null) {
    const bogonErr = checkGloballyRoutableIPv4(ipv4, {
      allowLoopbackForTests: allowLoopback,
      allowDocIps: mode === 'allowlist' && patterns.length > 0
    });
    if (bogonErr) {
      return {
        ok: false,
        status: 403,
        code: 'ERR_DESTINATION_DENIED',
        message: `${bogonErr} (${trimmedHost})`
      };
    }
  } else if (lower.includes(':')) {
    const v6Words = parseIPv6Words(lower);
    if (!v6Words) {
      return {
        ok: false,
        status: 400,
        code: 'ERR_INVALID_TARGET',
        message: `Malformed IPv6 address "${trimmedHost}".`
      };
    }
    const v6Err = checkGloballyRoutableIPv6(v6Words, { allowLoopbackForTests: allowLoopback });
    if (v6Err) {
      return {
        ok: false,
        status: 403,
        code: 'ERR_DESTINATION_DENIED',
        message: `${v6Err} (${trimmedHost})`
      };
    }
  }

  if (mode === 'allowlist') {
    if (patterns.length === 0) {
      return {
        ok: false,
        status: 403,
        code: 'ERR_DESTINATION_DENIED',
        message:
          'ALLOWED_SSH_TARGETS is empty in allowlist mode. Configure approved SSH targets or set DESTINATION_MODE="public".'
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
  } else {
    // mode === 'public': if ALLOWED_SSH_TARGETS is optionally provided, enforce it too
    if (patterns.length > 0) {
      const matched = patterns.some((pattern) => matchesTargetPattern(trimmedHost, pattern));
      if (!matched) {
        return {
          ok: false,
          status: 403,
          code: 'ERR_DESTINATION_DENIED',
          message: `Destination "${trimmedHost}:${port}" is not permitted by ALLOWED_SSH_TARGETS.`
        };
      }
    }
  }

  const cleanLiteralIp =
    ipv4 !== null
      ? lower
      : lower.includes(':')
        ? lower.replace(/^\[|\]$/g, '')
        : undefined;

  return {
    ok: true,
    status: 200,
    code: 'OK',
    message: `Destination ${trimmedHost}:${port} permitted (${mode} mode)`,
    resolvedIp: cleanLiteralIp,
    originalHost: trimmedHost
  };
}

/**
 * Resolves A/AAAA records for hostnames, validates every returned IP against the bogon/SSRF filter,
 * and returns the validated IP so `cloudflare:sockets` `connect()` connects directly to the IP
 * without re-resolving the hostname (preventing TOCTOU DNS rebinding).
 */
export async function resolveAndValidateDestination(
  host: string,
  port: number,
  env: RelayEnv,
  dnsResolver: DnsResolverFn = defaultDohResolver
): Promise<PolicyCheckResult> {
  const initialCheck = validateDestination(host, port, env);
  if (!initialCheck.ok) {
    return initialCheck;
  }

  // If the target was already a validated literal IPv4 or IPv6 address, return it directly
  if (initialCheck.resolvedIp) {
    return initialCheck;
  }

  const trimmedHost = host.trim();
  const allowLoopback = env.ALLOW_LOOPBACK_FOR_TESTS === '1';
  if (allowLoopback && trimmedHost.toLowerCase() === 'localhost') {
    return {
      ...initialCheck,
      resolvedIp: '127.0.0.1'
    };
  }

  let answers: string[];
  try {
    answers = await dnsResolver(trimmedHost);
  } catch (err) {
    return {
      ok: false,
      status: 502,
      code: 'ERR_DESTINATION_DENIED',
      message: `DNS resolution failed for "${trimmedHost}": ${
        err instanceof Error ? err.message : String(err)
      }`
    };
  }

  if (!answers || answers.length === 0) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_DESTINATION_DENIED',
      message: `DNS resolution for "${trimmedHost}" returned no A or AAAA records.`
    };
  }

  const validatedIps: string[] = [];
  for (const rawAns of answers) {
    const ans = rawAns.trim();
    const altErr = detectAlternativeIpEncoding(ans);
    if (altErr) {
      return {
        ok: false,
        status: 403,
        code: 'ERR_DESTINATION_DENIED',
        message: `Unsafe DNS record "${ans}" for "${trimmedHost}": ${altErr}`
      };
    }

    const v4 = parseCanonicalIPv4(ans);
    if (v4 !== null) {
      const v4Err = checkGloballyRoutableIPv4(v4, { allowLoopbackForTests: allowLoopback });
      if (v4Err) {
        return {
          ok: false,
          status: 403,
          code: 'ERR_DESTINATION_DENIED',
          message: `DNS rebinding blocked for "${trimmedHost}": resolved IP ${ans} is rejected (${v4Err})`
        };
      }
      validatedIps.push(ans);
      continue;
    }

    const v6 = parseIPv6Words(ans);
    if (v6 !== null) {
      const v6Err = checkGloballyRoutableIPv6(v6, { allowLoopbackForTests: allowLoopback });
      if (v6Err) {
        return {
          ok: false,
          status: 403,
          code: 'ERR_DESTINATION_DENIED',
          message: `DNS rebinding blocked for "${trimmedHost}": resolved IPv6 ${ans} is rejected (${v6Err})`
        };
      }
      validatedIps.push(ans.replace(/^\[|\]$/g, ''));
      continue;
    }

    // Ignore CNAME string records in Answer list if present, or reject malformed IPs
  }

  if (validatedIps.length === 0) {
    return {
      ok: false,
      status: 403,
      code: 'ERR_DESTINATION_DENIED',
      message: `DNS resolution for "${trimmedHost}" produced no valid globally routable IP addresses.`
    };
  }

  return {
    ok: true,
    status: 200,
    code: 'OK',
    message: `Resolved "${trimmedHost}" to validated public IP ${validatedIps[0]}`,
    resolvedIp: validatedIps[0],
    originalHost: trimmedHost
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
