let counter = 0;
export function nextConnectionId(now = Date.now()) {
    counter += 1;
    return `conn-${now.toString(36)}-${counter}`;
}
export class ConnectionRegistry {
    entries = new Map();
    add(entry) {
        this.entries.set(entry.id, entry);
        return entry;
    }
    get(id) {
        return id ? this.entries.get(id) : undefined;
    }
    /** The connection that owns a channel, or undefined. Channels are unique per client. */
    ownerOfChannel(channel, connectionId) {
        if (connectionId) {
            const entry = this.entries.get(connectionId);
            return entry && entry.channels.has(channel) ? entry : undefined;
        }
        for (const entry of this.entries.values()) {
            if (entry.channels.has(channel))
                return entry;
        }
        return undefined;
    }
    addChannel(id, channel) {
        this.entries.get(id)?.channels.add(channel);
    }
    removeChannel(id, channel) {
        this.entries.get(id)?.channels.delete(channel);
    }
    /** Closes one channel without touching any other connection. */
    closeChannel(id, channel) {
        const entry = this.entries.get(id);
        if (!entry)
            return;
        entry.channels.delete(channel);
        try {
            entry.client.closeChannel(channel);
        }
        catch {
            // A client that already closed is not an error here.
        }
    }
    /** Closes one connection and forgets it. Other connections are untouched. */
    close(id) {
        const entry = this.entries.get(id);
        if (!entry)
            return;
        this.entries.delete(id);
        try {
            entry.client.close();
        }
        catch {
            // A client that already closed is not an error here.
        }
    }
    closeAll() {
        for (const id of [...this.entries.keys()])
            this.close(id);
    }
    list() {
        return [...this.entries.values()];
    }
    get size() {
        return this.entries.size;
    }
}
//# sourceMappingURL=connection-registry.js.map