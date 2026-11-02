import { describe, expect, it } from 'vitest';
import {
  bridgeWebSocketAndTcp,
  handleRelayRequest,
  type TcpSocketLike
} from './index.js';
import {
  MAX_WS_MESSAGE_BYTES,
  validateDestination,
  validateOrigin,
  validateRelayAuthToken,
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
    const bytes =
      data instanceof Uint8Array
        ? new Uint8Array(data)
        : new Uint8Array(data);
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

describe('Cloudflare Worker SSH Relay Security Policy & Stream Bridge (Step 18)', () => {
  const baseEnv: RelayEnv = {
    ALLOWED_ORIGINS: 'https://srinivaskona7.github.io,http://127.0.0.1:4273',
    ALLOWED_SSH_TARGETS: 'ec2-*.compute.amazonaws.com,203.0.113.0/24,ssh.example.com',
    ALLOWED_SSH_PORTS: '22,2222',
    RELAY_AUTH_TOKEN: 'cf-relay-secret-2026'
  };

  it('validates Origin headers strictly and rejects missing or unauthorized origins', () => {
    expect(validateOrigin('https://srinivaskona7.github.io', baseEnv.ALLOWED_ORIGINS).ok).toBe(true);
    expect(validateOrigin(null, baseEnv.ALLOWED_ORIGINS).code).toBe('ERR_ORIGIN_DENIED');
    expect(validateOrigin('https://evil.example.org', baseEnv.ALLOWED_ORIGINS).code).toBe(
      'ERR_ORIGIN_DENIED'
    );
  });

  it('requires RELAY_AUTH_TOKEN and validates Bearer, X-Relay-Token, subprotocol, and query tokens in constant time', () => {
    const missingSecretReq = new Request('https://relay.example.workers.dev/ws?host=ssh.example.com&port=22');
    expect(validateRelayAuthToken(missingSecretReq, { ...baseEnv, RELAY_AUTH_TOKEN: '' }).code).toBe(
      'ERR_CONFIG_MISSING'
    );

    const badReq = new Request('https://relay.example.workers.dev/ws?token=wrong-token');
    expect(validateRelayAuthToken(badReq, baseEnv).code).toBe('ERR_RELAY_AUTH_FAILED');

    const goodBearerReq = new Request('https://relay.example.workers.dev/ws', {
      headers: { Authorization: 'Bearer cf-relay-secret-2026' }
    });
    expect(validateRelayAuthToken(goodBearerReq, baseEnv).ok).toBe(true);

    const goodSubprotoReq = new Request('https://relay.example.workers.dev/ws', {
      headers: { 'Sec-WebSocket-Protocol': 'webssh-relay.v1, token.cf-relay-secret-2026' }
    });
    expect(validateRelayAuthToken(goodSubprotoReq, baseEnv).ok).toBe(true);
  });

  it('never acts as an unrestricted TCP proxy and blocks SSRF, metadata, private IPs, and disallowed hosts/ports', () => {
    // Empty ALLOWED_SSH_TARGETS denies everything
    expect(validateDestination('ssh.example.com', 22, { ...baseEnv, ALLOWED_SSH_TARGETS: '' }).code).toBe(
      'ERR_DESTINATION_DENIED'
    );
    // Wildcard "*" is forbidden
    expect(validateDestination('ssh.example.com', 22, { ...baseEnv, ALLOWED_SSH_TARGETS: '*' }).code).toBe(
      'ERR_DESTINATION_DENIED'
    );
    // Cloud metadata IP 169.254.169.254 is always blocked
    expect(
      validateDestination('169.254.169.254', 22, {
        ...baseEnv,
        ALLOWED_SSH_TARGETS: '169.254.169.254',
        ALLOW_LOOPBACK_FOR_TESTS: '1'
      }).code
    ).toBe('ERR_DESTINATION_DENIED');
    // Private RFC1918 IP is blocked on public Cloudflare Relay
    expect(
      validateDestination('10.0.0.15', 22, { ...baseEnv, ALLOWED_SSH_TARGETS: '10.0.0.0/8' }).code
    ).toBe('ERR_DESTINATION_DENIED');
    // Disallowed port (e.g. 3306 MySQL) is blocked
    expect(validateDestination('ssh.example.com', 3306, baseEnv).code).toBe('ERR_DESTINATION_DENIED');
    // Unlisted public host is blocked
    expect(validateDestination('unapproved.example.com', 22, baseEnv).code).toBe(
      'ERR_DESTINATION_DENIED'
    );
    // Approved EC2 wildcard and CIDR targets on port 22 or 2222 succeed
    expect(
      validateDestination('ec2-54-210-11-99.compute.amazonaws.com', 22, baseEnv).ok
    ).toBe(true);
    expect(validateDestination('203.0.113.42', 2222, baseEnv).ok).toBe(true);
  });

  it('serves /healthz and returns accurate HTTP 401/403/426 responses on /ws', async () => {
    const healthRes = await handleRelayRequest(
      new Request('https://relay.example.workers.dev/healthz', {
        headers: { Origin: 'https://srinivaskona7.github.io' }
      }),
      baseEnv
    );
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { status: string; mode: string; targetsConfigured: boolean };
    expect(healthJson.status).toBe('ok');
    expect(healthJson.mode).toBe('cloudflare-relay');
    expect(healthJson.targetsConfigured).toBe(true);

    // Unauthorized origin -> 403
    const badOriginRes = await handleRelayRequest(
      new Request('https://relay.example.workers.dev/ws?host=ssh.example.com&port=22', {
        headers: { Origin: 'https://attacker.example.com' }
      }),
      baseEnv
    );
    expect(badOriginRes.status).toBe(403);

    // Bad token -> 401
    const badTokenRes = await handleRelayRequest(
      new Request('https://relay.example.workers.dev/ws?host=ssh.example.com&port=22&token=bad', {
        headers: { Origin: 'https://srinivaskona7.github.io' }
      }),
      baseEnv
    );
    expect(badTokenRes.status).toBe(401);

    // Denied destination -> 403
    const deniedHostRes = await handleRelayRequest(
      new Request(
        'https://relay.example.workers.dev/ws?host=forbidden.example.com&port=22&token=cf-relay-secret-2026',
        { headers: { Origin: 'https://srinivaskona7.github.io' } }
      ),
      baseEnv
    );
    expect(deniedHostRes.status).toBe(403);
  });

  it('bridges binary SSH-2.0 packets bidirectionally, rejects non-SSH banners, enforces frame limits, and cleans up on close', async () => {
    const crlf = String.fromCharCode(13, 10);
    expect(verifySshServerBanner(new TextEncoder().encode(`SSH-2.0-OpenSSH_9.6${crlf}`)).ok).toBe(true);
    expect(verifySshServerBanner(new TextEncoder().encode(`HTTP/1.1 200 OK${crlf}`)).code).toBe(
      'ERR_NON_SSH_BANNER'
    );

    const tcpReceived: Uint8Array[] = [];
    let tcpClosed = false;
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
      opened: Promise.resolve({ remoteAddress: '203.0.113.42' }),
      closed: Promise.resolve(),
      close() {
        tcpClosed = true;
      }
    };

    const ws = new MockWebSocket();
    bridgeWebSocketAndTcp(ws as unknown as WebSocket, mockTcp, 5000);

    // Server sends valid SSH-2.0 banner -> forwarded to WebSocket
    streamController!.enqueue(new TextEncoder().encode(`SSH-2.0-OpenSSH_9.6${crlf}`));
    await new Promise((r) => setTimeout(r, 15));
    expect(ws.sentMessages.length).toBe(1);
    expect(new TextDecoder().decode(ws.sentMessages[0])).toBe(`SSH-2.0-OpenSSH_9.6${crlf}`);

    // Client sends binary frame -> written to TCP writable stream
    ws.dispatchMessage(new TextEncoder().encode(`SSH-2.0-WebSSH_Studio_1.0${crlf}`).buffer);
    await new Promise((r) => setTimeout(r, 15));
    expect(tcpReceived.length).toBe(1);
    expect(new TextDecoder().decode(tcpReceived[0])).toBe(`SSH-2.0-WebSSH_Studio_1.0${crlf}`);

    // Frame exceeding MAX_WS_MESSAGE_BYTES triggers immediate 1009 cleanup
    ws.dispatchMessage(new Uint8Array(MAX_WS_MESSAGE_BYTES + 10));
    expect(ws.closeCode).toBe(1009);
    expect(tcpClosed).toBe(true);
  });
});
