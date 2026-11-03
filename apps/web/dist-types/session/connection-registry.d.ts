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
export declare function nextConnectionId(now?: number): ConnectionId;
export declare class ConnectionRegistry<T extends RegistryClient> {
    private readonly entries;
    add(entry: ConnectionEntry<T>): ConnectionEntry<T>;
    get(id: ConnectionId | null | undefined): ConnectionEntry<T> | undefined;
    /** The connection that owns a channel, or undefined. Channels are unique per client. */
    ownerOfChannel(channel: number, connectionId?: ConnectionId): ConnectionEntry<T> | undefined;
    addChannel(id: ConnectionId, channel: number): void;
    removeChannel(id: ConnectionId, channel: number): void;
    /** Closes one channel without touching any other connection. */
    closeChannel(id: ConnectionId, channel: number): void;
    /** Closes one connection and forgets it. Other connections are untouched. */
    close(id: ConnectionId): void;
    closeAll(): void;
    list(): ConnectionEntry<T>[];
    get size(): number;
}
//# sourceMappingURL=connection-registry.d.ts.map