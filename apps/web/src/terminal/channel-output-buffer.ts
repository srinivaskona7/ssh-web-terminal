/**
 * Per-channel output that arrived before its pane could render.
 *
 * A PTY can emit its banner and first prompt between `channel_opened` and the
 * pane binding that channel. Dropping those bytes is the "blank terminal"
 * failure. This buffer holds them until an adapter exists, bounded so a dead
 * pane cannot grow it without limit.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024;

export interface Writable {
  writeBytes(data: Uint8Array): void;
}

export class ChannelOutputBuffer {
  private readonly pending = new Map<string, Uint8Array[]>();
  private readonly bytes = new Map<string, number>();

  constructor(private readonly maxBytes = DEFAULT_MAX_BUFFERED_BYTES) {}

  push(key: string, data: Uint8Array): void {
    if (data.length === 0) return;
    const chunks = this.pending.get(key) ?? [];
    chunks.push(data);
    let total = (this.bytes.get(key) ?? 0) + data.length;
    // Drop the oldest chunks first; the newest bytes are what the user needs.
    while (total > this.maxBytes && chunks.length > 0) {
      const dropped = chunks.shift();
      total -= dropped?.length ?? 0;
    }
    this.pending.set(key, chunks);
    this.bytes.set(key, total);
  }

  /** Writes everything held for `key` to `target`, then forgets it. */
  drainTo(key: string, target: Writable): number {
    const chunks = this.pending.get(key);
    if (!chunks || chunks.length === 0) return 0;
    this.pending.delete(key);
    this.bytes.delete(key);
    for (const chunk of chunks) target.writeBytes(chunk);
    return chunks.length;
  }

  size(key: string): number {
    return this.bytes.get(key) ?? 0;
  }

  has(key: string): boolean {
    return (this.bytes.get(key) ?? 0) > 0;
  }

  clear(key?: string): void {
    if (key) {
      this.pending.delete(key);
      this.bytes.delete(key);
      return;
    }
    this.pending.clear();
    this.bytes.clear();
  }
}
