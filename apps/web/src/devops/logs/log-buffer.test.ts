import { describe, expect, it } from 'vitest';
import {
  LOG_BUFFER_MAX_BYTES,
  LOG_BUFFER_MAX_LINES,
  LogBuffer,
  detectLevel,
  filterLines,
  stripTerminalControls,
  utf8Length
} from './log-buffer.js';

const texts = (buffer: LogBuffer): string[] => buffer.lines().map((line) => line.text);

describe('LogBuffer line assembly', () => {
  it('joins a line split across chunks and keeps the tail pending until its newline', () => {
    const buffer = new LogBuffer();
    expect(buffer.push('2024-01-01 starting serv')).toBe(0);
    expect(texts(buffer)).toEqual([]);
    expect(buffer.push('er\nsecond li')).toBe(1);
    expect(texts(buffer)).toEqual(['2024-01-01 starting server']);
    expect(buffer.push('ne\n')).toBe(1);
    expect(texts(buffer)).toEqual(['2024-01-01 starting server', 'second line']);
  });

  it('strips CRLF, including a CR and LF that arrive in different chunks', () => {
    const buffer = new LogBuffer();
    buffer.push('first\r\nsecond\r');
    buffer.push('\nthird\r\n');
    expect(texts(buffer)).toEqual(['first', 'second', 'third']);
  });

  it('keeps what a terminal would show for carriage-return progress lines', () => {
    const buffer = new LogBuffer();
    buffer.push('pulling 10%\rpulling 55%\rpulling 100%\n');
    expect(texts(buffer)).toEqual(['pulling 100%']);
  });

  it('keeps stdout and stderr fragments apart when chunks interleave', () => {
    const buffer = new LogBuffer();
    buffer.push('out-a', 'stdout');
    buffer.push('err-a', 'stderr');
    buffer.push('-done\n', 'stdout');
    buffer.push('-done\n', 'stderr');
    expect(buffer.lines().map((line) => [line.stream, line.text])).toEqual([
      ['stdout', 'out-a-done'],
      ['stderr', 'err-a-done']
    ]);
  });

  it('flush() completes a final line that never got a newline', () => {
    const buffer = new LogBuffer();
    buffer.push('no newline at end');
    expect(buffer.flush()).toBe(1);
    expect(texts(buffer)).toEqual(['no newline at end']);
    expect(buffer.flush()).toBe(0);
  });

  it('keeps empty lines, non-ASCII text and tabs as they arrived', () => {
    const buffer = new LogBuffer();
    buffer.push('größe\tüber\n\n日本語のログ ✓\n');
    expect(texts(buffer)).toEqual(['größe\tüber', '', '日本語のログ ✓']);
  });

  it('removes ANSI colour codes and other terminal controls from stored text', () => {
    expect(stripTerminalControls('\u001b[31mERROR\u001b[0m disk \u001b]0;title\u0007full\u0000')).toBe('ERROR disk full');
    const buffer = new LogBuffer();
    buffer.push('\u001b[1;33mWARN\u001b[0m slow query\n');
    expect(buffer.lines()[0]).toMatchObject({ text: 'WARN slow query', level: 'warn' });
  });

  it('splits a runaway line without a newline instead of growing the pending fragment forever', () => {
    const buffer = new LogBuffer({ maxLineChars: 10 });
    buffer.push('abcdefghijklmnopqrstuvwxyz');
    expect(texts(buffer)).toEqual(['abcdefghij', 'klmnopqrst']);
    buffer.push('\n');
    expect(texts(buffer)).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz']);
  });
});

describe('LogBuffer bounds', () => {
  it('defaults to 5,000 lines and 2 MiB', () => {
    expect(LOG_BUFFER_MAX_LINES).toBe(5000);
    expect(LOG_BUFFER_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it('evicts the oldest lines past the line cap and counts every dropped line', () => {
    const buffer = new LogBuffer();
    const chunk = Array.from({ length: 5003 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    buffer.push(chunk);
    expect(buffer.size).toBe(5000);
    expect(buffer.dropped).toBe(3);
    expect(texts(buffer)[0]).toBe('line 4');
    expect(texts(buffer)[4999]).toBe('line 5003');
    expect(buffer.lastSeq).toBe(5003);
  });

  it('evicts by byte size before the line cap is reached', () => {
    const buffer = new LogBuffer({ maxLines: 100, maxBytes: 25 });
    buffer.push('aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n');
    expect(texts(buffer)).toEqual(['bbbbbbbbbb', 'cccccccccc']);
    expect(buffer.dropped).toBe(1);
    expect(buffer.bytes).toBe(20);
  });

  it('counts bytes as UTF-8, not UTF-16 code units', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('ü')).toBe(2);
    expect(utf8Length('日')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
    const buffer = new LogBuffer({ maxBytes: 7 });
    buffer.push('日日\nab\n');
    expect(texts(buffer)).toEqual(['ab']);
    expect(buffer.dropped).toBe(1);
  });

  it('keeps sequence numbers monotonic across eviction and clear()', () => {
    const buffer = new LogBuffer({ maxLines: 2 });
    buffer.push('a\nb\nc\n');
    expect(buffer.lines().map((line) => line.seq)).toEqual([2, 3]);
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.dropped).toBe(0);
    buffer.push('d\n');
    expect(buffer.lines()[0]?.seq).toBe(4);
  });
});

describe('detectLevel', () => {
  it.each([
    ['2024-05-01T10:00:00Z ERROR payment failed', 'error'],
    ['[FATAL] out of memory', 'error'],
    ['panic: runtime error: index out of range', 'error'],
    ['Traceback (most recent call last):', 'error'],
    ['Failed password for invalid user admin from 203.0.113.9', 'error'],
    ['WARN  pool exhausted, waiting', 'warn'],
    ['Warning: deprecated option', 'warn'],
    ['INFO started in 340ms', 'info'],
    ['notice: config reloaded', 'info'],
    ['DEBUG cache miss key=user:1', 'debug'],
    ['trace: entering handler', 'debug'],
    ['E1023 10:00:00.123456    1 reflector.go:138] watch failed', 'error'],
    ['W1023 10:00:00.123456    1 warnings.go:70] v1 is deprecated', 'warn'],
    ['I1023 10:00:00.123456    1 server.go:42] serving', 'info'],
    ['{"level":"warn","msg":"slow"}', 'warn'],
    ['ts=2024-01-01 level=error msg="db down"', 'error'],
    ['GET /healthz 200 3ms', 'unknown'],
    ['', 'unknown']
  ])('%s → %s', (line, level) => {
    expect(detectLevel(line)).toBe(level);
  });

  it('uses the earliest level word, so an INFO line that mentions an error stays info', () => {
    expect(detectLevel('INFO retrying after error')).toBe('info');
    expect(detectLevel('connection error; INFO will retry')).toBe('error');
  });

  it('does not treat counters such as "0 errors" as an error', () => {
    expect(detectLevel('build finished: 0 errors, 0 warnings')).toBe('unknown');
  });
});

describe('filtering', () => {
  const buffer = new LogBuffer();
  buffer.push('INFO user alice logged in\nERROR user bob: timeout\nWARN disk 91%\nINFO user Carol logged in\n');

  it('matches a plain substring case-insensitively and treats regex characters literally', () => {
    expect(buffer.visible({ text: 'USER' }).lines.map((line) => line.text)).toEqual([
      'INFO user alice logged in',
      'ERROR user bob: timeout',
      'INFO user Carol logged in'
    ]);
    expect(buffer.visible({ text: '91%' }).lines).toHaveLength(1);
    expect(buffer.visible({ text: 'a.ice' }).lines).toHaveLength(0);
  });

  it('applies a regular expression only when the user opts in', () => {
    const result = buffer.visible({ text: 'user (alice|carol)', regex: true });
    expect(result.error).toBeNull();
    expect(result.lines.map((line) => line.text)).toEqual(['INFO user alice logged in', 'INFO user Carol logged in']);
  });

  it('reports an invalid regex instead of throwing, and leaves the view unfiltered', () => {
    const result = buffer.visible({ text: 'user (alice', regex: true });
    expect(result.error).toMatch(/invalid regular expression/i);
    expect(result.lines).toHaveLength(4);
  });

  it('returns every line for an empty filter', () => {
    expect(filterLines(buffer.lines(), { text: '   ' }).lines).toHaveLength(4);
  });
});
