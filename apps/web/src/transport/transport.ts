import {
  FlowController,
  FrameType,
  decodeControlPayload,
  decodeFrame,
  encodeControlFrame,
  encodeFrame,
  type BinaryFrame,
  type ControlMessage,
  type JumpHop
} from '@webssh/protocol';
import { ExecOutputSink, abortError } from './exec-output.js';
import { routeSignRequest, toWireJumpHop, type RemoteSignFn } from './remote-signer.js';
import { classifyEnvReport, prepareSessionEnv, type EnvOutcome } from './session-env.js';

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

  attachSender(
    sendFn: (bytes: Uint8Array) => void,
    options: { markConnected?: boolean; flush?: boolean } = {}
  ): void {
    const { markConnected = true, flush = true } = options;
    this.sendRawFn = sendFn;
    if (markConnected) {
      this.setState('connected');
    }
    if (flush) {
      this.flushQueuedInput();
    }
  }

  /**
   * The server acknowledged `connect`/`resume`. Only now is it safe to send the
   * keystrokes typed while the socket was down: before the ack the gateway has
   * no PTY channel to write them to.
   */
  confirmConnected(): void {
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

export class GatewayUnreachableError extends Error {
  public readonly gatewayUrl: string;
  constructor(gatewayUrl: string, detail?: string) {
    super(
      detail
        ? `SSH Gateway unreachable at ${gatewayUrl}: ${detail}`
        : `SSH Gateway unreachable at ${gatewayUrl}. Ensure the WebSSH Gateway service is running or update the Gateway WebSocket URL.`
    );
    this.name = 'GatewayUnreachableError';
    this.gatewayUrl = gatewayUrl;
  }
}

const STATIC_HOST_SUFFIXES = [
  '.github.io',
  '.pages.dev',
  '.netlify.app',
  '.vercel.app',
  '.surge.sh',
  '.gitlab.io'
] as const;

export function isStaticPagesHost(hostnameOrUrl: string): boolean {
  const raw = hostnameOrUrl.trim().toLowerCase();
  if (!raw) return false;
  let host = raw;
  if (raw.includes('://')) {
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      host = raw;
    }
  } else {
    host = raw.split('/')[0]?.split(':')[0] ?? raw;
  }
  return STATIC_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

export interface GatewayUrlValidationResult {
  valid: boolean;
  normalizedUrl: string;
  error?: string;
}

export function validateGatewayWsUrl(rawUrl: string): GatewayUrlValidationResult {
  let candidate = rawUrl.trim();
  if (!candidate) {
    return {
      valid: false,
      normalizedUrl: '',
      error:
        'SSH Gateway WebSocket URL is required (e.g. wss://ssh-gateway.yourdomain.com/ws or ws://127.0.0.1:8080/ws).'
    };
  }
  if (candidate.startsWith('http://')) {
    candidate = `ws://${candidate.slice('http://'.length)}`;
  } else if (candidate.startsWith('https://')) {
    candidate = `wss://${candidate.slice('https://'.length)}`;
  } else if (!candidate.includes('://')) {
    const isLocal = candidate.startsWith('127.0.0.1') || candidate.startsWith('localhost');
    candidate = `${isLocal ? 'ws' : 'wss'}://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      valid: false,
      normalizedUrl: candidate,
      error: `Invalid Gateway WebSocket URL "${rawUrl}". Expected ws://host:port/ws or wss://host/ws.`
    };
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return {
      valid: false,
      normalizedUrl: candidate,
      error: `Unsupported protocol "${parsed.protocol}". Use ws:// or wss://.`
    };
  }

  if (isStaticPagesHost(parsed.hostname)) {
    return {
      valid: false,
      normalizedUrl: candidate,
      error: `Invalid Gateway URL (${parsed.hostname}): GitHub Pages / static hosts cannot terminate SSH WebSocket connections. Configure your deployed EC2/Go Gateway WSS endpoint (e.g. wss://gateway.yourdomain.com/ws or ws://127.0.0.1:8080/ws).`
    };
  }

  if (!parsed.pathname || parsed.pathname === '/') {
    parsed.pathname = '/ws';
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString()
  };
}

export function deriveGatewayHealthUrl(wsUrl: string): string {
  const v = validateGatewayWsUrl(wsUrl);
  const target = v.valid ? v.normalizedUrl : wsUrl.trim();
  try {
    const u = new URL(target);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = u.pathname.replace(/\/ws\/?$/, '/healthz');
    if (!u.pathname.endsWith('/healthz')) {
      u.pathname = '/healthz';
    }
    u.search = '';
    return u.toString();
  } catch {
    return 'http://127.0.0.1:8080/healthz';
  }
}

/** Select the protocol that matches the configured endpoint; preserve explicit user choices. */
export function resolveTransportBackendMode(endpoint = resolveGatewayWsUrl()): TransportBackendMode {
  try {
    const saved = globalThis.localStorage?.getItem('webssh.transport.mode');
    if (saved === 'cloudflare-relay' || saved === 'go-gateway') return saved;
  } catch {
    // Storage can be unavailable in private browsing.
  }
  const configured = (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_TRANSPORT_MODE;
  if (configured === 'cloudflare-relay' || configured === 'go-gateway') return configured;
  try {
    if (new URL(endpoint).hostname.endsWith('.workers.dev')) return 'cloudflare-relay';
  } catch {
    // URL validation reports invalid endpoints when connecting.
  }
  return 'go-gateway';
}

export function resolveGatewayWsUrl(explicitUrl?: string): string {
  const trimmed = explicitUrl?.trim();
  if (trimmed) {
    const check = validateGatewayWsUrl(trimmed);
    if (check.valid) {
      return check.normalizedUrl;
    }
    // Return raw trimmed so validateGatewayWsUrl in connect() surfaces the specific static-host error
    return trimmed;
  }

  // 1. Check ?gateway= URL query parameter
  if (typeof window !== 'undefined' && window.location?.search) {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = params.get('gateway')?.trim();
      if (fromQuery) {
        const check = validateGatewayWsUrl(fromQuery);
        if (check.valid) {
          try {
            globalThis.localStorage?.setItem('webssh.gateway.wsUrl', check.normalizedUrl);
          } catch {
            // ignore storage errors
          }
          return check.normalizedUrl;
        }
      }
    } catch {
      // ignore URLSearchParams errors
    }
  }

  // 2. Check localStorage, automatically purging stale GitHub Pages (*.github.io) URLs
  try {
    const saved = globalThis.localStorage?.getItem('webssh.gateway.wsUrl')?.trim();
    if (saved) {
      if (isStaticPagesHost(saved)) {
        globalThis.localStorage?.removeItem('webssh.gateway.wsUrl');
      } else {
        const check = validateGatewayWsUrl(saved);
        if (check.valid) {
          return check.normalizedUrl;
        }
      }
    }
  } catch {
    // ignore storage access issues
  }

  // 3. Check build-time VITE_GATEWAY_URL or runtime window.__WEBSSH_DEFAULT_GATEWAY_URL__
  const envUrl =
    (typeof window !== 'undefined' &&
      (window as unknown as { __WEBSSH_DEFAULT_GATEWAY_URL__?: string }).__WEBSSH_DEFAULT_GATEWAY_URL__) ||
    ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_GATEWAY_URL ?? '');
  if (envUrl && envUrl.trim() && !isStaticPagesHost(envUrl)) {
    const check = validateGatewayWsUrl(envUrl);
    if (check.valid) {
      return check.normalizedUrl;
    }
  }

  // 4. Derive from current hostname ONLY when not hosted on GitHub Pages / static CDN
  const hostname =
    typeof window !== 'undefined' && window.location?.hostname
      ? window.location.hostname
      : '127.0.0.1';
  if (isStaticPagesHost(hostname)) {
    return 'ws://127.0.0.1:8080/ws';
  }
  const proto =
    typeof window !== 'undefined' && window.location?.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${hostname}:8080/ws`;
}

export type TransportBackendMode = 'go-gateway' | 'cloudflare-relay';

export interface LiveConnectParams {
  transportMode?: TransportBackendMode;
  gatewayUrl?: string;
  gatewayAuthToken?: string;
  host: string;
  port: number;
  user: string;
  authMethod: 'password' | 'private_key' | 'remote_signer';
  password?: string;
  privateKeyPem?: string;
  privateKeyPassphrase?: string;
  publicKey?: string;
  keyFingerprint?: string;
  /** ProxyJump hops, dialled in order before the target host. Go gateway only. */
  jumpHops?: JumpHop[];
  /** Variables requested with SSH `env` requests; the server reports which it accepted. */
  env?: Record<string, string>;
  /** Browser keys by fingerprint; each sign_request is signed only by the key it names. */
  signers?: Record<string, RemoteSignFn>;
  cols: number;
  rows: number;
  onPtyData: (channel: number, data: Uint8Array) => void;
  onHostKeyPrompt: (msg: Extract<ControlMessage, { type: 'hostkey_prompt' }>) => Promise<boolean>;
  onSignRequest?: (msg: Extract<ControlMessage, { type: 'sign_request' }>) => Promise<string>;
  onChannelClosed?: (channel: number, exitCode: number) => void;
  onStateChange?: (state: TransportConnectionState, rttMs: number) => void;
  onFatalError?: (code: string, message: string) => void;
}

export type ConnectedSessionMetadata = Extract<ControlMessage, { type: 'connected' }>;

export interface ExecStreamOptions {
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  signal?: AbortSignal;
  /** Absent means the command runs until it exits or is cancelled. */
  timeoutMs?: number;
  /** Keep output for the resolved result (default true); callbacks see it either way. */
  retainOutput?: boolean;
}

export interface ExecStreamResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

interface PendingStream {
  stdout: ExecOutputSink;
  stderr: ExecOutputSink;
  resolve: (result: ExecStreamResult) => void;
  reject: (err: Error) => void;
  detachAbort: () => void;
}

export class LiveGatewaySessionClient {
  public readonly transport: GatewaySessionTransport;
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private opCounter = 0;
  private readonly textEncoder = new TextEncoder();

  private pendingExec = new Map<
    string,
    {
      resolve: (res: Extract<ControlMessage, { type: 'exec_result' }>) => void;
      reject: (err: Error) => void;
    }
  >();
  private pendingSftp = new Map<
    string,
    {
      resolve: (res: Extract<ControlMessage, { type: 'sftp_result' }>) => void;
      reject: (err: Error) => void;
    }
  >();
  private pendingTunnel = new Map<
    string,
    {
      resolve: (res: Extract<ControlMessage, { type: 'tunnel_result' }>) => void;
      reject: (err: Error) => void;
    }
  >();
  private pendingChannelOpen = new Map<
    string,
    {
      resolve: (res: Extract<ControlMessage, { type: 'channel_opened' }>) => void;
      reject: (err: Error) => void;
    }
  >();
  private pendingStreams = new Map<string, PendingStream>();
  private signRefusal: string | null = null;

  private connectResolve: ((meta: ConnectedSessionMetadata) => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private metadata: ConnectedSessionMetadata | null = null;

  constructor(private readonly params: LiveConnectParams) {
    this.transport = new GatewaySessionTransport({
      onPtyData: params.onPtyData,
      onHostKeyPrompt: params.onHostKeyPrompt,
      onSignRequest: (msg) => this.answerSignRequest(msg),
      onStateChange: params.onStateChange,
      onControlMessage: (msg) => this.handleControlMessage(msg)
    });
  }

  get sessionMetadata(): ConnectedSessionMetadata | null {
    return this.metadata;
  }

  get isConnected(): boolean {
    return this.transport.connectionState === 'connected' && this.metadata !== null;
  }

  /** Accepted/rejected/not-reported split of the requested env for the current session. */
  get envOutcome(): EnvOutcome {
    return classifyEnvReport(this.params.env, this.metadata);
  }

  private async answerSignRequest(msg: Extract<ControlMessage, { type: 'sign_request' }>): Promise<string> {
    const verdict = await routeSignRequest(this.params, msg);
    if (verdict.ok) return verdict.signatureBase64;
    // An empty signature tells the gateway to fail this key; the reason explains the connect error.
    this.signRefusal = verdict.reason;
    return '';
  }

  private nextOpId(prefix: string): string {
    this.opCounter += 1;
    return `${prefix}_${Date.now()}_${this.opCounter}`;
  }

  private handleControlMessage(msg: ControlMessage): void {
    switch (msg.type) {
      case 'connected': {
        const previous = this.metadata;
        // A resumed session keeps the env verdict of its first connect unless the gateway resends it.
        this.metadata =
          previous && previous.sessionId === msg.sessionId && !msg.envAccepted && !msg.envRejected
            ? { ...msg, envAccepted: previous.envAccepted, envRejected: previous.envRejected }
            : msg;
        if (this.metadata.envAccepted === undefined) delete this.metadata.envAccepted;
        if (this.metadata.envRejected === undefined) delete this.metadata.envRejected;
        this.transport.confirmConnected();
        if (this.connectResolve) {
          const resolve = this.connectResolve;
          this.connectResolve = null;
          this.connectReject = null;
          resolve(this.metadata);
        }
        break;
      }
      case 'error':
        if (this.connectReject) {
          const reject = this.connectReject;
          this.connectResolve = null;
          this.connectReject = null;
          const refusal = this.signRefusal ? ` (browser refused to sign: ${this.signRefusal})` : '';
          reject(new Error(`${msg.code}: ${msg.message}${refusal}`));
        } else if (msg.fatal) {
          this.params.onFatalError?.(msg.code, msg.message);
        }
        break;
      case 'exec_result': {
        const waiter = this.pendingExec.get(msg.opId);
        if (waiter) {
          this.pendingExec.delete(msg.opId);
          waiter.resolve(msg);
        }
        break;
      }
      case 'sftp_result': {
        const waiter = this.pendingSftp.get(msg.opId);
        if (waiter) {
          this.pendingSftp.delete(msg.opId);
          waiter.resolve(msg);
        }
        break;
      }
      case 'tunnel_result': {
        const waiter = this.pendingTunnel.get(msg.opId);
        if (waiter) {
          this.pendingTunnel.delete(msg.opId);
          waiter.resolve(msg);
        }
        break;
      }
      case 'channel_opened': {
        const waiter = this.pendingChannelOpen.get(msg.opId);
        if (waiter) {
          this.pendingChannelOpen.delete(msg.opId);
          waiter.resolve(msg);
        }
        break;
      }
      case 'exec_output': {
        const stream = this.pendingStreams.get(msg.opId);
        if (!stream) break;
        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(atob(msg.dataBase64), (ch) => ch.charCodeAt(0));
        } catch {
          this.finishStream(msg.opId, null, new Error('Gateway sent unreadable command output.'));
          this.transport.sendControl({ type: 'exec_cancel', opId: msg.opId });
          break;
        }
        (msg.stream === 'stderr' ? stream.stderr : stream.stdout).push(bytes);
        break;
      }
      case 'exec_stream_end':
        if (typeof msg.exitCode === 'number' || msg.ok) {
          this.finishStream(msg.opId, { exitCode: msg.exitCode ?? 0, durationMs: msg.durationMs });
        } else {
          this.finishStream(msg.opId, null, new Error(msg.error || 'Remote command stream failed.'));
        }
        break;
      case 'channel_closed':
        this.params.onChannelClosed?.(msg.channel, msg.exitCode ?? 0);
        break;
    }
  }

  private resolveEndpoint(): { wsUrl: string; authToken: string } {
    const rawWsUrl = resolveGatewayWsUrl(this.params.gatewayUrl);
    const validation = validateGatewayWsUrl(rawWsUrl);
    if (!validation.valid) {
      throw new GatewayUnreachableError(rawWsUrl, validation.error);
    }

    const wsUrl = validation.normalizedUrl;
    const authToken = this.params.gatewayAuthToken?.trim() ?? '';
    // Token is sent via Sec-WebSocket-Protocol header in openSocket(), never
    // in the URL, so it cannot leak into proxy/edge logs. The gateway also
    // accepts a control-frame `hello.oidcToken` as defense-in-depth.
    return { wsUrl, authToken };
  }

  async connect(): Promise<ConnectedSessionMetadata> {
    const env = prepareSessionEnv(this.params.env);
    const { wsUrl, authToken } = this.resolveEndpoint();
    this.signRefusal = null;
    return this.openSocket(wsUrl, () => {
      this.transport.sendControl({
        type: 'hello',
        protocolVersion: 1,
        clientVersion: '1.0.0',
        oidcToken: authToken || undefined
      });
      this.transport.sendControl({
        type: 'connect',
        host: this.params.host,
        port: this.params.port,
        user: this.params.user,
        authMethod: this.params.authMethod,
        password: this.params.password,
        privateKeyPem: this.params.privateKeyPem,
        privateKeyPassphrase: this.params.privateKeyPassphrase,
        publicKey: this.params.publicKey,
        keyFingerprint: this.params.keyFingerprint ?? '',
        jump: this.params.jumpHops?.length ? this.params.jumpHops.map(toWireJumpHop) : undefined,
        ...(env ? { env } : {}),
        cols: this.params.cols,
        rows: this.params.rows
      });
    }, authToken);
  }

  /**
   * Re-open the socket and resume the server-side session that was detached
   * when the previous socket closed. The gateway replays every frame sent
   * after the last one we processed, so terminal output survives the drop.
   */
  async reconnect(): Promise<ConnectedSessionMetadata> {
    const meta = this.metadata;
    if (!meta) {
      throw new Error('No detached session to resume.');
    }
    const { wsUrl, authToken } = this.resolveEndpoint();
    this.rejectAllPending(new Error('SSH session reconnecting.'));
    this.transport.detachSender(true);
    const stale = this.ws;
    this.ws = null;
    try {
      stale?.close();
    } catch {
      // The socket is already gone.
    }
    return this.openSocket(wsUrl, () => {
      this.transport.sendControl({
        type: 'hello',
        protocolVersion: 1,
        clientVersion: '1.0.0',
        oidcToken: authToken || undefined
      });
      this.transport.sendControl(
        this.transport.seqTracker.buildResumeMessage(meta.sessionId, meta.resumeToken)
      );
    }, authToken);
  }

  canResume(): boolean {
    return this.metadata !== null;
  }

  private openSocket(
    wsUrl: string,
    onOpen: () => void,
    authToken?: string
  ): Promise<ConnectedSessionMetadata> {
    return new Promise<ConnectedSessionMetadata>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      let wsOpened = false;
      let socket: WebSocket;
      try {
        const protocols = ['webssh-gateway.v1'];
        if (authToken?.trim()) protocols.push(`token.${authToken.trim()}`);
        socket = new WebSocket(wsUrl, protocols.length > 1 ? protocols : undefined);
      } catch (err) {
        this.connectResolve = null;
        this.connectReject = null;
        reject(new GatewayUnreachableError(wsUrl, err instanceof Error ? err.message : String(err)));
        return;
      }

      socket.binaryType = 'arraybuffer';
      this.ws = socket;

      const openTimeout = setTimeout(() => {
        if (!wsOpened) {
          try {
            socket.close();
          } catch {
            // ignore
          }
          if (this.connectReject) {
            const rej = this.connectReject;
            this.connectResolve = null;
            this.connectReject = null;
            rej(new GatewayUnreachableError(wsUrl, 'Connection timed out'));
          }
        }
      }, 6000);

      socket.onopen = () => {
        wsOpened = true;
        clearTimeout(openTimeout);
        this.transport.attachSender(
          (bytes) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(bytes);
            }
          },
          { markConnected: false, flush: false }
        );
        onOpen();
        this.transport.sendPing();
        this.pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            this.transport.sendPing();
          }
        }, 5000);
      };

      socket.onmessage = (ev: MessageEvent) => {
        if (ev.data instanceof ArrayBuffer) {
          void this.transport.handleInboundBytes(new Uint8Array(ev.data));
        } else if (ev.data instanceof Blob) {
          void ev.data.arrayBuffer().then((buf) => this.transport.handleInboundBytes(new Uint8Array(buf)));
        }
      };

      socket.onerror = () => {
        if (this.ws !== socket) return;
        clearTimeout(openTimeout);
        if (!wsOpened && this.connectReject) {
          const rej = this.connectReject;
          this.connectResolve = null;
          this.connectReject = null;
          rej(new GatewayUnreachableError(wsUrl));
        }
      };

      socket.onclose = () => {
        // A reconnect replaces this.ws before the old socket's close event
        // arrives; ignore it so it cannot tear down the new session state.
        if (this.ws !== socket) return;
        clearTimeout(openTimeout);
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        this.transport.detachSender(false);
        if (this.connectReject) {
          const rej = this.connectReject;
          this.connectResolve = null;
          this.connectReject = null;
          rej(
            wsOpened
              ? new Error('Gateway connection closed before SSH session completed.')
              : new GatewayUnreachableError(wsUrl)
          );
        }
        this.rejectAllPending(new Error('SSH session disconnected.'));
      };
    });
  }

  private rejectAllPending(err: Error): void {
    for (const [, w] of this.pendingExec) w.reject(err);
    this.pendingExec.clear();
    for (const [, w] of this.pendingSftp) w.reject(err);
    this.pendingSftp.clear();
    for (const [, w] of this.pendingTunnel) w.reject(err);
    this.pendingTunnel.clear();
    for (const [, w] of this.pendingChannelOpen) w.reject(err);
    this.pendingChannelOpen.clear();
    for (const opId of [...this.pendingStreams.keys()]) this.finishStream(opId, null, err);
  }

  private finishStream(
    opId: string,
    end: { exitCode: number; durationMs: number } | null,
    err?: Error
  ): void {
    const stream = this.pendingStreams.get(opId);
    if (!stream) return;
    this.pendingStreams.delete(opId);
    stream.detachAbort();
    const stdout = stream.stdout.finish();
    const stderr = stream.stderr.finish();
    if (end) stream.resolve({ stdout, stderr, ...end });
    else stream.reject(err ?? new Error('Remote command stream failed.'));
  }

  /**
   * Run a command whose output arrives as it is produced. A nonzero exit resolves; a stream the
   * gateway could not run rejects; aborting cancels it on the gateway and rejects with AbortError.
   */
  execStream(command: string, options: ExecStreamOptions = {}): Promise<ExecStreamResult> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(abortError());
    if (!this.isConnected) return Promise.reject(new Error('SSH session is not connected.'));
    const opId = this.nextOpId('stream');
    const retain = options.retainOutput ?? true;
    return new Promise<ExecStreamResult>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pendingStreams.has(opId)) return;
        this.transport.sendControl({ type: 'exec_cancel', opId });
        this.finishStream(opId, null, abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pendingStreams.set(opId, {
        stdout: new ExecOutputSink(options.onStdout, retain),
        stderr: new ExecOutputSink(options.onStderr, retain),
        resolve,
        reject,
        detachAbort: () => signal?.removeEventListener('abort', onAbort)
      });
      this.transport.sendControl({
        type: 'exec_stream',
        opId,
        command,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
      });
    });
  }

  sendPtyText(channel: number, text: string): boolean {
    return this.transport.sendPtyInput(channel, this.textEncoder.encode(text));
  }

  sendPtyBytes(channel: number, bytes: Uint8Array): boolean {
    return this.transport.sendPtyInput(channel, bytes);
  }

  resizeChannel(channel: number, cols: number, rows: number): void {
    this.transport.sendControl({
      type: 'resize',
      channel,
      cols,
      rows
    });
  }

  closeChannel(channel: number): void {
    this.transport.sendControl({
      type: 'close_channel',
      channel
    });
  }

  openChannel(
    cols: number,
    rows: number,
    requestedChannel?: number
  ): Promise<Extract<ControlMessage, { type: 'channel_opened' }>> {
    const opId = this.nextOpId('chan');
    return new Promise((resolve, reject) => {
      this.pendingChannelOpen.set(opId, { resolve, reject });
      this.transport.sendControl({
        type: 'open_channel',
        opId,
        channel: requestedChannel,
        cols,
        rows
      });
    });
  }

  execCommand(
    command: string,
    timeoutMs = 15000
  ): Promise<Extract<ControlMessage, { type: 'exec_result' }>> {
    const opId = this.nextOpId('exec');
    return new Promise((resolve, reject) => {
      this.pendingExec.set(opId, { resolve, reject });
      this.transport.sendControl({
        type: 'exec_command',
        opId,
        command,
        timeoutMs
      });
    });
  }

  sftpOp(
    params: Omit<Extract<ControlMessage, { type: 'sftp_op' }>, 'type' | 'opId'>
  ): Promise<Extract<ControlMessage, { type: 'sftp_result' }>> {
    const opId = this.nextOpId('sftp');
    return new Promise((resolve, reject) => {
      this.pendingSftp.set(opId, { resolve, reject });
      this.transport.sendControl({
        type: 'sftp_op',
        opId,
        ...params
      });
    });
  }

  tunnelOp(
    params: Omit<Extract<ControlMessage, { type: 'tunnel_op' }>, 'type' | 'opId'>
  ): Promise<Extract<ControlMessage, { type: 'tunnel_result' }>> {
    const opId = this.nextOpId('tun');
    return new Promise((resolve, reject) => {
      this.pendingTunnel.set(opId, { resolve, reject });
      this.transport.sendControl({
        type: 'tunnel_op',
        opId,
        ...params
      });
    });
  }

  close(): void {
    for (const opId of this.pendingStreams.keys()) {
      this.transport.sendControl({ type: 'exec_cancel', opId });
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.transport.detachSender(false);
    const socket = this.ws;
    // Detach first so the socket's own close event does not report a disconnect.
    this.ws = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    this.metadata = null;
    this.rejectAllPending(new Error('Session closed by user.'));
  }
}

