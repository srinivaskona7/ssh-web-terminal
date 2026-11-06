import { FrameType, decodeControlPayload, decodeFrame, encodeControlFrame } from '@webssh/protocol';

/**
 * WebSocket double for LiveGatewaySessionClient: records what the client sends and lets a test
 * push gateway control frames back. Install with `globalThis.WebSocket = FakeGatewaySocket`.
 */
export class FakeGatewaySocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSED = 3;
  static instances: FakeGatewaySocket[] = [];

  readyState = FakeGatewaySocket.CONNECTING;
  binaryType = 'arraybuffer';
  sent: ArrayBuffer[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private seq = 0n;

  constructor(public readonly url: string) {
    FakeGatewaySocket.instances.push(this);
  }

  send(data: ArrayBuffer | Uint8Array): void {
    this.sent.push(data instanceof Uint8Array ? (data.slice().buffer as ArrayBuffer) : data);
  }

  close(): void {
    this.readyState = FakeGatewaySocket.CLOSED;
    this.onclose?.();
  }

  fireOpen(): void {
    this.readyState = FakeGatewaySocket.OPEN;
    this.onopen?.();
  }

  receiveControl(msg: Parameters<typeof encodeControlFrame>[1]): void {
    this.seq += 1n;
    const frame = encodeControlFrame(this.seq, msg);
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

  lastControl(type: string): { type: string; [key: string]: unknown } | undefined {
    return this.controls().filter((msg) => msg.type === type).at(-1);
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
