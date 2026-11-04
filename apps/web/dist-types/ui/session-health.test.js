import { describe, expect, it } from 'vitest';
import { classifyRtt, connectionHealthRows, describeReconnectAttempt, formatRtt, formatUptime, MAX_RECONNECT_ATTEMPTS, reconnectDelayMs, reconnectOutcomeMessage } from './session-health';
describe('session health', () => {
    it('bands round-trip time without inventing a value for "not measured"', () => {
        expect(classifyRtt(0)).toBe('unknown');
        expect(classifyRtt(Number.NaN)).toBe('unknown');
        expect(classifyRtt(40)).toBe('good');
        expect(classifyRtt(80)).toBe('good');
        expect(classifyRtt(120)).toBe('fair');
        expect(classifyRtt(320)).toBe('poor');
        expect(formatRtt(0)).toBe('RTT —');
        expect(formatRtt(41.6)).toBe('RTT 42 ms');
    });
    it('formats uptime compactly', () => {
        expect(formatUptime(0)).toBe('0s');
        expect(formatUptime(12_000)).toBe('12s');
        expect(formatUptime(252_000)).toBe('4m 12s');
        expect(formatUptime(3_840_000)).toBe('1h 04m');
    });
    it('backs off and caps the reconnect delay', () => {
        const first = reconnectDelayMs(1);
        expect(first).toBeGreaterThanOrEqual(500);
        expect(first).toBeLessThanOrEqual(1000);
        expect(reconnectDelayMs(99)).toBeLessThanOrEqual(15_000);
        expect(describeReconnectAttempt(2)).toContain(`2/${MAX_RECONNECT_ATTEMPTS}`);
    });
    it('describes a gateway reconnect as resume and a relay reconnect as a new shell', () => {
        expect(reconnectOutcomeMessage('go-gateway', 1)).toMatch(/shell state preserved/);
        expect(reconnectOutcomeMessage('cloudflare-relay', 1)).toMatch(/new shell/);
    });
    it('reports unreported transport details instead of guessing', () => {
        const rows = connectionHealthRows({
            transportMode: 'cloudflare-relay',
            state: 'connected',
            target: 'ubuntu@10.0.0.4',
            rttMs: 0,
            uptimeMs: 0,
            reconnects: 0,
            cipher: '',
            serverVersion: ''
        });
        const byLabel = new Map(rows.map((row) => [row.label, row.value]));
        expect(byLabel.get('Round trip')).toBe('—');
        expect(byLabel.get('Cipher')).toBe('not reported');
        expect(byLabel.get('Key exchange')).toBe('not reported');
        expect(byLabel.get('Server')).toBe('not reported');
        expect(byLabel.get('Reconnects')).toBe('none');
    });
    it('shows uptime as not reported before a session has lasted any time', () => {
        const rows = connectionHealthRows({
            transportMode: 'go-gateway',
            state: 'disconnected',
            target: '',
            rttMs: 0,
            uptimeMs: null,
            reconnects: 0,
            cipher: '',
            serverVersion: ''
        });
        expect(rows.find((row) => row.label === 'Uptime')?.value).toBe('not reported');
    });
});
//# sourceMappingURL=session-health.test.js.map