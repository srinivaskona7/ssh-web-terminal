export type HealthTone = 'good' | 'fair' | 'poor' | 'unknown';
export interface HealthRow {
    label: string;
    value: string;
    tone: HealthTone;
}
export declare const MAX_RECONNECT_ATTEMPTS = 5;
/** Round-trip time bands used by the status bar and the connection panel. */
export declare function classifyRtt(rttMs: number): HealthTone;
export declare function formatRtt(rttMs: number): string;
/** Elapsed time as `1h 04m`, `4m 12s`, or `12s`. */
export declare function formatUptime(elapsedMs: number): string;
/** Backoff before reconnect `attempt` (1-based), capped at 15 s. */
export declare function reconnectDelayMs(attempt: number): number;
export declare function describeReconnectAttempt(attempt: number, max?: number): string;
export interface ConnectionDetails {
    transportMode: 'go-gateway' | 'cloudflare-relay';
    state: 'connected' | 'reconnecting' | 'disconnected' | 'offline';
    target: string;
    rttMs: number;
    uptimeMs: number | null;
    reconnects: number;
    cipher: string;
    kex?: string;
    serverVersion: string;
}
/**
 * Builds the connection panel rows. A value the transport never reported is
 * shown as "not reported" rather than guessed (no fabricated status).
 */
export declare function connectionHealthRows(details: ConnectionDetails): HealthRow[];
/**
 * The relay keeps no server-side session, so a reconnect there starts a new
 * shell. Saying so outright is the only honest way to present it.
 */
export declare function reconnectOutcomeMessage(transportMode: 'go-gateway' | 'cloudflare-relay', reconnects: number): string;
//# sourceMappingURL=session-health.d.ts.map