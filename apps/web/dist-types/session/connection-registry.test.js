import { describe, expect, it } from 'vitest';
import { ConnectionRegistry, nextConnectionId } from './connection-registry';
class FakeClient {
    isConnected = true;
    closed = false;
    closedChannels = [];
    close() {
        this.closed = true;
        this.isConnected = false;
    }
    closeChannel(channel) {
        this.closedChannels.push(channel);
    }
}
function entry(id, client, host = 'example.test') {
    return {
        id,
        host,
        port: 22,
        user: 'ubuntu',
        transport: 'cloudflare-relay',
        client,
        channels: new Set([1])
    };
}
describe('ConnectionRegistry', () => {
    it('keeps independent connections alive when another one closes', () => {
        const registry = new ConnectionRegistry();
        const first = new FakeClient();
        const second = new FakeClient();
        registry.add(entry('conn-1', first, 'a.test'));
        registry.add(entry('conn-2', second, 'b.test'));
        registry.close('conn-1');
        expect(first.closed).toBe(true);
        expect(second.closed).toBe(false);
        expect(registry.size).toBe(1);
        expect(registry.get('conn-2')?.host).toBe('b.test');
    });
    it('closes one channel without touching its connection or other channels', () => {
        const registry = new ConnectionRegistry();
        const client = new FakeClient();
        registry.add(entry('conn-1', client));
        registry.addChannel('conn-1', 7);
        registry.closeChannel('conn-1', 7);
        expect(client.closedChannels).toEqual([7]);
        expect(client.closed).toBe(false);
        expect(registry.get('conn-1')?.channels.has(7)).toBe(false);
        expect(registry.get('conn-1')?.channels.has(1)).toBe(true);
    });
    it('maps a channel back to the connection that owns it', () => {
        const registry = new ConnectionRegistry();
        registry.add(entry('conn-1', new FakeClient(), 'a.test'));
        registry.add(entry('conn-2', new FakeClient(), 'b.test'));
        registry.addChannel('conn-2', 9);
        expect(registry.ownerOfChannel(9)?.id).toBe('conn-2');
        expect(registry.ownerOfChannel(9, 'conn-1')).toBeUndefined();
        expect(registry.ownerOfChannel(42)).toBeUndefined();
    });
    it('survives a client that has already closed', () => {
        const registry = new ConnectionRegistry();
        const client = new FakeClient();
        client.close = () => {
            throw new Error('already closed');
        };
        registry.add(entry('conn-1', client));
        expect(() => registry.close('conn-1')).not.toThrow();
        expect(registry.size).toBe(0);
    });
    it('generates distinct connection ids', () => {
        const ids = new Set([nextConnectionId(1), nextConnectionId(1), nextConnectionId(1)]);
        expect(ids.size).toBe(3);
    });
});
//# sourceMappingURL=connection-registry.test.js.map