import { afterEach, describe, expect, it } from 'vitest';
import { FrameType, decodeControlPayload, decodeFrame, encodeControlFrame, encodeFrame } from '@webssh/protocol';
import { LiveGatewaySessionClient } from './transport';
/**
 * Minimal WebSocket double: it records what the client sends and lets the test
 * push server frames back, so the reconnect handshake is verified end to end
 * without a live gateway.
 */
class FakeSocket {
    url;
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    static instances = [];
    readyState = FakeSocket.CONNECTING;
    binaryType = 'arraybuffer';
    sent = [];
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    constructor(url) {
        this.url = url;
        FakeSocket.instances.push(this);
    }
    send(data) {
        this.sent.push(data instanceof Uint8Array ? data.slice().buffer : data);
    }
    close() {
        this.readyState = FakeSocket.CLOSED;
        this.onclose?.();
    }
    fireOpen() {
        this.readyState = FakeSocket.OPEN;
        this.onopen?.();
    }
    receiveControl(msg, seq) {
        const frame = encodeControlFrame(seq, msg);
        this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
    }
    receivePty(seq, text) {
        const frame = encodeFrame({
            type: FrameType.PtyData,
            channel: 1,
            seq,
            payload: new TextEncoder().encode(text)
        });
        this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
    }
    controls() {
        const messages = [];
        for (const buffer of this.sent) {
            const frame = decodeFrame(new Uint8Array(buffer));
            if (frame.type !== FrameType.Control)
                continue;
            messages.push(decodeControlPayload(frame.payload));
        }
        return messages;
    }
}
function params() {
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
    type: 'connected',
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
        globalThis.WebSocket = FakeSocket;
        const client = new LiveGatewaySessionClient(params());
        const first = client.connect();
        const socketA = FakeSocket.instances[0];
        socketA.fireOpen();
        socketA.receiveControl(connectedFrame, 1n);
        await expect(first).resolves.toMatchObject({ sessionId: 'sess-1' });
        expect(socketA.controls().map((msg) => msg.type)).toEqual(['hello', 'connect']);
        // Terminal bytes are what the resume offset is measured against.
        socketA.receivePty(7n, 'hello');
        await Promise.resolve();
        const second = client.reconnect();
        const socketB = FakeSocket.instances[1];
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
        globalThis.WebSocket = FakeSocket;
        const client = new LiveGatewaySessionClient(params());
        expect(client.canResume()).toBe(false);
        await expect(client.reconnect()).rejects.toThrow(/no detached session/i);
    });
    it('surfaces a fatal RESUME_FAILED instead of pretending the session came back', async () => {
        globalThis.WebSocket = FakeSocket;
        const client = new LiveGatewaySessionClient(params());
        const first = client.connect();
        const socketA = FakeSocket.instances[0];
        socketA.fireOpen();
        socketA.receiveControl(connectedFrame, 1n);
        await first;
        const second = client.reconnect();
        const socketB = FakeSocket.instances[1];
        socketB.fireOpen();
        socketB.receiveControl({ type: 'error', code: 'RESUME_FAILED', message: 'session expired', fatal: true }, 2n);
        await expect(second).rejects.toThrow(/RESUME_FAILED/);
    });
});
//# sourceMappingURL=reconnect.test.js.map