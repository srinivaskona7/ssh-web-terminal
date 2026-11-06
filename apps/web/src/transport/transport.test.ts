import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { FrameType, decodeControlPayload, decodeFrame, encodeControlFrame, encodeFrame } from '@webssh/protocol';
import {
  BrowserSshRelaySessionClient,
  GatewaySessionTransport,
  LiveGatewaySessionClient,
  MAX_PENDING_INPUT_BYTES,
  PendingInputQueue,
  buildTmuxAttachCommand,
  computeBackoffMs,
  deriveGatewayHealthUrl,
  isStaticPagesHost,
  resolveGatewayWsUrl,
  resolveTransportBackendMode,
  validateGatewayWsUrl,
  type LiveConnectParams
} from './index.js';

describe('Transport Resilience & Sequence Replay (M4)', () => {
  it('rejects GitHub Pages (*.github.io) as a gateway URL and resolves real configurable gateway endpoints', () => {
    expect(isStaticPagesHost('srinivaskona7.github.io')).toBe(true);
    expect(isStaticPagesHost('wss://srinivaskona7.github.io:8080/ws')).toBe(true);
    expect(isStaticPagesHost('wss://ssh-gateway.ec2.example.com/ws')).toBe(false);

    const ghCheck = validateGatewayWsUrl('wss://srinivaskona7.github.io/ws');
    expect(ghCheck.valid).toBe(false);
    expect(ghCheck.error).toContain('GitHub Pages');

    const ec2Check = validateGatewayWsUrl('https://ssh-gateway.ec2.example.com');
    expect(ec2Check.valid).toBe(true);
    expect(ec2Check.normalizedUrl).toBe('wss://ssh-gateway.ec2.example.com/ws');
    expect(deriveGatewayHealthUrl(ec2Check.normalizedUrl)).toBe(
      'https://ssh-gateway.ec2.example.com/healthz'
    );

    // Ensure stale GitHub Pages URLs in localStorage are automatically purged
    globalThis.localStorage?.setItem('webssh.gateway.wsUrl', 'wss://srinivaskona7.github.io:8080/ws');
    const resolved = resolveGatewayWsUrl();
    expect(resolved).not.toContain('github.io');
    expect(globalThis.localStorage?.getItem('webssh.gateway.wsUrl')).toBeNull();
  });

  it('selects the relay protocol for Worker endpoints and preserves explicit user choices', () => {
    globalThis.localStorage?.removeItem('webssh.transport.mode');
    expect(resolveTransportBackendMode('wss://webssh-studio-relay.life-magic.workers.dev/ws')).toBe('cloudflare-relay');
    expect(resolveTransportBackendMode('wss://gateway.example.com/ws')).toBe('go-gateway');
    globalThis.localStorage?.setItem('webssh.transport.mode', 'go-gateway');
    expect(resolveTransportBackendMode('wss://webssh-studio-relay.life-magic.workers.dev/ws')).toBe('go-gateway');
    globalThis.localStorage?.removeItem('webssh.transport.mode');
  });

  it('computes exponential backoff with jitter within expected bounds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 12 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (attempt, randVal) => {
          const delay = computeBackoffMs(attempt, 250, 15_000, () => randVal);
          const ceiling = Math.min(15_000, 250 * Math.pow(2, attempt));
          expect(delay).toBeGreaterThanOrEqual(250);
          expect(delay).toBeLessThanOrEqual(ceiling);
        }
      )
    );
  });

  it('queues up to 64 KiB of pending input while disconnected and flushes in order', () => {
    const queue = new PendingInputQueue();
    const chunk32k = new Uint8Array(32 * 1024).fill(0x41);
    expect(queue.enqueue(1, 1n, chunk32k)).toBe(true);
    expect(queue.enqueue(1, 2n, chunk32k)).toBe(true);
    expect(queue.byteLength).toBe(MAX_PENDING_INPUT_BYTES);

    // Overflow beyond 64 KiB is rejected
    expect(queue.enqueue(1, 3n, new Uint8Array([0x42]))).toBe(false);

    const drained = queue.drain();
    expect(drained.length).toBe(2);
    expect(drained[0]!.seq).toBe(1n);
    expect(drained[1]!.seq).toBe(2n);
    expect(queue.byteLength).toBe(0);
  });

  it('deduplicates replayed frames and sends credit replenishment and sign_response', async () => {
    const receivedPty: Uint8Array[] = [];
    const sentFrames: Uint8Array[] = [];

    const transport = new GatewaySessionTransport({
      onPtyData: (_ch, data) => receivedPty.push(data),
      onSignRequest: async (req) => `sig-for-${req.requestId}`,
      onHostKeyPrompt: async () => true
    });

    // Queue input while disconnected
    transport.sendPtyInput(1, new Uint8Array([0x6c, 0x73])); // "ls"
    expect(transport.inputQueue.byteLength).toBe(2);

    // Connect and verify queued input flushes immediately
    transport.attachSender((bytes) => sentFrames.push(bytes));
    expect(transport.inputQueue.byteLength).toBe(0);
    expect(sentFrames.length).toBe(1);

    // Receive PtyData seq=1 and duplicate seq=1
    await transport.handleInboundBytes(
      encodeFrame({
        type: FrameType.PtyData,
        channel: 1,
        seq: 1n,
        payload: new Uint8Array([0x6f, 0x6b])
      })
    );
    await transport.handleInboundBytes(
      encodeFrame({
        type: FrameType.PtyData,
        channel: 1,
        seq: 1n,
        payload: new Uint8Array([0x6f, 0x6b])
      })
    );
    expect(receivedPty.length).toBe(1);

    // Remote-signer sign_request -> sign_response
    await transport.handleInboundBytes(
      encodeControlFrame(2n, {
        type: 'sign_request',
        requestId: 'req-42',
        algorithm: 'ssh-ed25519',
        dataBase64: 'AAAA',
        keyFingerprint: 'SHA256:test'
      })
    );
    const lastSent = decodeFrame(sentFrames[sentFrames.length - 1]!);
    expect(lastSent.type).toBe(FrameType.Control);
    const ctrl = decodeControlPayload(lastSent.payload);
    expect(ctrl).toEqual({
      type: 'sign_response',
      requestId: 'req-42',
      signatureBase64: 'sig-for-req-42'
    });

    // Verify resume message carries lastSeq
    const resumeMsg = transport.seqTracker.buildResumeMessage('sess-99', 'tok-abc');
    expect(resumeMsg).toEqual({
      type: 'resume',
      sessionId: 'sess-99',
      token: 'tok-abc',
      lastSeq: '1'
    });
  });

  it('formats tmux auto-attach commands safely', () => {
    expect(buildTmuxAttachCommand('prod_ops-1')).toBe('tmux new-session -A -s prod_ops-1');
    expect(buildTmuxAttachCommand('bad;rm -rf /')).toBe('tmux new-session -A -s badrm-rf');
  });
});

/**
 * WebSocket double for the connect handshake: the test needs to read the
 * control messages the client sends, which the shared loopback socket does not
 * expose.
 */
class ConnectRecordingSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: ConnectRecordingSocket[] = [];

  readyState = ConnectRecordingSocket.CONNECTING;
  binaryType = 'arraybuffer';
  sent: ArrayBuffer[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public readonly url: string) {
    ConnectRecordingSocket.instances.push(this);
  }

  send(data: ArrayBuffer | Uint8Array): void {
    this.sent.push(data instanceof Uint8Array ? (data.slice().buffer as ArrayBuffer) : data);
  }

  close(): void {
    this.readyState = ConnectRecordingSocket.CLOSED;
    this.onclose?.();
  }

  fireOpen(): void {
    this.readyState = ConnectRecordingSocket.OPEN;
    this.onopen?.();
  }

  receiveControl(msg: Parameters<typeof encodeControlFrame>[1], seq: bigint): void {
    const frame = encodeControlFrame(seq, msg);
    this.onmessage?.({
      data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer
    });
  }

  controls(): Array<{ type: string; [key: string]: unknown }> {
    const messages: Array<{ type: string; [key: string]: unknown }> = [];
    for (const buffer of this.sent) {
      const frame = decodeFrame(new Uint8Array(buffer));
      if (frame.type !== FrameType.Control) continue;
      messages.push(decodeControlPayload(frame.payload) as unknown as { type: string });
    }
    return messages;
  }
}

function gatewayParams(overrides: Partial<LiveConnectParams> = {}): LiveConnectParams {
  return {
    gatewayUrl: 'wss://gateway.example.com/ws',
    host: '10.0.0.9',
    port: 22,
    user: 'ubuntu',
    authMethod: 'password',
    password: 'secret',
    cols: 80,
    rows: 24,
    onPtyData: () => undefined,
    onHostKeyPrompt: async () => true,
    ...overrides
  };
}

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  ConnectRecordingSocket.instances = [];
});

const connectedFrame = {
  type: 'connected' as const,
  sessionId: 'sess-jump',
  resumeToken: 'tok-jump',
  ptyChannel: 1,
  cipher: 'aes128-ctr',
  serverVersion: 'SSH-2.0-Test'
};

describe('ProxyJump transport wiring', () => {  it('sends the saved jump hops in the gateway connect message', async () => {
    globalThis.WebSocket = ConnectRecordingSocket as unknown as typeof WebSocket;
    const jumpHops = [
      { host: 'bastion.example.com', port: 2222, user: 'jumpuser' },
      { host: '10.1.0.5', port: 22, user: 'ubuntu' }
    ];
    const client = new LiveGatewaySessionClient(gatewayParams({ jumpHops }));

    const pending = client.connect();
    const socket = ConnectRecordingSocket.instances[0]!;
    socket.fireOpen();

    const connect = socket.controls().find((msg) => msg.type === 'connect');
    expect(connect?.jump).toEqual(jumpHops);
    socket.receiveControl(connectedFrame, 1n);
    await expect(pending).resolves.toMatchObject({ sessionId: 'sess-jump' });
  });

  it('omits jump entirely for a direct connection', async () => {
    globalThis.WebSocket = ConnectRecordingSocket as unknown as typeof WebSocket;
    const client = new LiveGatewaySessionClient(gatewayParams());

    const pending = client.connect();
    const socket = ConnectRecordingSocket.instances[0]!;
    socket.fireOpen();

    const connect = socket.controls().find((msg) => msg.type === 'connect');
    expect(connect).toBeDefined();
    expect(connect && 'jump' in connect).toBe(false);
    socket.receiveControl(connectedFrame, 1n);
    await expect(pending).resolves.toMatchObject({ sessionId: 'sess-jump' });
  });

  it('fails the relay connect instead of silently dropping jump hops', async () => {
    const client = new BrowserSshRelaySessionClient(
      gatewayParams({
        transportMode: 'cloudflare-relay',
        gatewayUrl: 'wss://webssh-studio-relay.life-magic.workers.dev/ws',
        jumpHops: [{ host: 'bastion.example.com', port: 22, user: 'jumpuser' }]
      })
    );

    await expect(client.connect()).rejects.toThrow(/ProxyJump requires the Go gateway/i);
  });
});
