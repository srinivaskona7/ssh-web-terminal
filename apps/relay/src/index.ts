import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_BUFFERED_AMOUNT_BYTES,
  MAX_WS_MESSAGE_BYTES,
  validateDestination,
  validateOrigin,
  validateRelayAuthToken,
  verifySshServerBanner,
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

async function defaultCloudflareConnect(
  address: { hostname: string; port: number },
  options?: { secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen?: boolean }
): Promise<TcpSocketLike> {
  // Dynamically import cloudflare:sockets in Cloudflare Workers runtime
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
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, X-Relay-Token, Content-Type');
  return new Response(JSON.stringify(body), { status, headers });
}

export async function handleRelayRequest(
  request: Request,
  env: RelayEnv,
  connectImpl?: SocketConnectFn
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const originCheck = validateOrigin(origin, env.ALLOWED_ORIGINS);
  const corsHeader = originCheck.ok ? (origin ?? '*') : null;

  if (request.method === 'OPTIONS') {
    if (!originCheck.ok) {
      return jsonResponse(originCheck.status, { ok: false, code: originCheck.code, error: originCheck.message });
    }
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsHeader ?? '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, X-Relay-Token, Content-Type',
        Vary: 'Origin'
      }
    });
  }

  if (url.pathname === '/healthz') {
    const targetsConfigured = Boolean((env.ALLOWED_SSH_TARGETS ?? '').trim());
    const authConfigured = Boolean((env.RELAY_AUTH_TOKEN ?? '').trim() || env.ALLOW_UNAUTHENTICATED_DEV === '1');
    return jsonResponse(
      200,
      {
        status: targetsConfigured && authConfigured ? 'ok' : 'misconfigured',
        mode: 'cloudflare-relay',
        tlsEnabled: url.protocol === 'https:' || request.headers.get('X-Forwarded-Proto') === 'https',
        authRequired: Boolean((env.RELAY_AUTH_TOKEN ?? '').trim()),
        targetsConfigured,
        allowedPorts: (env.ALLOWED_SSH_PORTS ?? '22,2222')
          .split(',')
          .map((p) => Number(p.trim()))
          .filter(Boolean)
      },
      corsHeader ?? '*'
    );
  }

  if (url.pathname !== '/ws') {
    return jsonResponse(404, { ok: false, code: 'ERR_NOT_FOUND', error: 'Not Found' }, corsHeader);
  }

  if (!originCheck.ok) {
    return jsonResponse(
      originCheck.status,
      { ok: false, code: originCheck.code, error: originCheck.message },
      null
    );
  }

  const authCheck = validateRelayAuthToken(request, env);
  if (!authCheck.ok) {
    return jsonResponse(
      authCheck.status,
      { ok: false, code: authCheck.code, error: authCheck.message },
      corsHeader
    );
  }

  const targetHost = (url.searchParams.get('host') ?? '').trim();
  const targetPort = Number(url.searchParams.get('port') ?? '22');
  const destCheck = validateDestination(targetHost, targetPort, env);
  if (!destCheck.ok) {
    return jsonResponse(
      destCheck.status,
      { ok: false, code: destCheck.code, error: destCheck.message },
      corsHeader
    );
  }

  const upgradeHeader = request.headers.get('Upgrade') ?? '';
  if (upgradeHeader.toLowerCase() !== 'websocket') {
    return jsonResponse(
      426,
      {
        ok: false,
        code: 'OK',
        status: 'upgrade_required',
        message: 'WebSocket Upgrade header required for SSH relay.'
      },
      corsHeader
    );
  }

  const connectTimeoutMs = Number(env.CONNECT_TIMEOUT_MS ?? DEFAULT_CONNECT_TIMEOUT_MS) || DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = Number(env.IDLE_TIMEOUT_MS ?? DEFAULT_IDLE_TIMEOUT_MS) || DEFAULT_IDLE_TIMEOUT_MS;

  let tcpSocket: TcpSocketLike;
  try {
    tcpSocket = connectImpl
      ? connectImpl({ hostname: targetHost, port: targetPort }, { secureTransport: 'off', allowHalfOpen: false })
      : await defaultCloudflareConnect(
          { hostname: targetHost, port: targetPort },
          { secureTransport: 'off', allowHalfOpen: false }
        );

    await Promise.race([
      tcpSocket.opened,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`TCP connection to ${targetHost}:${targetPort} timed out`)), connectTimeoutMs)
      )
    ]);
  } catch (err) {
    return jsonResponse(
      502,
      {
        ok: false,
        code: 'ERR_RELAY_UNREACHABLE',
        error: `Failed to connect to SSH host ${targetHost}:${targetPort}: ${
          err instanceof Error ? err.message : String(err)
        }`
      },
      corsHeader
    );
  }

  // Cloudflare Workers WebSocketPair upgrade
  const WebSocketPairCtor = (globalThis as unknown as {
    WebSocketPair?: new () => { 0: WebSocket; 1: WebSocket & { accept(): void } };
  }).WebSocketPair;

  if (!WebSocketPairCtor) {
    await tcpSocket.close();
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

  bridgeWebSocketAndTcp(serverWs, tcpSocket, idleTimeoutMs);

  const responseHeaders = new Headers();
  if (corsHeader) {
    responseHeaders.set('Access-Control-Allow-Origin', corsHeader);
  }
  const requestedProto = request.headers.get('Sec-WebSocket-Protocol');
  if (requestedProto && requestedProto.includes('webssh-relay.v1')) {
    responseHeaders.set('Sec-WebSocket-Protocol', 'webssh-relay.v1');
  }

  return new Response(null, {
    status: 101,
    webSocket: clientWs,
    headers: responseHeaders
  } as ResponseInit & { webSocket: WebSocket });
}

export function bridgeWebSocketAndTcp(
  ws: WebSocket & { bufferedAmount?: number },
  tcpSocket: TcpSocketLike,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS
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

        // Bounded buffering & backpressure check on outbound WebSocket
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
