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
    attachSender(sendFn: (bytes: Uint8Array) => void): void;
    detachSender(reconnecting?: boolean): void;
    private setState;
    sendPtyInput(channel: number, data: Uint8Array): boolean;
    sendControl(msg: ControlMessage): void;
    sendPing(nowMs?: number): bigint;
    private flushQueuedInput;
    handleInboundBytes(raw: Uint8Array): Promise<void>;
}
//# sourceMappingURL=transport.d.ts.map