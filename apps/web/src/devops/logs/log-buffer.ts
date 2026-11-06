/**
 * Bounded line buffer for the live log streamer.
 *
 * Remote output arrives in arbitrary chunks: a line can be split across two
 * chunks, CRLF can straddle them, and stdout and stderr interleave. The buffer
 * reassembles whole lines per stream, keeps at most `maxLines` lines and
 * `maxBytes` of UTF-8 text (whichever is hit first), and counts what it drops
 * so the view can say so instead of silently losing history.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'unknown';
export type LogStream = 'stdout' | 'stderr';

export interface LogLine {
  /** Monotonic sequence number; never reused, so it survives eviction. */
  seq: number;
  text: string;
  level: LogLevel;
  stream: LogStream;
}

export interface LogFilter {
  text: string;
  /** Opt-in: treat `text` as a regular expression instead of a substring. */
  regex?: boolean;
}

export interface FilterResult {
  lines: LogLine[];
  /** Set when the regex does not compile; the lines are then unfiltered. */
  error: string | null;
}

export const LOG_BUFFER_MAX_LINES = 5_000;
export const LOG_BUFFER_MAX_BYTES = 2 * 1024 * 1024;
/** A line with no newline in sight is cut here rather than buffered forever. */
export const LOG_LINE_MAX_CHARS = 16 * 1024;

const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_OTHER = /\u001b[@-Z\\-_]/g;
const OTHER_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Drop colour codes and control characters; keep tabs. */
export function stripTerminalControls(text: string): string {
  return text.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(ANSI_OTHER, '').replace(OTHER_CONTROLS, '');
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      // A surrogate pair is one 4-byte code point.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

const LEVEL_OF_WORD: Record<string, LogLevel> = {
  error: 'error',
  err: 'error',
  fatal: 'error',
  crit: 'error',
  critical: 'error',
  panic: 'error',
  emerg: 'error',
  emergency: 'error',
  alert: 'error',
  severe: 'error',
  exception: 'error',
  traceback: 'error',
  fail: 'error',
  failed: 'error',
  failure: 'error',
  warn: 'warn',
  warning: 'warn',
  wrn: 'warn',
  deprecated: 'warn',
  info: 'info',
  inf: 'info',
  information: 'info',
  notice: 'info',
  debug: 'debug',
  dbg: 'debug',
  trace: 'debug',
  verbose: 'debug'
};

const LEVEL_WORD = new RegExp(`\\b(${Object.keys(LEVEL_OF_WORD).join('|')})\\b`, 'i');
const LEVEL_FIELD = /\b(?:level|lvl|severity|loglevel)\b["']?\s*[:=]\s*["']?([A-Za-z]+)/i;
// klog (Kubernetes components): I/W/E/F, MMDD, then a wall-clock time.
const KLOG = /^([IWEF])\d{4}\s+\d{2}:\d{2}:\d{2}/;

/**
 * Guess a line's level from its text. Structured markers win (klog prefix,
 * `level=` / `"level":` fields); otherwise the earliest level word decides, so
 * "INFO retrying after error" stays info.
 */
export function detectLevel(text: string): LogLevel {
  const klog = KLOG.exec(text);
  if (klog) {
    const letter = klog[1];
    return letter === 'I' ? 'info' : letter === 'W' ? 'warn' : 'error';
  }
  const field = LEVEL_FIELD.exec(text);
  const fromField = field ? LEVEL_OF_WORD[field[1]!.toLowerCase()] : undefined;
  if (fromField) return fromField;
  const word = LEVEL_WORD.exec(text);
  return word ? (LEVEL_OF_WORD[word[1]!.toLowerCase()] ?? 'unknown') : 'unknown';
}

type Matcher = { test: (text: string) => boolean } | { error: string };

function compileFilter(filter: LogFilter): Matcher | null {
  if (filter.text.trim() === '') return null;
  if (filter.regex) {
    try {
      const re = new RegExp(filter.text, 'i');
      return { test: (text) => re.test(text) };
    } catch (err) {
      return { error: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const needle = filter.text.toLowerCase();
  return { test: (text) => text.toLowerCase().includes(needle) };
}

export function filterLines(lines: readonly LogLine[], filter: LogFilter): FilterResult {
  const matcher = compileFilter(filter);
  if (!matcher) return { lines: [...lines], error: null };
  if ('error' in matcher) return { lines: [...lines], error: matcher.error };
  return { lines: lines.filter((line) => matcher.test(line.text)), error: null };
}

/** What a terminal would leave on screen after carriage-return redraws. */
function finishLine(raw: string): string {
  const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  const lastCr = text.lastIndexOf('\r');
  return stripTerminalControls(lastCr >= 0 ? text.slice(lastCr + 1) : text);
}

export class LogBuffer {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxLineChars: number;
  private store: Array<LogLine & { bytes: number }> = [];
  /** Index of the oldest live line in `store`; evicted entries sit before it. */
  private start = 0;
  private totalBytes = 0;
  private droppedLines = 0;
  private seq = 0;
  private readonly pending: Record<LogStream, string> = { stdout: '', stderr: '' };

  constructor(options: { maxLines?: number; maxBytes?: number; maxLineChars?: number } = {}) {
    this.maxLines = options.maxLines ?? LOG_BUFFER_MAX_LINES;
    this.maxBytes = options.maxBytes ?? LOG_BUFFER_MAX_BYTES;
    this.maxLineChars = options.maxLineChars ?? LOG_LINE_MAX_CHARS;
  }

  /** Add a chunk of output; returns how many complete lines it produced. */
  push(chunk: string, stream: LogStream = 'stdout'): number {
    let text = this.pending[stream] + chunk;
    let added = 0;
    let newline = text.indexOf('\n');
    while (newline >= 0) {
      this.append(text.slice(0, newline), stream);
      added++;
      text = text.slice(newline + 1);
      newline = text.indexOf('\n');
    }
    while (text.length > this.maxLineChars) {
      this.append(text.slice(0, this.maxLineChars), stream);
      added++;
      text = text.slice(this.maxLineChars);
    }
    this.pending[stream] = text;
    return added;
  }

  /** Complete any partial lines; called when the stream ends. */
  flush(): number {
    let added = 0;
    for (const stream of ['stdout', 'stderr'] as const) {
      if (this.pending[stream] !== '') {
        this.append(this.pending[stream], stream);
        this.pending[stream] = '';
        added++;
      }
    }
    return added;
  }

  lines(): LogLine[] {
    return this.store.slice(this.start).map(({ seq, text, level, stream }) => ({ seq, text, level, stream }));
  }

  visible(filter: LogFilter): FilterResult {
    return filterLines(this.lines(), filter);
  }

  get size(): number {
    return this.store.length - this.start;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get dropped(): number {
    return this.droppedLines;
  }

  /** Sequence number of the newest line ever added; 0 before the first. */
  get lastSeq(): number {
    return this.seq;
  }

  /** Empty the buffer. Sequence numbers keep counting so old marks stay valid. */
  clear(): void {
    this.store = [];
    this.start = 0;
    this.totalBytes = 0;
    this.droppedLines = 0;
    this.pending.stdout = '';
    this.pending.stderr = '';
  }

  private append(raw: string, stream: LogStream): void {
    const text = finishLine(raw);
    const bytes = utf8Length(text);
    this.seq++;
    this.store.push({ seq: this.seq, text, level: detectLevel(text), stream, bytes });
    this.totalBytes += bytes;
    while (this.size > 1 && (this.size > this.maxLines || this.totalBytes > this.maxBytes)) {
      const oldest = this.store[this.start]!;
      this.totalBytes -= oldest.bytes;
      this.start++;
      this.droppedLines++;
    }
    // Compact once the dead prefix is as large as the live window.
    if (this.start > 0 && this.start >= this.size) {
      this.store = this.store.slice(this.start);
      this.start = 0;
    }
  }
}
