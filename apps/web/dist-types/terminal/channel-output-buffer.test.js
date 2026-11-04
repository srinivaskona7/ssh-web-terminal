import { describe, expect, it } from 'vitest';
import { ChannelOutputBuffer } from './channel-output-buffer';
const bytes = (s) => new TextEncoder().encode(s);
describe('ChannelOutputBuffer', () => {
    it('holds output until a pane is ready, then writes it in order', () => {
        const buffer = new ChannelOutputBuffer();
        buffer.push('c1:1', bytes('banner\n'));
        buffer.push('c1:1', bytes('prompt$ '));
        const written = [];
        const drained = buffer.drainTo('c1:1', {
            writeBytes: (data) => written.push(new TextDecoder().decode(data))
        });
        expect(drained).toBe(2);
        expect(written.join('')).toBe('banner\nprompt$ ');
        expect(buffer.has('c1:1')).toBe(false);
    });
    it('keeps channels apart', () => {
        const buffer = new ChannelOutputBuffer();
        buffer.push('c1:1', bytes('one'));
        buffer.push('c2:1', bytes('two'));
        const first = [];
        buffer.drainTo('c1:1', { writeBytes: (d) => first.push(new TextDecoder().decode(d)) });
        expect(first.join('')).toBe('one');
        expect(buffer.has('c2:1')).toBe(true);
    });
    it('drops the oldest bytes once the cap is reached', () => {
        const buffer = new ChannelOutputBuffer(10);
        buffer.push('c1:1', bytes('12345'));
        buffer.push('c1:1', bytes('67890'));
        buffer.push('c1:1', bytes('abcde'));
        expect(buffer.size('c1:1')).toBeLessThanOrEqual(10);
        const written = [];
        buffer.drainTo('c1:1', { writeBytes: (d) => written.push(new TextDecoder().decode(d)) });
        expect(written.join('')).toBe('67890abcde');
    });
    it('ignores empty chunks and drains a missing key harmlessly', () => {
        const buffer = new ChannelOutputBuffer();
        buffer.push('c1:1', new Uint8Array());
        expect(buffer.has('c1:1')).toBe(false);
        expect(buffer.drainTo('nope', { writeBytes: () => { } })).toBe(0);
    });
    it('can be cleared per key or entirely', () => {
        const buffer = new ChannelOutputBuffer();
        buffer.push('a', bytes('x'));
        buffer.push('b', bytes('y'));
        buffer.clear('a');
        expect(buffer.has('a')).toBe(false);
        expect(buffer.has('b')).toBe(true);
        buffer.clear();
        expect(buffer.has('b')).toBe(false);
    });
});
//# sourceMappingURL=channel-output-buffer.test.js.map