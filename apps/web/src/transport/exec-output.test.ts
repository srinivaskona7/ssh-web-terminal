import { describe, expect, it } from 'vitest';
import { ExecOutputSink, MAX_RETAINED_EXEC_OUTPUT, abortError } from './exec-output';

describe('ExecOutputSink', () => {
  it('hands a character split across two chunks to the callback whole', () => {
    const chunks: string[] = [];
    const sink = new ExecOutputSink((text) => chunks.push(text));
    const bytes = new TextEncoder().encode('héllo ✓');
    // Split inside the two-byte "é" and inside the three-byte "✓".
    sink.push(bytes.subarray(0, 2));
    sink.push(bytes.subarray(2, 9));
    sink.push(bytes.subarray(9));
    expect(chunks.join('')).toBe('héllo ✓');
    expect(chunks.some((chunk) => chunk.includes('�'))).toBe(false);
    expect(sink.finish()).toBe('héllo ✓');
  });

  it('flushes a sequence cut off at the end as one replacement character', () => {
    const chunks: string[] = [];
    const sink = new ExecOutputSink((text) => chunks.push(text));
    sink.push(new Uint8Array([0x6f, 0x6b, 0xe2, 0x9c]));
    expect(chunks).toEqual(['ok']);
    expect(sink.finish()).toBe('ok�');
    expect(chunks).toEqual(['ok', '�']);
  });

  it('keeps nothing when retention is off but still feeds the callback', () => {
    const chunks: string[] = [];
    const sink = new ExecOutputSink((text) => chunks.push(text), false);
    sink.push(new TextEncoder().encode('line 1\n'));
    expect(sink.finish()).toBe('');
    expect(chunks).toEqual(['line 1\n']);
  });

  it('stops retaining at the cap while the callback still sees everything', () => {
    let seen = 0;
    const sink = new ExecOutputSink((text) => {
      seen += text.length;
    });
    const block = new TextEncoder().encode('a'.repeat(MAX_RETAINED_EXEC_OUTPUT - 5));
    sink.push(block);
    sink.push(new TextEncoder().encode('b'.repeat(10)));
    const kept = sink.finish();
    expect(kept.length).toBe(MAX_RETAINED_EXEC_OUTPUT);
    expect(kept.endsWith('bbbbb')).toBe(true);
    expect(seen).toBe(MAX_RETAINED_EXEC_OUTPUT + 5);
  });
});

describe('abortError', () => {
  it('is the DOMException fetch and AbortSignal users already handle', () => {
    const err = abortError();
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe('AbortError');
    expect(err.message).toBe('Aborted');
  });
});
