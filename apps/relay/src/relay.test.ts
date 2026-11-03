import { describe, expect, it } from 'vitest';
import {
  authenticateRelayRequest,
  issueUserSessionToken,
  verifyUserSessionToken
} from './auth.js';
import {
  bridgeWebSocketAndTcp,
  createLocalUserQuotaNamespace,
  handleRelayRequest,
  type TcpSocketLike
} from './index.js';
import {
  MAX_WS_MESSAGE_BYTES,
  resolveAndValidateDestination,
  validateDestination,
  validateOrigin,
  verifySshServerBanner,
  type RelayEnv
} from './policy.js';

class MockWebSocket {
  public readyState = 1; // OPEN
  public bufferedAmount = 0;
  public sentMessages: Uint8Array[] = [];
  public closeCode: number | null = null;
  public closeReason = '';
  private listeners = new Map<string, Array<(ev: any) => void>>();

  accept(): void {}

  addEventListener(type: string, listener: (ev: any) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  send(data: ArrayBuffer | Uint8Array): void {
    const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
    this.sentMessages.push(bytes);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3; // CLOSED
    this.closeCode = code;
    this.closeReason = reason;
    for (const fn of this.listeners.get('close') ?? []) {
      fn({ code, reason });
    }
  }

  dispatchMessage(data: ArrayBuffer | Uint8Array | string): void {
    for (const fn of this.listeners.get('message') ?? []) {
      fn({ data });
    }
  }
}

describe('Cloudflare Worker SSH Relay: Public Mode, Anti-Rebinding DNS, Session JWTs & Central Quotas (Step 19)', () => {
  const signingSecret = 'super-secret-32-byte-hmac-signing-key-2026';

  const publicEnv: RelayEnv = {
    DESTINATION_MODE: 'public',
    ALLOWED_ORIGINS: 'https://srinivaskona7.github.io,http://127.0.0.1:4273',
    ALLOWED_SSH_TARGETS: '',
    ALLOWED_SSH_PORTS: '22,2222',
    SESSION_SIGNING_SECRET: signingSecret,
    SESSION_TOKEN_ISSUER: 'webssh-studio-relay',
    SESSION_TOKEN_AUDIENCE: 'webssh-relay',
    AUTH_USERS_JSON: JSON.stringify({ alice: 'correct-horse-battery-staple' })
  };

  const allowlistEnv: RelayEnv = {
    ...publicEnv,
    DESTINATION_MODE: 'allowlist',
    ALLOWED_SSH_TARGETS: 'ec2-*.compute.amazonaws.com,203.0.113.0/24,ssh.example.com'
  };

  it('permits multiple globally routable public IPv4 and IPv6 servers in DESTINATION_MODE="public" without per-IP allowlisting, while preserving allowlist mode', () => {
    // Public mode accepts any globally routable public IPv4/IPv6 on port 22 or 2222
    expect(validateDestination('8.8.8.8', 22, publicEnv).ok).toBe(true);
    expect(validateDestination('1.1.1.1', 2222, publicEnv).ok).toBe(true);
    expect(validateDestination('54.210.11.99', 22, publicEnv).ok).toBe(true);
    expect(validateDestination('2606:4700:4700::1111', 22, publicEnv).ok).toBe(true);
    expect(validateDestination('[2606:4700:4700::1111]', 22, publicEnv).ok).toBe(true);

    // Disallowed port (e.g. 3306 MySQL) is rejected even on a valid public IP
    expect(validateDestination('8.8.8.8', 3306, publicEnv).code).toBe('ERR_DESTINATION_DENIED');

    // Wildcard "*" in ALLOWED_SSH_TARGETS is always rejected
    expect(
      validateDestination('8.8.8.8', 22, { ...publicEnv, ALLOWED_SSH_TARGETS: '*' }).code
    ).toBe('ERR_DESTINATION_DENIED');

    // Allowlist mode still requires explicit match in ALLOWED_SSH_TARGETS
    expect(validateDestination('8.8.8.8', 22, allowlistEnv).code).toBe('ERR_DESTINATION_DENIED');
    expect(validateDestination('ec2-54-210-11-99.compute.amazonaws.com', 22, allowlistEnv).ok).toBe(
      true
    );
    expect(validateDestination('203.0.113.42', 2222, allowlistEnv).ok).toBe(true);
  });

  it('rejects all private, loopback, link-local, metadata, CGNAT, multicast, reserved, IPv4-mapped IPv6, and alternative IP encodings', () => {
    const blockedTargets = [
      // IPv4 special-purpose ranges
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.1',
      '10.255.255.254',
      '100.64.0.1',
      '100.127.255.254',
      '127.0.0.1',
      '127.0.1.1',
      '169.254.169.254',
      '169.254.0.1',
      '172.16.0.1',
      '172.31.255.254',
      '192.0.0.1',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.0.1',
      '192.168.1.254',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
      // IPv6 special-purpose, private, link-local, documentation, multicast
      '::',
      '::1',
      '[::1]',
      'fe80::1',
      'fc00::1',
      'fd12:3456:789a::1',
      'ff02::1',
      '2001:db8::1',
      '2001:10::1',
      '2001::1',
      '2002:7f00:0001::1',
      '64:ff9b::10.0.0.1',
      // IPv4-mapped & IPv4-compatible IPv6
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:10.0.0.1',
      '::ffff:8.8.8.8',
      '0:0:0:0:0:ffff:7f00:1',
      '0:0:0:0:0:ffff:a9fe:a9fe',
      '::127.0.0.1',
      // Alternative IP encodings (octal, hex, dword integer, shorthand)
      '0177.0.0.1',
      '010.0.0.1',
      '0x7f.0.0.1',
      '0x7f000001',
      '2130706433',
      '127.1',
      '127.0.1',
      '10.1.1',
      // Internal hostnames
      'localhost',
      'metadata.google.internal',
      'instance-data',
      'db.internal',
      'printer.local'
    ];

    for (const target of blockedTargets) {
      const res = validateDestination(target, 22, publicEnv);
      expect(res.ok, `Expected "${target}" to be rejected`).toBe(false);
      expect(res.code).toBe('ERR_DESTINATION_DENIED');
    }
  });

  it('prevents DNS rebinding by validating all resolved A/AAAA records and connecting directly to the validated IP', async () => {
    // 1. Safe public hostname resolves to 93.184.216.34 -> returns resolvedIp: 93.184.216.34
    const safeCheck = await resolveAndValidateDestination(
      'ssh-A.customer.example.com',
      22,
      publicEnv,
      async () => ['93.184.216.34']
    );
    expect(safeCheck.ok).toBe(true);
    expect(safeCheck.resolvedIp).toBe('93.184.216.34');
    expect(safeCheck.originalHost).toBe('ssh-A.customer.example.com');

    // 2. DNS rebinding attack returning one public IP + one loopback IP -> REJECTED
    const rebindLoopback = await resolveAndValidateDestination(
      'rebind.attacker.example.com',
      22,
      publicEnv,
      async () => ['93.184.216.34', '127.0.0.1']
    );
    expect(rebindLoopback.ok).toBe(false);
    expect(rebindLoopback.code).toBe('ERR_DESTINATION_DENIED');
    expect(rebindLoopback.message).toContain('DNS rebinding blocked');

    // 3. DNS rebinding attack returning AWS metadata IP 169.254.169.254 -> REJECTED
    const rebindMetadata = await resolveAndValidateDestination(
      'metadata-rebind.attacker.example.com',
      22,
      publicEnv,
      async () => ['169.254.169.254']
    );
    expect(rebindMetadata.ok).toBe(false);
    expect(rebindMetadata.code).toBe('ERR_DESTINATION_DENIED');

    // 4. DNS rebinding attack returning IPv4-mapped IPv6 ::ffff:10.0.0.1 -> REJECTED
    const rebindMappedV6 = await resolveAndValidateDestination(
      'v6-rebind.attacker.example.com',
      22,
      publicEnv,
      async () => ['::ffff:10.0.0.1']
    );
    expect(rebindMappedV6.ok).toBe(false);
    expect(rebindMappedV6.code).toBe('ERR_DESTINATION_DENIED');

    // 5. Empty DNS answer -> REJECTED
    const emptyDns = await resolveAndValidateDestination(
      'nxdomain.example.com',
      22,
      publicEnv,
      async () => []
    );
    expect(emptyDns.ok).toBe(false);
    expect(emptyDns.code).toBe('ERR_DESTINATION_DENIED');
  });

  it('issues short-lived user session JWTs via POST /auth/session, rejects expired/tampered tokens, and blocks shared tokens unless ENABLE_ADMIN_SHARED_TOKEN=1', async () => {
    const nowMs = 1_760_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);

    // 1. Login via POST /auth/session with valid user credentials
    const loginRes = await handleRelayRequest(
      new Request('https://relay.example.workers.dev/auth/session', {
        method: 'POST',
        headers: {
          Origin: 'https://srinivaskona7.github.io',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username: 'alice', password: 'correct-horse-battery-staple' })
      }),
      publicEnv,
      { nowMs }
    );
    expect(loginRes.status).toBe(200);
    const loginJson = (await loginRes.json()) as {
      ok: boolean;
      token: string;
      userId: string;
      expiresIn: number;
    };
    expect(loginJson.ok).toBe(true);
    expect(loginJson.userId).toBe('alice');
    expect(loginJson.expiresIn).toBe(900);

    // 2. Verify valid token
    const verified = await verifyUserSessionToken(loginJson.token, publicEnv, nowSec + 300);
    expect(verified.ok).toBe(true);
    expect(verified.userId).toBe('alice');

    // 3. Reject expired token (nowSec + 901)
    const expired = await verifyUserSessionToken(loginJson.token, publicEnv, nowSec + 901);
    expect(expired.ok).toBe(false);
    expect(expired.code).toBe('ERR_RELAY_AUTH_FAILED');
    expect(expired.message).toContain('expired');

    // 4. Reject token with wrong audience or issuer
    const wrongAud = await verifyUserSessionToken(
      loginJson.token,
      { ...publicEnv, SESSION_TOKEN_AUDIENCE: 'other-service' },
      nowSec + 10
    );
    expect(wrongAud.ok).toBe(false);

    // 5. Shared RELAY_AUTH_TOKEN is rejected when ENABLE_ADMIN_SHARED_TOKEN is not "1"
    const sharedAttempt = await authenticateRelayRequest(
      new Request('https://relay.example.workers.dev/ws?token=legacy-shared-token'),
      { ...publicEnv, RELAY_AUTH_TOKEN: 'legacy-shared-token' },
      nowSec
    );
    expect(sharedAttempt.ok).toBe(false);

    // 6. Shared RELAY_AUTH_TOKEN is accepted ONLY when ENABLE_ADMIN_SHARED_TOKEN="1"
    const adminAttempt = await authenticateRelayRequest(
      new Request('https://relay.example.workers.dev/ws?token=admin-ci-token'),
      { ...publicEnv, ENABLE_ADMIN_SHARED_TOKEN: '1', RELAY_AUTH_TOKEN: 'admin-ci-token' },
      nowSec
    );
    expect(adminAttempt.ok).toBe(true);
    expect(adminAttempt.userId).toBe('admin-shared');
  });

  it('requires authentication before DNS/TCP, connects cloudflare:sockets to the DNS-validated IP, and centrally enforces per-user rate & concurrency limits', async () => {
    const nowMs = 1_760_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    const { token } = await issueUserSessionToken('alice', publicEnv, 600, nowSec);

    let dnsCalled = 0;
    const dialedAddresses: Array<{ hostname: string; port: number }> = [];

    const envWithQuota: RelayEnv = {
      ...publicEnv,
      MAX_CONCURRENT_SESSIONS_PER_USER: '2',
      MAX_CONNECTION_ATTEMPTS_PER_MIN: '3',
      USER_QUOTA_DO: createLocalUserQuotaNamespace()
    };

    const mockDns = async (host: string): Promise<string[]> => {
      dnsCalled++;
      if (host === 'server1.customer.org') return ['54.210.11.99'];
      if (host === 'server2.customer.org') return ['35.180.42.10'];
      return [];
    };

    // 1. Unauthenticated request is rejected BEFORE DNS resolution or TCP connect
    const unauthRes = await handleRelayRequest(
      new Request('https://relay.example.workers.dev/ws?host=server1.customer.org&port=22', {
        headers: { Origin: 'https://srinivaskona7.github.io', Upgrade: 'websocket' }
      }),
      envWithQuota,
      { dnsResolver: mockDns, nowMs }
    );
    expect(unauthRes.status).toBe(401);
    expect(dnsCalled).toBe(0);

    // 2. Authenticated request to server1.customer.org resolves DNS and dials the validated IP (54.210.11.99)
    const prevPair = (globalThis as any).WebSocketPair;
    (globalThis as any).WebSocketPair = class {
      0 = new MockWebSocket();
      1 = new MockWebSocket();
    };

    const makeMockTcp = (): TcpSocketLike => ({
      readable: new ReadableStream<Uint8Array>({ start() {} }),
      writable: new WritableStream<Uint8Array>({ write() {} }),
      opened: Promise.resolve({}),
      closed: Promise.resolve(),
      close() {}
    });

    try {
      const wsRes1 = await handleRelayRequest(
        new Request(
          `https://relay.example.workers.dev/ws?host=server1.customer.org&port=22&token=${encodeURIComponent(token)}`,
          { headers: { Origin: 'https://srinivaskona7.github.io', Upgrade: 'websocket' } }
        ),
        envWithQuota,
        {
          dnsResolver: mockDns,
          nowMs,
          connectImpl: (addr) => {
            dialedAddresses.push(addr);
            return makeMockTcp();
          }
        }
      );
      expect(wsRes1.status).toBe(101);
      expect(dialedAddresses[0]).toEqual({ hostname: '54.210.11.99', port: 22 });

      // 3. Second concurrent session to a different public server (server2.customer.org -> 35.180.42.10) succeeds
      const wsRes2 = await handleRelayRequest(
        new Request(
          `https://relay.example.workers.dev/ws?host=server2.customer.org&port=2222&token=${encodeURIComponent(token)}`,
          { headers: { Origin: 'https://srinivaskona7.github.io', Upgrade: 'websocket' } }
        ),
        envWithQuota,
        {
          dnsResolver: mockDns,
          nowMs: nowMs + 100,
          connectImpl: (addr) => {
            dialedAddresses.push(addr);
            return makeMockTcp();
          }
        }
      );
      expect(wsRes2.status).toBe(101);
      expect(dialedAddresses[1]).toEqual({ hostname: '35.180.42.10', port: 2222 });

      // 4. Third concurrent session exceeds MAX_CONCURRENT_SESSIONS_PER_USER (2) -> 429 ERR_RATE_LIMITED
      const wsRes3 = await handleRelayRequest(
        new Request(
          `https://relay.example.workers.dev/ws?host=server1.customer.org&port=22&token=${encodeURIComponent(token)}`,
          { headers: { Origin: 'https://srinivaskona7.github.io', Upgrade: 'websocket' } }
        ),
        envWithQuota,
        { dnsResolver: mockDns, nowMs: nowMs + 200 }
      );
      expect(wsRes3.status).toBe(429);
      const err3 = (await wsRes3.json()) as { code: string; error: string };
      expect(err3.code).toBe('ERR_RATE_LIMITED');

      // 5. Fourth connection attempt within 60s exceeds MAX_CONNECTION_ATTEMPTS_PER_MIN (3) -> 429 ERR_RATE_LIMITED
      const wsRes4 = await handleRelayRequest(
        new Request(
          `https://relay.example.workers.dev/ws?host=server1.customer.org&port=22&token=${encodeURIComponent(token)}`,
          { headers: { Origin: 'https://srinivaskona7.github.io', Upgrade: 'websocket' } }
        ),
        envWithQuota,
        { dnsResolver: mockDns, nowMs: nowMs + 300 }
      );
      expect(wsRes4.status).toBe(429);
    } finally {
      (globalThis as any).WebSocketPair = prevPair;
    }
  });

  it('bridges binary SSH-2.0 packets bidirectionally, rejects non-SSH banners, enforces frame limits, and cleans up on close', async () => {
    const crlf = String.fromCharCode(13, 10);
    expect(verifySshServerBanner(new TextEncoder().encode(`SSH-2.0-OpenSSH_9.6${crlf}`)).ok).toBe(
      true
    );
    expect(verifySshServerBanner(new TextEncoder().encode(`HTTP/1.1 200 OK${crlf}`)).code).toBe(
      'ERR_NON_SSH_BANNER'
    );

    const tcpReceived: Uint8Array[] = [];
    let tcpClosed = false;
    let quotaReleased = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const mockTcp: TcpSocketLike = {
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        }
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          tcpReceived.push(new Uint8Array(chunk));
        }
      }),
      opened: Promise.resolve({ remoteAddress: '54.210.11.99' }),
      closed: Promise.resolve(),
      close() {
        tcpClosed = true;
      }
    };

    const ws = new MockWebSocket();
    bridgeWebSocketAndTcp(ws as unknown as WebSocket, mockTcp, 5000, () => {
      quotaReleased = true;
    });

    streamController!.enqueue(new TextEncoder().encode(`SSH-2.0-OpenSSH_9.6${crlf}`));
    await new Promise((r) => setTimeout(r, 15));
    expect(ws.sentMessages.length).toBe(1);

    ws.dispatchMessage(new TextEncoder().encode(`SSH-2.0-WebSSH_Studio_1.0${crlf}`).buffer);
    await new Promise((r) => setTimeout(r, 15));
    expect(tcpReceived.length).toBe(1);

    ws.dispatchMessage(new Uint8Array(MAX_WS_MESSAGE_BYTES + 10));
    expect(ws.closeCode).toBe(1009);
    expect(tcpClosed).toBe(true);
    expect(quotaReleased).toBe(true);
  });
});
