import { FlowController, type ControlMessage } from '@webssh/protocol';
export declare const MAX_PENDING_INPUT_BYTES: number;
/**
 * Exponential backoff with full jitter: random_between(baseMs, min(maxMs, baseMs * 2^attempt))
 */
export declare function computeBackoffMs(attempt: number, baseMs?: number, maxMs?: number, rand?: () => number): number;
/**
 * Generates a safe shell command to auto-attach or create a named tmux session on the remote host.
 */
export declare function buildTmuxAttachCommand(sessionName?: string): string;
export interface QueuedInputChunk {
    seq: bigint;
    channel: number;
    payload: Uint8Array;
}
/**
 * 64 KiB Pending Input Queue that buffers keystrokes during brief network drops and flushes them in order on reconnect.
 */
export declare class PendingInputQueue {
    private readonly maxBytes;
    private chunks;
    private currentBytes;
    constructor(maxBytes?: number);
    get byteLength(): number;
    get length(): number;
    enqueue(channel: number, seq: bigint, payload: Uint8Array): boolean;
    drain(): QueuedInputChunk[];
    clear(): void;
}
/**
 * Tracks inbound and outbound frame sequence numbers for lossless session resumption and duplicate suppression.
 */
export declare class SessionSequenceTracker {
    private lastInSeq;
    private nextOutSeq;
    get lastReceivedSeq(): bigint;
    allocateOutboundSeq(): bigint;
    /**
     * Returns true if the frame is new and should be processed; false if it was already processed prior to reconnect.
     */
    acceptInboundSeq(seq: bigint): boolean;
    buildResumeMessage(sessionId: string, token: string): Extract<ControlMessage, {
        type: 'resume';
    }>;
}
export type TransportConnectionState = 'connected' | 'reconnecting' | 'disconnected';
export declare class HeartbeatTracker {
    private pendingPings;
    private rttSamples;
    recordPingSent(seq: bigint, nowMs?: number): void;
    recordPongReceived(seq: bigint, nowMs?: number): number | null;
    get averageRttMs(): number;
}
export interface TransportCallbacks {
    onPtyData: (channel: number, data: Uint8Array) => void;
    onControlMessage?: (msg: ControlMessage) => void;
    onStateChange?: (state: TransportConnectionState, rttMs: number) => void;
    onSignRequest?: (msg: Extract<ControlMessage, {
        type: 'sign_request';
    }>) => Promise<string>;
    onHostKeyPrompt?: (msg: Extract<ControlMessage, {
        type: 'hostkey_prompt';
    }>) => Promise<boolean>;
}
/**
 * Orchestrates binary framing, flow control credits, reconnection replay, and remote-signer callbacks.
 */
export declare class GatewaySessionTransport {
    readonly inputQueue: PendingInputQueue;
    readonly seqTracker: SessionSequenceTracker;
    readonly flow: FlowController;
    readonly heartbeat: HeartbeatTracker;
    private state;
    private sendRawFn;
    private readonly callbacks;
    private renderedSinceCredit;
    constructor(callbacks: TransportCallbacks);
    get connectionState(): TransportConnectionState;
    attachSender(sendFn: (bytes: Uint8Array) => void, options?: {
        markConnected?: boolean;
        flush?: boolean;
    }): void;
    /**
     * The server acknowledged `connect`/`resume`. Only now is it safe to send the
     * keystrokes typed while the socket was down: before the ack the gateway has
     * no PTY channel to write them to.
     */
    confirmConnected(): void;
    detachSender(reconnecting?: boolean): void;
    private setState;
    sendPtyInput(channel: number, data: Uint8Array): boolean;
    sendControl(msg: ControlMessage): void;
    sendPing(nowMs?: number): bigint;
    private flushQueuedInput;
    handleInboundBytes(raw: Uint8Array): Promise<void>;
}
export declare class GatewayUnreachableError extends Error {
    readonly gatewayUrl: string;
    constructor(gatewayUrl: string, detail?: string);
}
export declare function isStaticPagesHost(hostnameOrUrl: string): boolean;
export interface GatewayUrlValidationResult {
    valid: boolean;
    normalizedUrl: string;
    error?: string;
}
export declare function validateGatewayWsUrl(rawUrl: string): GatewayUrlValidationResult;
export declare function deriveGatewayHealthUrl(wsUrl: string): string;
/** Select the protocol that matches the configured endpoint; preserve explicit user choices. */
export declare function resolveTransportBackendMode(endpoint?: string): TransportBackendMode;
export declare function resolveGatewayWsUrl(explicitUrl?: string): string;
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
    cols: number;
    rows: number;
    onPtyData: (channel: number, data: Uint8Array) => void;
    onHostKeyPrompt: (msg: Extract<ControlMessage, {
        type: 'hostkey_prompt';
    }>) => Promise<boolean>;
    onSignRequest?: (msg: Extract<ControlMessage, {
        type: 'sign_request';
    }>) => Promise<string>;
    onChannelClosed?: (channel: number, exitCode: number) => void;
    onStateChange?: (state: TransportConnectionState, rttMs: number) => void;
    onFatalError?: (code: string, message: string) => void;
}
export type ConnectedSessionMetadata = Extract<ControlMessage, {
    type: 'connected';
}>;
export declare class LiveGatewaySessionClient {
    private readonly params;
    readonly transport: GatewaySessionTransport;
    private ws;
    private pingTimer;
    private opCounter;
    private readonly textEncoder;
    private pendingExec;
    private pendingSftp;
    private pendingTunnel;
    private pendingChannelOpen;
    private connectResolve;
    private connectReject;
    private metadata;
    constructor(params: LiveConnectParams);
    get sessionMetadata(): ConnectedSessionMetadata | null;
    get isConnected(): boolean;
    private nextOpId;
    private handleControlMessage;
    private resolveEndpoint;
    connect(): Promise<ConnectedSessionMetadata>;
    /**
     * Re-open the socket and resume the server-side session that was detached
     * when the previous socket closed. The gateway replays every frame sent
     * after the last one we processed, so terminal output survives the drop.
     */
    reconnect(): Promise<ConnectedSessionMetadata>;
    canResume(): boolean;
    private openSocket;
    private rejectAllPending;
    sendPtyText(channel: number, text: string): boolean;
    sendPtyBytes(channel: number, bytes: Uint8Array): boolean;
    resizeChannel(channel: number, cols: number, rows: number): void;
    closeChannel(channel: number): void;
    openChannel(cols: number, rows: number, requestedChannel?: number): Promise<Extract<ControlMessage, {
        type: 'channel_opened';
    }>>;
    execCommand(command: string, timeoutMs?: number): Promise<Extract<ControlMessage, {
        type: 'exec_result';
    }>>;
    sftpOp(params: Omit<Extract<ControlMessage, {
        type: 'sftp_op';
    }>, 'type' | 'opId'>): Promise<Extract<ControlMessage, {
        type: 'sftp_result';
    }>>;
    tunnelOp(params: Omit<Extract<ControlMessage, {
        type: 'tunnel_op';
    }>, 'type' | 'opId'>): Promise<Extract<ControlMessage, {
        type: 'tunnel_result';
    }>>;
    close(): void;
}
//# sourceMappingURL=transport.d.ts.map