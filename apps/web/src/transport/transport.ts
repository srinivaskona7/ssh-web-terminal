import {
  FlowController,
  FrameType,
  decodeControlPayload,
  decodeFrame,
  encodeControlFrame,
  encodeFrame,
  type BinaryFrame,
  type ControlMessage
} from '@webssh/protocol';

export const MAX_PENDING_INPUT_BYTES = 64 * 1024; // 64 KiB

/**
 * Exponential backoff with full jitter: random_between(baseMs, min(maxMs, baseMs * 2^attempt))
 */
export function computeBackoffMs(
  attempt: number,
  baseMs = 250,
  maxMs = 15_000,
  rand: () => number = Math.random
): number {
  const safeAttempt = Math.max(0, Math.min(20, Math.floor(attempt)));
  const ceiling = Math.min(maxMs, baseMs * Math.pow(2, safeAttempt));
  const clampedRand = Math.max(0, Math.min(1, rand()));
  return Math.floor(baseMs + clampedRand * Math.max(0, ceiling - baseMs));
}

/**
 * Generates a safe shell command to auto-attach or create a named tmux session on the remote host.
 */
export function buildTmuxAttachCommand(sessionName = 'webssh'): string {
  const sanitized = sessionName.replace(/[^a-zA-Z0-9_-]/g, '') || 'webssh';
  return `tmux new-session -A -s ${sanitized}`;
}

export interface QueuedInputChunk {
  seq: bigint;
  channel: number;
  payload: Uint8Array;
}

/**
 * 64 KiB Pending Input Queue that buffers keystrokes during brief network drops and flushes them in order on reconnect.
 */
export class PendingInputQueue {
  private readonly maxBytes: number;
  private chunks: QueuedInputChunk[] = [];
  private currentBytes = 0;

  constructor(maxBytes = MAX_PENDING_INPUT_BYTES) {
    this.maxBytes = maxBytes;
  }

  get byteLength(): number {
    return this.currentBytes;
  }

  get length(): number {
    return this.chunks.length;
  }

  enqueue(channel: number, seq: bigint, payload: Uint8Array): boolean {
    if (payload.byteLength === 0) {
      return true;
    }
    if (this.currentBytes + payload.byteLength > this.maxBytes) {
      return false;
    }
    const copy = new Uint8Array(payload.byteLength);
    copy.set(payload);
    this.chunks.push({ channel, seq, payload: copy });
    this.currentBytes += copy.byteLength;
    return true;
  }

  drain(): QueuedInputChunk[] {
    const out = this.chunks;
    this.chunks = [];
    this.currentBytes = 0;
    return out;
  }

  clear(): void {
    for (const chunk of this.chunks) {
      chunk.payload.fill(0);
    }
    this.chunks = [];
    this.currentBytes = 0;
  }
}

/**
 * Tracks inbound and outbound frame sequence numbers for lossless session resumption and duplicate suppression.
 */
export class SessionSequenceTracker {
  private lastInSeq = 0n;
  private nextOutSeq = 1n;

  get lastReceivedSeq(): bigint {
    return this.lastInSeq;
  }

  allocateOutboundSeq(): bigint {
    const seq = this.nextOutSeq;
    this.nextOutSeq += 1n;
    return seq;
  }

  /**
   * Returns true if the frame is new and should be processed; false if it was already processed prior to reconnect.
   */
  acceptInboundSeq(seq: bigint): boolean {
    if (seq <= this.lastInSeq) {
      return false;
    }
    this.lastInSeq = seq;
    return true;
  }

  buildResumeMessage(sessionId: string, token: string): Extract<ControlMessage, { type: 'resume' }> {
    return {
      type: 'resume',
      sessionId,
      token,
      lastSeq: this.lastInSeq.toString()
    };
  }
}

export type TransportConnectionState = 'connected' | 'reconnecting' | 'disconnected';

export class HeartbeatTracker {
  private pendingPings = new Map<bigint, number>();
  private rttSamples: number[] = [];

  recordPingSent(seq: bigint, nowMs = Date.now()): void {
    this.pendingPings.set(seq, nowMs);
  }

  recordPongReceived(seq: bigint, nowMs = Date.now()): number | null {
    const sentAt = this.pendingPings.get(seq);
    if (sentAt === undefined) {
      return null;
    }
    this.pendingPings.delete(seq);
    const rtt = Math.max(0, nowMs - sentAt);
    this.rttSamples.push(rtt);
    if (this.rttSamples.length > 10) {
      this.rttSamples.shift();
    }
    return rtt;
  }

  get averageRttMs(): number {
    if (this.rttSamples.length === 0) return 0;
    const sum = this.rttSamples.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.rttSamples.length);
  }
}

export interface TransportCallbacks {
  onPtyData: (channel: number, data: Uint8Array) => void;
  onControlMessage?: (msg: ControlMessage) => void;
  onStateChange?: (state: TransportConnectionState, rttMs: number) => void;
  onSignRequest?: (msg: Extract<ControlMessage, { type: 'sign_request' }>) => Promise<string>;
  onHostKeyPrompt?: (msg: Extract<ControlMessage, { type: 'hostkey_prompt' }>) => Promise<boolean>;
}

/**
 * Orchestrates binary framing, flow control credits, reconnection replay, and remote-signer callbacks.
 */
export class GatewaySessionTransport {
  public readonly inputQueue = new PendingInputQueue();
  public readonly seqTracker = new SessionSequenceTracker();
  public readonly flow = new FlowController();
  public readonly heartbeat = new HeartbeatTracker();

  private state: TransportConnectionState = 'disconnected';
  private sendRawFn: ((bytes: Uint8Array) => void) | null = null;
  private readonly callbacks: TransportCallbacks;
  private renderedSinceCredit = new Map<number, number>();

  constructor(callbacks: TransportCallbacks) {
    this.callbacks = callbacks;
  }

  get connectionState(): TransportConnectionState {
    return this.state;
  }

  attachSender(sendFn: (bytes: Uint8Array) => void): void {
    this.sendRawFn = sendFn;
    this.setState('connected');
    this.flushQueuedInput();
  }

  detachSender(reconnecting = true): void {
    this.sendRawFn = null;
    this.setState(reconnecting ? 'reconnecting' : 'disconnected');
  }

  private setState(next: TransportConnectionState): void {
    this.state = next;
    this.callbacks.onStateChange?.(next, this.heartbeat.averageRttMs);
  }

  sendPtyInput(channel: number, data: Uint8Array): boolean {
    const seq = this.seqTracker.allocateOutboundSeq();
    if (!this.sendRawFn || this.state !== 'connected') {
      return this.inputQueue.enqueue(channel, seq, data);
    }
    const frame = encodeFrame({
      type: FrameType.PtyData,
      channel,
      seq,
      payload: data
    });
    this.sendRawFn(frame);
    return true;
  }

  sendControl(msg: ControlMessage): void {
    if (!this.sendRawFn) return;
    const seq = this.seqTracker.allocateOutboundSeq();
    this.sendRawFn(encodeControlFrame(seq, msg));
  }

  sendPing(nowMs = Date.now()): bigint {
    const seq = this.seqTracker.allocateOutboundSeq();
    this.heartbeat.recordPingSent(seq, nowMs);
    if (this.sendRawFn) {
      this.sendRawFn(
        encodeFrame({
          type: FrameType.Ping,
          channel: 0,
          seq,
          payload: new Uint8Array(0)
        })
      );
    }
    return seq;
  }

  private flushQueuedInput(): void {
    if (!this.sendRawFn) return;
    const items = this.inputQueue.drain();
    for (const item of items) {
      this.sendRawFn(
        encodeFrame({
          type: FrameType.PtyData,
          channel: item.channel,
          seq: item.seq,
          payload: item.payload
        })
      );
    }
  }

  async handleInboundBytes(raw: Uint8Array): Promise<void> {
    const frame: BinaryFrame = decodeFrame(raw);

    if (frame.type === FrameType.Pong) {
      this.heartbeat.recordPongReceived(frame.seq);
      this.callbacks.onStateChange?.(this.state, this.heartbeat.averageRttMs);
      return;
    }

    if (frame.type === FrameType.Ping) {
      if (this.sendRawFn) {
        this.sendRawFn(
          encodeFrame({
            type: FrameType.Pong,
            channel: frame.channel,
            seq: frame.seq,
            payload: frame.payload
          })
        );
      }
      return;
    }

    if (frame.type === FrameType.PtyData) {
      if (!this.seqTracker.acceptInboundSeq(frame.seq)) {
        return; // Deduplicate replayed frame
      }
      this.callbacks.onPtyData(frame.channel, frame.payload);
      const accumulated = (this.renderedSinceCredit.get(frame.channel) ?? 0) + frame.payload.byteLength;
      if (accumulated >= 64 * 1024) {
        this.renderedSinceCredit.set(frame.channel, 0);
        this.sendControl({
          type: 'credit',
          channel: frame.channel,
          bytes: accumulated
        });
      } else {
        this.renderedSinceCredit.set(frame.channel, accumulated);
      }
      return;
    }

    if (frame.type === FrameType.Control) {
      const msg = decodeControlPayload(frame.payload);
      this.callbacks.onControlMessage?.(msg);

      if (msg.type === 'credit') {
        this.flow.addCredit(msg.channel, msg.bytes);
      } else if (msg.type === 'sign_request' && this.callbacks.onSignRequest) {
        const signatureBase64 = await this.callbacks.onSignRequest(msg);
        this.sendControl({
          type: 'sign_response',
          requestId: msg.requestId,
          signatureBase64
        });
      } else if (msg.type === 'hostkey_prompt' && this.callbacks.onHostKeyPrompt) {
        const trusted = await this.callbacks.onHostKeyPrompt(msg);
        this.sendControl({
          type: 'hostkey_decision',
          trusted
        });
      }
    }
  }
}
