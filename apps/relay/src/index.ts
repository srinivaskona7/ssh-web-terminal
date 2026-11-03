import {
  DEFAULT_GUEST_TICKET_TTL_SECONDS,
  authenticateRelayRequest,
  issueGuestTicket,
  issueUserSessionToken
} from './auth.js';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS_PER_MIN,
  DEFAULT_MAX_TICKET_ATTEMPTS_PER_MIN,
  DEFAULT_MAX_CONCURRENT_PER_USER,
  MAX_BUFFERED_AMOUNT_BYTES,
  MAX_WS_MESSAGE_BYTES,
  constantTimeEqual,
  defaultDohResolver,
  resolveAndValidateDestination,
  validateOrigin,
  verifySshServerBanner,
  type DnsResolverFn,
  type DurableObjectIdLike,
  type DurableObjectNamespaceLike,
  type DurableObjectStubLike,
  type RelayEnv
} from './policy.js';

export interface TcpSocketLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<{ remoteAddress?: string; localAddress?: string }>;
  closed: Promise<void>;
  close(): Promise<void> | void;
}

export type SocketConnectFn = (
  address: { hostname: string; port: number },
  options?: { secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen?: boolean }
) => TcpSocketLike;

export interface RelayRequestOptions {
  connectImpl?: SocketConnectFn;
  dnsResolver?: DnsResolverFn;
  nowMs?: number;
}

/**
 * Cloudflare Durable Object enforcing centralized per-user connection-attempt rate limits
 * and concurrent active SSH session limits across all Worker isolates.
 */
export class RelayUserQuotaDO {
  private attemptTimestamps: number[] = [];
  private activeSessions = new Set<string>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = (await request.json().catch(() => ({}))) as {
      connId?: string;
      maxConcurrent?: number;
      maxAttemptsPerMin?: number;
      nowMs?: number;
    };
    const nowMs = typeof body.nowMs === 'number' ? body.nowMs : Date.now();
    const connId = (body.connId ?? '').trim();

    if (url.pathname === '/acquire') {
      const maxConcurrent = body.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_PER_USER;
      const maxAttempts = body.maxAttemptsPerMin ?? DEFAULT_MAX_ATTEMPTS_PER_MIN;

      // Prune attempts older than 60s
      this.attemptTimestamps = this.attemptTimestamps.filter((ts) => nowMs - ts < 60_000);
      if (this.attemptTimestamps.length >= maxAttempts) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'ERR_RATE_LIMITED',
            message: `Per-user connection rate limit exceeded (max ${maxAttempts} attempts/minute).`
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      this.attemptTimestamps.push(nowMs);

      if (this.activeSessions.size >= maxConcurrent) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'ERR_RATE_LIMITED',
            message: `Per-user concurrent SSH session limit exceeded (max ${maxConcurrent} active sessions).`
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (connId) {
        this.activeSessions.add(connId);
      }
      return new Response(
        JSON.stringify({
          ok: true,
          activeSessions: this.activeSessions.size,
          attemptsLastMin: this.attemptTimestamps.length
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/rate') {
      const maxAttempts = body.maxAttemptsPerMin ?? DEFAULT_MAX_ATTEMPTS_PER_MIN;
      this.attemptTimestamps = this.attemptTimestamps.filter((ts) => nowMs - ts < 60_000);
      if (this.attemptTimestamps.length >= maxAttempts) {
        return new Response(
          JSON.stringify({
            ok: false,
            code: 'ERR_RATE_LIMITED',
            message: `Connection-ticket rate limit exceeded (max ${maxAttempts} requests/minute).`
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      this.attemptTimestamps.push(nowMs);
      return new Response(
        JSON.stringify({ ok: true, attemptsLastMin: this.attemptTimestamps.length }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/release') {
      if (connId) {
        this.activeSessions.delete(connId);
      }
      return new Response(
        JSON.stringify({ ok: true, activeSessions: this.activeSessions.size }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ ok: false, error: 'Unknown DO action' }), { status: 404 });
  }
}

/**
 * Helper for local Vitest / Playwright testing of centralized per-user Durable Object quotas.
 */
export function createLocalUserQuotaNamespace(): DurableObjectNamespaceLike {
  const instances = new Map<string, RelayUserQuotaDO>();
  return {
    idFromName(name: string): DurableObjectIdLike {
      return { toString: () => name };
    },
    get(id: DurableObjectIdLike): DurableObjectStubLike {
      const key = id.toString();
      let inst = instances.get(key);
      if (!inst) {
        inst = new RelayUserQuotaDO();
        instances.set(key, inst);
      }
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          inst.fetch(input instanceof Request ? input : new Request(String(input), init))
      };
    }
  };
}

async function defaultCloudflareConnect(
  address: { hostname: string; port: number },
  options?: { secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen?: boolean }
): Promise<TcpSocketLike> {
  const spec = ['cloudflare', 'sockets'].join(':');
  const mod = (await import(/* @vite-ignore */ spec)) as {
    connect: SocketConnectFn;
  };
  return mod.connect(address, options);
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  corsOrigin?: string | null
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  if (corsOrigin) {
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Vary', 'Origin');
  }
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, X-Relay-Token, Content-Type');
  return new Response(JSON.stringify(body), { status, headers });
}

async function handleAuthSessionIssue(
  request: Request,
  env: RelayEnv,
  corsHeader: string | null,
  nowMs: number
): Promise<Response> {
  if (!(env.SESSION_SIGNING_SECRET ?? '').trim()) {
    return jsonResponse(
      503,
      {
        ok: false,
        code: 'ERR_CONFIG_MISSING',
        error: 'SESSION_SIGNING_SECRET is not configured on the Cloudflare Worker.'
      },
      corsHeader
    );
  }

  let body: { username?: string; password?: string };
  try {
    body = (await request.json()) as { username?: string; password?: string };
  } catch {
    return jsonResponse(
      400,
      { ok: false, code: 'ERR_RELAY_AUTH_FAILED', error: 'Invalid JSON request body.' },
      corsHeader
    );
  }

  const username = (body.username ?? '').trim();
  const password = body.password ?? '';
  if (!username || !password) {
    return jsonResponse(
      401,
      { ok: false, code: 'ERR_RELAY_AUTH_FAILED', error: 'Username and password are required.' },
      corsHeader
    );
  }

  let usersMap: Record<string, string> = {};
  try {
    usersMap = JSON.parse(env.AUTH_USERS_JSON ?? '{}') as Record<string, string>;
  } catch {
    return jsonResponse(
      503,
      { ok: false, code: 'ERR_CONFIG_MISSING', error: 'AUTH_USERS_JSON secret is malformed.' },
      corsHeader
    );
  }

  const expectedPass = usersMap[username];
  if (typeof expectedPass !== 'string' || !constantTimeEqual(password, expectedPass)) {
    return jsonResponse(
      401,
      { ok: false, code: 'ERR_RELAY_AUTH_FAILED', error: 'Invalid relay login credentials.' },
      corsHeader
    );
  }

  const nowSec = Math.floor(nowMs / 1000);
  const { token, claims } = await issueUserSessionToken(username, env, undefined, nowSec);
  return jsonResponse(
    200,
    {
      ok: true,
      token,
      userId: claims.sub,
      expiresAt: claims.exp,
      expiresIn: claims.exp - claims.iat
    },
    corsHeader
  );
}

interface TurnstileResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate a Turnstile response server-side. Turnstile proves a human solved a
 * challenge; it does **not** establish identity, so the ticket it buys is
 * short-lived and scoped to one host/port.
 */
async function verifyTurnstile(
  token: string,
  request: Request,
  env: RelayEnv
): Promise<TurnstileResult> {
  const secret = (env.TURNSTILE_SECRET_KEY ?? '').trim();
  if (!secret) {
    return { ok: false, error: 'TURNSTILE_SECRET_KEY is not configured on the Cloudflare Worker.' };
  }
  const endpoint = (
    env.TURNSTILE_VERIFY_URL ?? 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
  ).trim();
  const form = new URLSearchParams({ secret, response: token });
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) form.set('remoteip', clientIp);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      'error-codes'?: string[];
    };
    if (res.ok && data.success === true) return { ok: true };
    const codes = data['error-codes'] ?? [];
    return {
      ok: false,
      error: `Turnstile verification failed${codes.length ? ` (${codes.join(', ')})` : ''}.`
    };
  } catch (err) {
    return {
      ok: false,
      error: `Turnstile verification could not be reached: ${
        err instanceof Error ? err.message : String(err)
      }`
    };
  }
}

/**
 * Every ticket costs one outbound siteverify request, so unauthenticated calls
 * are rate-limited per edge client IP before Turnstile is contacted.
 */
async function enforceTicketRateLimit(
  request: Request,
  env: RelayEnv,
  corsHeader: string | null,
  nowMs: number
): Promise<Response | null> {
  if (!env.USER_QUOTA_DO) {
    return jsonResponse(
      503,
      {
        ok: false,
        code: 'ERR_CONFIG_MISSING',
        error: 'USER_QUOTA_DO is not bound; guest ticket issuance is disabled.'
      },
      corsHeader
    );
  }
  const clientIp = (request.headers.get('CF-Connecting-IP') ?? '').trim();
  if (!clientIp) {
    // Without an edge IP the quota would be per-ticket, i.e. no limit at all.
    return jsonResponse(
      403,
      {
        ok: false,
        code: 'ERR_RELAY_AUTH_FAILED',
        error: 'Guest connections require a client IP; connect through the Cloudflare edge.'
      },
      corsHeader
    );
  }
  const maxAttempts =
    Number(env.MAX_TICKET_ATTEMPTS_PER_MIN ?? DEFAULT_MAX_TICKET_ATTEMPTS_PER_MIN) ||
    DEFAULT_MAX_TICKET_ATTEMPTS_PER_MIN;
  const stub = env.USER_QUOTA_DO.get(env.USER_QUOTA_DO.idFromName(`ticket:${clientIp}`));
  const res = await stub.fetch('https://quota.internal/rate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxAttemptsPerMin: maxAttempts, nowMs })
  });
  if (res.ok) return null;
  const err = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  return jsonResponse(
    res.status,
    {
      ok: false,
      code: err.code ?? 'ERR_RATE_LIMITED',
      error: err.message ?? 'Too many connection-ticket requests. Try again in a minute.'
    },
    corsHeader
  );
}

/** Issue a guest connection ticket after a Turnstile challenge passes. */
async function handleAuthTicketIssue(
  request: Request,
  env: RelayEnv,
  corsHeader: string | null,
  nowMs: number
): Promise<Response> {
  if (!(env.SESSION_SIGNING_SECRET ?? '').trim()) {
    return jsonResponse(
      503,
      {
        ok: false,
        code: 'ERR_CONFIG_MISSING',
        error: 'SESSION_SIGNING_SECRET is not configured on the Cloudflare Worker.'
      },
      corsHeader
    );
  }
  if (!(env.TURNSTILE_SECRET_KEY ?? '').trim()) {
    return jsonResponse(
      503,
      {
        ok: false,
        code: 'ERR_GUEST_DISABLED',
        error:
          'Guest connections are disabled: set TURNSTILE_SECRET_KEY on the Worker, or sign in with an account.'
      },
      corsHeader
    );
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return jsonResponse(
      400,
      { ok: false, code: 'ERR_TURNSTILE_FAILED', error: 'Invalid JSON request body.' },
      corsHeader
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return jsonResponse(
      400,
      { ok: false, code: 'ERR_INVALID_TARGET', error: 'A JSON object body is required.' },
      corsHeader
    );
  }
  const body = parsed as Record<string, unknown>;

  const host = typeof body.host === 'string' ? body.host.trim() : '';
  const port = Number(body.port ?? 22);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return jsonResponse(
      400,
      { ok: false, code: 'ERR_INVALID_TARGET', error: 'A destination host and port are required.' },
      corsHeader
    );
  }

  const turnstileToken =
    typeof body.turnstileToken === 'string' ? body.turnstileToken.trim() : '';
  if (!turnstileToken) {
    return jsonResponse(
      401,
      { ok: false, code: 'ERR_TURNSTILE_FAILED', error: 'Complete the human check to continue.' },
      corsHeader
    );
  }

  const rateLimited = await enforceTicketRateLimit(request, env, corsHeader, nowMs);
  if (rateLimited) return rateLimited;

  const challenge = await verifyTurnstile(turnstileToken, request, env);
  if (!challenge.ok) {
    return jsonResponse(
      401,
      { ok: false, code: 'ERR_TURNSTILE_FAILED', error: challenge.error ?? 'Turnstile rejected.' },
      corsHeader
    );
  }

  const ttl = Number(env.GUEST_TICKET_TTL_SECONDS ?? DEFAULT_GUEST_TICKET_TTL_SECONDS);
  try {
    const { token, claims } = await issueGuestTicket(
      host,
      port,
      env,
      Number.isFinite(ttl) ? ttl : DEFAULT_GUEST_TICKET_TTL_SECONDS,
      Math.floor(nowMs / 1000)
    );
    return jsonResponse(
      200,
      {
        ok: true,
        token,
        kind: 'guest',
        destination: { host: claims.dst, port: claims.dpt },
        expiresAt: claims.exp,
        expiresIn: claims.exp - claims.iat
      },
      corsHeader
    );
  } catch (err) {
    return jsonResponse(
      400,
      {
        ok: false,
        code: 'ERR_INVALID_TARGET',
        error: err instanceof Error ? err.message : String(err)
      },
      corsHeader
    );
  }
}

export async function handleRelayRequest(
  request: Request,
  env: RelayEnv,
  optionsOrConnect?: SocketConnectFn | RelayRequestOptions
): Promise<Response> {
  const opts: RelayRequestOptions =
    typeof optionsOrConnect === 'function'
      ? { connectImpl: optionsOrConnect }
      : optionsOrConnect ?? {};
  const connectImpl = opts.connectImpl;
  const dnsResolver = opts.dnsResolver ?? defaultDohResolver;
  const nowMs = opts.nowMs ?? Date.now();

  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const originCheck = validateOrigin(origin, env.ALLOWED_ORIGINS);
  const corsHeader = originCheck.ok ? (origin ?? '*') : null;

  if (request.method === 'OPTIONS') {
    if (!originCheck.ok) {
      return jsonResponse(originCheck.status, {
        ok: false,
        code: originCheck.code,
        error: originCheck.message
      });
    }
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsHeader ?? '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, X-Relay-Token, Content-Type',
        Vary: 'Origin'
      }
    });
  }

  if (url.pathname === '/healthz' && request.method === 'GET') {
    const destMode = env.DESTINATION_MODE === 'public' ? 'public' : 'allowlist';
    const targetsConfigured =
      destMode === 'public' || Boolean((env.ALLOWED_SSH_TARGETS ?? '').trim());
    const missingConfiguration: string[] = [];
    if (!targetsConfigured) missingConfiguration.push('ALLOWED_SSH_TARGETS');
    if (!(env.ALLOWED_ORIGINS ?? '').trim()) missingConfiguration.push('ALLOWED_ORIGINS');
    const sessionAuth = (env.SESSION_SIGNING_SECRET ?? '').trim().length >= 16;
    const adminAuth = env.ENABLE_ADMIN_SHARED_TOKEN === '1' && Boolean((env.RELAY_AUTH_TOKEN ?? '').trim());
    if (!sessionAuth && !adminAuth) missingConfiguration.push('SESSION_SIGNING_SECRET');
    if (sessionAuth && !adminAuth) {
      try {
        const users = JSON.parse(env.AUTH_USERS_JSON ?? '{}') as unknown;
        if (!users || typeof users !== 'object' || Array.isArray(users) ||
            !Object.values(users).some((value) => typeof value === 'string' && value.length > 0)) {
          missingConfiguration.push('AUTH_USERS_JSON');
        }
      } catch {
        missingConfiguration.push('AUTH_USERS_JSON');
      }
    }
    if (!env.USER_QUOTA_DO) missingConfiguration.push('USER_QUOTA_DO');
    return jsonResponse(
      200,
      {
        status: missingConfiguration.length === 0 ? 'ok' : 'misconfigured',
        missingConfiguration,
        mode: 'cloudflare-relay',
        destinationMode: destMode,
        tlsEnabled:
          url.protocol === 'https:' || request.headers.get('X-Forwarded-Proto') === 'https',
        authRequired: true,
        authMode: (env.SESSION_SIGNING_SECRET ?? '').trim() ? 'session-jwt' : 'admin-token',
        quotaDurableObjectBound: Boolean(env.USER_QUOTA_DO),
        guestMode: Boolean((env.TURNSTILE_SECRET_KEY ?? '').trim()),
        targetsConfigured,
        allowedPorts: (env.ALLOWED_SSH_PORTS ?? '22,2222')
          .split(',')
          .map((p) => Number(p.trim()))
          .filter(Boolean)
      },
      corsHeader ?? '*'
    );
  }

  if (url.pathname === '/auth/session' && request.method === 'POST') {
    if (!originCheck.ok) {
      return jsonResponse(
        originCheck.status,
        { ok: false, code: originCheck.code, error: originCheck.message },
        null
      );
    }
    return handleAuthSessionIssue(request, env, corsHeader, nowMs);
  }

  if (url.pathname === '/auth/ticket' && request.method === 'POST') {
    if (!originCheck.ok) {
      return jsonResponse(
        originCheck.status,
        { ok: false, code: originCheck.code, error: originCheck.message },
        null
      );
    }
    return handleAuthTicketIssue(request, env, corsHeader, nowMs);
  }

  if (url.pathname !== '/ws') {
    return jsonResponse(404, { ok: false, code: 'ERR_NOT_FOUND', error: 'Not Found' }, corsHeader);
  }

  // 1. Validate Origin first
  if (!originCheck.ok) {
    return jsonResponse(
      originCheck.status,
      { ok: false, code: originCheck.code, error: originCheck.message },
      null
    );
  }

  // 2. Require authentication BEFORE any DNS resolution or TCP connection
  const authCheck = await authenticateRelayRequest(request, env, Math.floor(nowMs / 1000));
  if (!authCheck.ok) {
    return jsonResponse(
      authCheck.status,
      { ok: false, code: authCheck.code, error: authCheck.message },
      corsHeader
    );
  }

  if (!env.USER_QUOTA_DO) {
    return jsonResponse(503, {
      ok: false,
      code: 'ERR_CONFIG_MISSING',
      error: 'USER_QUOTA_DO binding is required before SSH connections are enabled.'
    }, corsHeader);
  }

  // A guest ticket is bound to one destination; refuse to reuse it elsewhere.
  const guestClaims = authCheck.claims?.kind === 'guest' ? authCheck.claims : null;
  if (guestClaims) {
    const requestedHost = (url.searchParams.get('host') ?? '')
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
    const requestedPort = Number(url.searchParams.get('port') ?? '22');
    if (guestClaims.dst !== requestedHost || guestClaims.dpt !== requestedPort) {
      return jsonResponse(
        403,
        {
          ok: false,
          code: 'ERR_TICKET_SCOPE',
          error: `This connection ticket is valid only for ${guestClaims.dst}:${guestClaims.dpt}.`
        },
        corsHeader
      );
    }
  }

  // Guests have no account, so their quota key is the edge client IP. Without
  // one the key would be per-ticket, which silently disables the limit.
  const clientIp = (request.headers.get('CF-Connecting-IP') ?? '').trim();
  if (guestClaims && !clientIp) {
    return jsonResponse(
      403,
      {
        ok: false,
        code: 'ERR_RELAY_AUTH_FAILED',
        error: 'Guest connections require a client IP; connect through the Cloudflare edge.'
      },
      corsHeader
    );
  }
  const userId = guestClaims
    ? `guest:${clientIp}`
    : authCheck.userId ?? 'anonymous';

  // 3. Centrally enforce per-user connection-attempt and concurrent-session limits via Durable Object
  const maxConcurrent =
    Number(env.MAX_CONCURRENT_SESSIONS_PER_USER ?? DEFAULT_MAX_CONCURRENT_PER_USER) ||
    DEFAULT_MAX_CONCURRENT_PER_USER;
  const maxAttemptsPerMin =
    Number(env.MAX_CONNECTION_ATTEMPTS_PER_MIN ?? DEFAULT_MAX_ATTEMPTS_PER_MIN) ||
    DEFAULT_MAX_ATTEMPTS_PER_MIN;

  const connId = `conn_${nowMs}_${Math.random().toString(36).slice(2, 10)}`;
  let releaseQuota: () => Promise<void> = async () => {};

  if (env.USER_QUOTA_DO) {
    const doId = env.USER_QUOTA_DO.idFromName(userId);
    const stub = env.USER_QUOTA_DO.get(doId);
    const quotaRes = await stub.fetch('https://quota.internal/acquire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connId,
        maxConcurrent,
        maxAttemptsPerMin,
        nowMs
      })
    });
    if (!quotaRes.ok) {
      const quotaErr = (await quotaRes.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
      };
      return jsonResponse(
        quotaRes.status,
        {
          ok: false,
          code: quotaErr.code ?? 'ERR_RATE_LIMITED',
          error: quotaErr.message ?? 'Per-user connection limit exceeded.'
        },
        corsHeader
      );
    }
    let released = false;
    releaseQuota = async () => {
      if (released) return;
      released = true;
      try {
        await stub.fetch('https://quota.internal/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connId })
        });
      } catch {
        // ignore release errors
      }
    };
  }

  // 4. Resolve A/AAAA records & validate destination IP against bogon/SSRF/rebinding rules
  const targetHost = (url.searchParams.get('host') ?? '').trim();
  const targetPort = Number(url.searchParams.get('port') ?? '22');
  const destCheck = await resolveAndValidateDestination(
    targetHost,
    targetPort,
    env,
    dnsResolver
  );
  if (!destCheck.ok || !destCheck.resolvedIp) {
    await releaseQuota();
    return jsonResponse(
      destCheck.status,
      { ok: false, code: destCheck.code, error: destCheck.message },
      corsHeader
    );
  }

  const validatedConnectIp = destCheck.resolvedIp;

  const upgradeHeader = request.headers.get('Upgrade') ?? '';
  if (upgradeHeader.toLowerCase() !== 'websocket') {
    await releaseQuota();
    return jsonResponse(
      426,
      {
        ok: false,
        code: 'OK',
        status: 'upgrade_required',
        resolvedIp: validatedConnectIp,
        message: 'WebSocket Upgrade header required for SSH relay.'
      },
      corsHeader
    );
  }

  const connectTimeoutMs =
    Number(env.CONNECT_TIMEOUT_MS ?? DEFAULT_CONNECT_TIMEOUT_MS) || DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs =
    Number(env.IDLE_TIMEOUT_MS ?? DEFAULT_IDLE_TIMEOUT_MS) || DEFAULT_IDLE_TIMEOUT_MS;

  // 5. Connect directly to the validated IP (NEVER re-resolve targetHost during connect)
  let tcpSocket: TcpSocketLike;
  try {
    tcpSocket = connectImpl
      ? connectImpl(
          { hostname: validatedConnectIp, port: targetPort },
          { secureTransport: 'off', allowHalfOpen: false }
        )
      : await defaultCloudflareConnect(
          { hostname: validatedConnectIp, port: targetPort },
          { secureTransport: 'off', allowHalfOpen: false }
        );

    await Promise.race([
      tcpSocket.opened,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`TCP connection to ${validatedConnectIp}:${targetPort} timed out`)),
          connectTimeoutMs
        )
      )
    ]);
  } catch (err) {
    await releaseQuota();
    return jsonResponse(
      502,
      {
        ok: false,
        code: 'ERR_RELAY_UNREACHABLE',
        error: `Failed to connect to SSH host ${targetHost} (${validatedConnectIp}:${targetPort}): ${
          err instanceof Error ? err.message : String(err)
        }`
      },
      corsHeader
    );
  }

  const WebSocketPairCtor = (globalThis as unknown as {
    WebSocketPair?: new () => { 0: WebSocket; 1: WebSocket & { accept(): void } };
  }).WebSocketPair;

  if (!WebSocketPairCtor) {
    await tcpSocket.close();
    await releaseQuota();
    return jsonResponse(
      500,
      { ok: false, code: 'ERR_CONFIG_MISSING', error: 'WebSocketPair runtime API not available' },
      corsHeader
    );
  }

  const pair = new WebSocketPairCtor();
  const clientWs = pair[0];
  const serverWs = pair[1];
  serverWs.accept();

  bridgeWebSocketAndTcp(serverWs, tcpSocket, idleTimeoutMs, releaseQuota);

  const responseHeaders = new Headers();
  if (corsHeader) {
    responseHeaders.set('Access-Control-Allow-Origin', corsHeader);
  }
  const requestedProto = request.headers.get('Sec-WebSocket-Protocol');
  if (requestedProto && requestedProto.includes('webssh-relay.v1')) {
    responseHeaders.set('Sec-WebSocket-Protocol', 'webssh-relay.v1');
  }

  try {
    return new Response(null, {
      status: 101,
      webSocket: clientWs,
      headers: responseHeaders
    } as ResponseInit & { webSocket: WebSocket });
  } catch {
    // Node.js / undici Response constructor only allows status 200..599 outside Cloudflare workerd
    const fallback = new Response(null, { status: 200, headers: responseHeaders });
    Object.defineProperty(fallback, 'status', { value: 101 });
    Object.defineProperty(fallback, 'webSocket', { value: clientWs });
    return fallback;
  }
}

export function bridgeWebSocketAndTcp(
  ws: WebSocket & { bufferedAmount?: number },
  tcpSocket: TcpSocketLike,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  onCleanup?: () => Promise<void> | void
): void {
  const writer = tcpSocket.writable.getWriter();
  const reader = tcpSocket.readable.getReader();
  let closed = false;
  let bannerVerified = false;
  let writeChain = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (code = 1000, reason = 'Session closed'): void => {
    if (closed) return;
    closed = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    try {
      void onCleanup?.();
    } catch {
      // ignore
    }
    try {
      void reader.cancel();
    } catch {
      // ignore
    }
    try {
      void writer.close();
    } catch {
      // ignore
    }
    try {
      void tcpSocket.close();
    } catch {
      // ignore
    }
    try {
      ws.close(code, reason.slice(0, 120));
    } catch {
      // ignore
    }
  };

  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      cleanup(1008, 'Idle timeout exceeded');
    }, idleTimeoutMs);
  };

  resetIdleTimer();

  ws.addEventListener('message', (event: MessageEvent) => {
    if (closed) return;
    resetIdleTimer();

    let bytes: Uint8Array;
    if (event.data instanceof Uint8Array) {
      bytes = event.data;
    } else if (ArrayBuffer.isView(event.data)) {
      bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    } else if (
      event.data instanceof ArrayBuffer ||
      (typeof event.data === 'object' &&
        event.data !== null &&
        Object.prototype.toString.call(event.data) === '[object ArrayBuffer]')
    ) {
      bytes = new Uint8Array(event.data as ArrayBuffer);
    } else if (typeof event.data === 'string') {
      bytes = new TextEncoder().encode(event.data);
    } else {
      cleanup(1003, 'Unsupported WebSocket frame type');
      return;
    }

    if (bytes.byteLength > MAX_WS_MESSAGE_BYTES) {
      cleanup(1009, `Frame exceeds ${MAX_WS_MESSAGE_BYTES} byte limit`);
      return;
    }

    writeChain = writeChain
      .then(async () => {
        if (closed) return;
        await writer.write(bytes);
      })
      .catch(() => {
        cleanup(1011, 'TCP write failed');
      });
  });

  ws.addEventListener('close', () => {
    cleanup(1000, 'Client closed WebSocket');
  });

  ws.addEventListener('error', () => {
    cleanup(1011, 'WebSocket error');
  });

  void (async () => {
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done || !value) {
          cleanup(1000, 'Remote SSH server closed connection');
          break;
        }
        resetIdleTimer();

        if (!bannerVerified) {
          const check = verifySshServerBanner(value);
          if (!check.ok) {
            cleanup(1008, check.message);
            break;
          }
          bannerVerified = true;
        }

        while (!closed && (ws.bufferedAmount ?? 0) > MAX_BUFFERED_AMOUNT_BYTES) {
          await new Promise((r) => setTimeout(r, 15));
        }
        if (closed) break;

        ws.send(value);
      }
    } catch {
      cleanup(1011, 'Remote TCP stream error');
    }
  })();
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handleRelayRequest(request, env);
  }
};
