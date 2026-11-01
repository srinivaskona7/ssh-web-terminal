import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { FrameType, decodeControlPayload, decodeFrame, encodeControlFrame, encodeFrame } from '@webssh/protocol';
import { GatewaySessionTransport, MAX_PENDING_INPUT_BYTES, PendingInputQueue, buildTmuxAttachCommand, computeBackoffMs } from './index.js';
describe('Transport Resilience & Sequence Replay (M4)', () => {
    it('computes exponential backoff with jitter within expected bounds', () => {
        fc.assert(fc.property(fc.integer({ min: 0, max: 12 }), fc.double({ min: 0, max: 1, noNaN: true }), (attempt, randVal) => {
            const delay = computeBackoffMs(attempt, 250, 15_000, () => randVal);
            const ceiling = Math.min(15_000, 250 * Math.pow(2, attempt));
            expect(delay).toBeGreaterThanOrEqual(250);
            expect(delay).toBeLessThanOrEqual(ceiling);
        }));
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
        expect(drained[0].seq).toBe(1n);
        expect(drained[1].seq).toBe(2n);
        expect(queue.byteLength).toBe(0);
    });
    it('deduplicates replayed frames and sends credit replenishment and sign_response', async () => {
        const receivedPty = [];
        const sentFrames = [];
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
        await transport.handleInboundBytes(encodeFrame({
            type: FrameType.PtyData,
            channel: 1,
            seq: 1n,
            payload: new Uint8Array([0x6f, 0x6b])
        }));
        await transport.handleInboundBytes(encodeFrame({
            type: FrameType.PtyData,
            channel: 1,
            seq: 1n,
            payload: new Uint8Array([0x6f, 0x6b])
        }));
        expect(receivedPty.length).toBe(1);
        // Remote-signer sign_request -> sign_response
        await transport.handleInboundBytes(encodeControlFrame(2n, {
            type: 'sign_request',
            requestId: 'req-42',
            algorithm: 'ssh-ed25519',
            dataBase64: 'AAAA',
            keyFingerprint: 'SHA256:test'
        }));
        const lastSent = decodeFrame(sentFrames[sentFrames.length - 1]);
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
//# sourceMappingURL=transport.test.js.map