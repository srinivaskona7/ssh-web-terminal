/**
 * Per-channel output that arrived before its pane could render.
 *
 * A PTY can emit its banner and first prompt between `channel_opened` and the
 * pane binding that channel. Dropping those bytes is the "blank terminal"
 * failure. This buffer holds them until an adapter exists, bounded so a dead
 * pane cannot grow it without limit.
 */
export declare const DEFAULT_MAX_BUFFERED_BYTES: number;
export interface Writable {
    writeBytes(data: Uint8Array): void;
}
export declare class ChannelOutputBuffer {
    private readonly maxBytes;
    private readonly pending;
    private readonly bytes;
    constructor(maxBytes?: number);
    push(key: string, data: Uint8Array): void;
    /** Writes everything held for `key` to `target`, then forgets it. */
    drainTo(key: string, target: Writable): number;
    size(key: string): number;
    has(key: string): boolean;
    clear(key?: string): void;
}
//# sourceMappingURL=channel-output-buffer.d.ts.map