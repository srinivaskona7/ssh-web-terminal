import { computeBackoffMs } from '../transport/transport';
export const MAX_RECONNECT_ATTEMPTS = 5;
/** Round-trip time bands used by the status bar and the connection panel. */
export function classifyRtt(rttMs) {
    if (!Number.isFinite(rttMs) || rttMs <= 0)
        return 'unknown';
    if (rttMs <= 80)
        return 'good';
    if (rttMs <= 200)
        return 'fair';
    return 'poor';
}
export function formatRtt(rttMs) {
    if (!Number.isFinite(rttMs) || rttMs <= 0)
        return 'RTT —';
    return `RTT ${Math.round(rttMs)} ms`;
}
/** Elapsed time as `1h 04m`, `4m 12s`, or `12s`. */
export function formatUptime(elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0)
        return '0s';
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0)
        return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    if (minutes > 0)
        return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    return `${seconds}s`;
}
/** Backoff before reconnect `attempt` (1-based), capped at 15 s. */
export function reconnectDelayMs(attempt) {
    return computeBackoffMs(Math.max(1, attempt), 500, 15_000);
}
export function describeReconnectAttempt(attempt, max = MAX_RECONNECT_ATTEMPTS) {
    return `Connection lost — reconnecting (attempt ${attempt}/${max})…`;
}
/**
 * Builds the connection panel rows. A value the transport never reported is
 * shown as "not reported" rather than guessed (no fabricated status).
 */
export function connectionHealthRows(details) {
    const rows = [
        {
            label: 'Connection',
            value: details.state === 'connected'
                ? details.target || 'connected'
                : details.state === 'reconnecting'
                    ? 'reconnecting…'
                    : 'disconnected',
            tone: details.state === 'connected' ? 'good' : details.state === 'reconnecting' ? 'fair' : 'unknown'
        },
        {
            label: 'Round trip',
            value: formatRtt(details.rttMs).replace(/^RTT /, ''),
            tone: classifyRtt(details.rttMs)
        },
        {
            label: 'Uptime',
            value: details.uptimeMs === null ? 'not reported' : formatUptime(details.uptimeMs),
            tone: 'unknown'
        },
        {
            label: 'Reconnects',
            value: details.reconnects > 0 ? String(details.reconnects) : 'none',
            tone: details.reconnects === 0 ? 'good' : 'fair'
        },
        {
            label: 'Transport',
            value: details.transportMode === 'go-gateway' ? 'Go gateway (resumable)' : 'Cloudflare relay',
            tone: 'unknown'
        },
        {
            label: 'Cipher',
            value: details.cipher || 'not reported',
            tone: 'unknown'
        },
        {
            label: 'Key exchange',
            value: details.kex || 'not reported',
            tone: 'unknown'
        },
        {
            label: 'Server',
            value: details.serverVersion || 'not reported',
            tone: 'unknown'
        }
    ];
    return rows;
}
/**
 * The relay keeps no server-side session, so a reconnect there starts a new
 * shell. Saying so outright is the only honest way to present it.
 */
export function reconnectOutcomeMessage(transportMode, reconnects) {
    if (transportMode === 'go-gateway') {
        return `Session resumed — output replayed, shell state preserved (reconnect ${reconnects}).`;
    }
    return `Relay reconnected — a new shell was started; the previous one ended with the dropped socket (reconnect ${reconnects}).`;
}
//# sourceMappingURL=session-health.js.map