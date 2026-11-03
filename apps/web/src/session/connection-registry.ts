/**
 * Tracks every live SSH connection in the workspace.
 *
 * A single "current session" ref was the source of three defects: a second
 * connection closed the first, a tab could not tell which transport it
 * belonged to, and a channel could not be mapped back to its owner. Each
 * connection now has an id, owns its client and its channels, and survives
 * unrelated connections opening or closing.
 */
export type ConnectionId = string;

export interface RegistryClient {
  readonly isConnected: boolean;
  close(): void;
  closeChannel(channel: number): void;
}

export interface ConnectionEntry<T extends RegistryClient> {
  readonly id: ConnectionId;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly transport: 'cloudflare-relay' | 'go-gateway';
  readonly client: T;
  readonly channels: Set<number>;
}

let counter = 0;

export function nextConnectionId(now = Date.now()): ConnectionId {
  counter += 1;
  return `conn-${now.toString(36)}-${counter}`;
}

export class ConnectionRegistry<T extends RegistryClient> {
  private readonly entries = new Map<ConnectionId, ConnectionEntry<T>>();

  add(entry: ConnectionEntry<T>): ConnectionEntry<T> {
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: ConnectionId | null | undefined): ConnectionEntry<T> | undefined {
    return id ? this.entries.get(id) : undefined;
  }

  /** The connection that owns a channel, or undefined. Channels are unique per client. */
  ownerOfChannel(channel: number, connectionId?: ConnectionId): ConnectionEntry<T> | undefined {
    if (connectionId) {
      const entry = this.entries.get(connectionId);
      return entry && entry.channels.has(channel) ? entry : undefined;
    }
    for (const entry of this.entries.values()) {
      if (entry.channels.has(channel)) return entry;
    }
    return undefined;
  }

  addChannel(id: ConnectionId, channel: number): void {
    this.entries.get(id)?.channels.add(channel);
  }

  removeChannel(id: ConnectionId, channel: number): void {
    this.entries.get(id)?.channels.delete(channel);
  }

  /** Closes one channel without touching any other connection. */
  closeChannel(id: ConnectionId, channel: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.channels.delete(channel);
    try {
      entry.client.closeChannel(channel);
    } catch {
      // A client that already closed is not an error here.
    }
  }

  /** Closes one connection and forgets it. Other connections are untouched. */
  close(id: ConnectionId): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    try {
      entry.client.close();
    } catch {
      // A client that already closed is not an error here.
    }
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
  }

  list(): ConnectionEntry<T>[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }
}
