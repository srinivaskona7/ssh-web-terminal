import { FlowController, FrameType, decodeControlPayload, decodeFrame, encodeControlFrame, encodeFrame } from '@webssh/protocol';
export const MAX_PENDING_INPUT_BYTES = 64 * 1024; // 64 KiB
/**
 * Exponential backoff with full jitter: random_between(baseMs, min(maxMs, baseMs * 2^attempt))
 */
export function computeBackoffMs(attempt, baseMs = 250, maxMs = 15_000, rand = Math.random) {
    const safeAttempt = Math.max(0, Math.min(20, Math.floor(attempt)));
    const ceiling = Math.min(maxMs, baseMs * Math.pow(2, safeAttempt));
    const clampedRand = Math.max(0, Math.min(1, rand()));
    return Math.floor(baseMs + clampedRand * Math.max(0, ceiling - baseMs));
}
/**
 * Generates a safe shell command to auto-attach or create a named tmux session on the remote host.
 */
export function buildTmuxAttachCommand(sessionName = 'webssh') {
    const sanitized = sessionName.replace(/[^a-zA-Z0-9_-]/g, '') || 'webssh';
    return `tmux new-session -A -s ${sanitized}`;
}
/**
 * 64 KiB Pending Input Queue that buffers keystrokes during brief network drops and flushes them in order on reconnect.
 */
export class PendingInputQueue {
    maxBytes;
    chunks = [];
    currentBytes = 0;
    constructor(maxBytes = MAX_PENDING_INPUT_BYTES) {
        this.maxBytes = maxBytes;
    }
    get byteLength() {
        return this.currentBytes;
    }
    get length() {
        return this.chunks.length;
    }
    enqueue(channel, seq, payload) {
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
    drain() {
        const out = this.chunks;
        this.chunks = [];
        this.currentBytes = 0;
        return out;
    }
    clear() {
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
    lastInSeq = 0n;
    nextOutSeq = 1n;
    get lastReceivedSeq() {
        return this.lastInSeq;
    }
    allocateOutboundSeq() {
        const seq = this.nextOutSeq;
        this.nextOutSeq += 1n;
        return seq;
    }
    /**
     * Returns true if the frame is new and should be processed; false if it was already processed prior to reconnect.
     */
    acceptInboundSeq(seq) {
        if (seq <= this.lastInSeq) {
            return false;
        }
        this.lastInSeq = seq;
        return true;
    }
    buildResumeMessage(sessionId, token) {
        return {
            type: 'resume',
            sessionId,
            token,
            lastSeq: this.lastInSeq.toString()
        };
    }
}
export class HeartbeatTracker {
    pendingPings = new Map();
    rttSamples = [];
    recordPingSent(seq, nowMs = Date.now()) {
        this.pendingPings.set(seq, nowMs);
    }
    recordPongReceived(seq, nowMs = Date.now()) {
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
    get averageRttMs() {
        if (this.rttSamples.length === 0)
            return 0;
        const sum = this.rttSamples.reduce((a, b) => a + b, 0);
        return Math.round(sum / this.rttSamples.length);
    }
}
/**
 * Orchestrates binary framing, flow control credits, reconnection replay, and remote-signer callbacks.
 */
export class GatewaySessionTransport {
    inputQueue = new PendingInputQueue();
    seqTracker = new SessionSequenceTracker();
    flow = new FlowController();
    heartbeat = new HeartbeatTracker();
    state = 'disconnected';
    sendRawFn = null;
    callbacks;
    renderedSinceCredit = new Map();
    constructor(callbacks) {
        this.callbacks = callbacks;
    }
    get connectionState() {
        return this.state;
    }
    attachSender(sendFn) {
        this.sendRawFn = sendFn;
        this.setState('connected');
        this.flushQueuedInput();
    }
    detachSender(reconnecting = true) {
        this.sendRawFn = null;
        this.setState(reconnecting ? 'reconnecting' : 'disconnected');
    }
    setState(next) {
        this.state = next;
        this.callbacks.onStateChange?.(next, this.heartbeat.averageRttMs);
    }
    sendPtyInput(channel, data) {
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
    sendControl(msg) {
        if (!this.sendRawFn)
            return;
        const seq = this.seqTracker.allocateOutboundSeq();
        this.sendRawFn(encodeControlFrame(seq, msg));
    }
    sendPing(nowMs = Date.now()) {
        const seq = this.seqTracker.allocateOutboundSeq();
        this.heartbeat.recordPingSent(seq, nowMs);
        if (this.sendRawFn) {
            this.sendRawFn(encodeFrame({
                type: FrameType.Ping,
                channel: 0,
                seq,
                payload: new Uint8Array(0)
            }));
        }
        return seq;
    }
    flushQueuedInput() {
        if (!this.sendRawFn)
            return;
        const items = this.inputQueue.drain();
        for (const item of items) {
            this.sendRawFn(encodeFrame({
                type: FrameType.PtyData,
                channel: item.channel,
                seq: item.seq,
                payload: item.payload
            }));
        }
    }
    async handleInboundBytes(raw) {
        const frame = decodeFrame(raw);
        if (frame.type === FrameType.Pong) {
            this.heartbeat.recordPongReceived(frame.seq);
            this.callbacks.onStateChange?.(this.state, this.heartbeat.averageRttMs);
            return;
        }
        if (frame.type === FrameType.Ping) {
            if (this.sendRawFn) {
                this.sendRawFn(encodeFrame({
                    type: FrameType.Pong,
                    channel: frame.channel,
                    seq: frame.seq,
                    payload: frame.payload
                }));
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
            }
            else {
                this.renderedSinceCredit.set(frame.channel, accumulated);
            }
            return;
        }
        if (frame.type === FrameType.Control) {
            const msg = decodeControlPayload(frame.payload);
            this.callbacks.onControlMessage?.(msg);
            if (msg.type === 'credit') {
                this.flow.addCredit(msg.channel, msg.bytes);
            }
            else if (msg.type === 'sign_request' && this.callbacks.onSignRequest) {
                const signatureBase64 = await this.callbacks.onSignRequest(msg);
                this.sendControl({
                    type: 'sign_response',
                    requestId: msg.requestId,
                    signatureBase64
                });
            }
            else if (msg.type === 'hostkey_prompt' && this.callbacks.onHostKeyPrompt) {
                const trusted = await this.callbacks.onHostKeyPrompt(msg);
                this.sendControl({
                    type: 'hostkey_decision',
                    trusted
                });
            }
        }
    }
}
//# sourceMappingURL=transport.js.map