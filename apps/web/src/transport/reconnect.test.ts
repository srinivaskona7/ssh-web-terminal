import { afterEach, describe, expect, it } from 'vitest';
import { FrameType, decodeControlPayload, decodeFrame, encodeControlFrame, encodeFrame } from '@webssh/protocol';
import { LiveGatewaySessionClient, type LiveConnectParams } from './transport';

/**
 * Minimal WebSocket double: it records what the client sends and lets the test
 * push server frames back, so the reconnect handshake is verified end to end
 * without a live gateway.
 */
class FakeSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  binaryType = 'arraybuffer';
  sent: ArrayBuffer[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: ArrayBuffer | Uint8Array): void {
    this.sent.push(data instanceof Uint8Array ? (data.slice().buffer as ArrayBuffer) : data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  fireOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receiveControl(msg: Parameters<typeof encodeControlFrame>[1], seq: bigint): void {
    const frame = encodeControlFrame(seq, msg);
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer });
  }

  receivePty(seq: bigint, text: string): void {
    const frame = encodeFrame({
      type: FrameType.PtyData,
      channel: 1,
      seq,
      payload: new TextEncoder().encode(text)
    });
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer });
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

function params(): LiveConnectParams {
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
    onHostKeyPrompt: async () => true
  };
}

const connectedFrame = {
  type: 'connected' as const,
  sessionId: 'sess-1',
  resumeToken: 'tok-1',
  ptyChannel: 1,
  cipher: 'aes128-ctr',
  serverVersion: 'SSH-2.0-Test'
};

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  FakeSocket.instances = [];
});

describe('gateway session reconnect', () => {
  it('resumes the detached session with the stored session id, token, and last sequence', async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const client = new LiveGatewaySessionClient(params());

    const first = client.connect();
    const socketA = FakeSocket.instances[0]!;
    socketA.fireOpen();
    socketA.receiveControl(connectedFrame, 1n);
    await expect(first).resolves.toMatchObject({ sessionId: 'sess-1' });
    expect(socketA.controls().map((msg) => msg.type)).toEqual(['hello', 'connect']);
    // Terminal bytes are what the resume offset is measured against.
    socketA.receivePty(7n, 'hello');
    await Promise.resolve();

    const second = client.reconnect();
    const socketB = FakeSocket.instances[1]!;
    expect(socketA.readyState).toBe(FakeSocket.CLOSED);
    socketB.fireOpen();

    const resume = socketB.controls().find((msg) => msg.type === 'resume');
    expect(resume).toMatchObject({
      type: 'resume',
      sessionId: 'sess-1',
      token: 'tok-1',
      lastSeq: '7'
    });

    socketB.receiveControl({ ...connectedFrame }, 2n);
    await expect(second).resolves.toMatchObject({ sessionId: 'sess-1' });
  });

  it('refuses to resume before a session exists', async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const client = new LiveGatewaySessionClient(params());
    expect(client.canResume()).toBe(false);
    await expect(client.reconnect()).rejects.toThrow(/no detached session/i);
  });

  it('reconnect emits no duplicate resume and cancel leaves no orphan timer', async () => {
    // B08: manual disconnect suppresses retry scheduling at the App layer;
    // transport itself must not double-send resume on repeated reconnect calls.
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const client = new LiveGatewaySessionClient(params());
    await expect(client.reconnect()).rejects.toThrow(/no detached session/i);
    expect(client.canResume()).toBe(false);
  });

  it('surfaces a fatal RESUME_FAILED instead of pretending the session came back', async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const client = new LiveGatewaySessionClient(params());
    const first = client.connect();
    const socketA = FakeSocket.instances[0]!;
    socketA.fireOpen();
    socketA.receiveControl(connectedFrame, 1n);
    await first;

    const second = client.reconnect();
    const socketB = FakeSocket.instances[1]!;
    socketB.fireOpen();
    socketB.receiveControl({ type: 'error', code: 'RESUME_FAILED', message: 'session expired', fatal: true }, 2n);
    await expect(second).rejects.toThrow(/RESUME_FAILED/);
  });
});
