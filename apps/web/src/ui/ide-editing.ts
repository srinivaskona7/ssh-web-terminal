/**
 * Pure helpers for the in-app light IDE. Kept separate so the path and
 * conflict rules can be tested without a browser or a transport.
 */

export function joinPath(base: string, name: string): string {
  if (name.startsWith('/')) return name;
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.length === 0 ? `/${name}` : `${trimmed}/${name}`;
}

export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  // A bare relative name ("app.ts") lives in the current folder, which the
  // editor denotes as ".". Returning "/" here would retarget renames at the
  // filesystem root.
  if (trimmed === '') return path.startsWith('/') ? '/' : '.';
  if (trimmed === '.') return '.';
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return trimmed.slice(0, idx);
}

/** Line ending used by a file; the editor keeps buffers in LF. */
export function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Rewrite a buffer to the requested line ending. */
export function normalizeEol(text: string, eol: '\r\n' | '\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || '/';
}

/** A NUL byte is the practical signal that a file is not editable text. */
export function isProbablyBinary(content: string): boolean {
  return content.includes('\u0000');
}

/** True when the file on the server is no longer what the buffer opened. */
export function hasRemoteConflict(originalContent: string, remoteContent: string): boolean {
  return originalContent !== remoteContent;
}

export function sortEntries<T extends { name: string; isDir: boolean }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export interface LineColumn {
  line: number;
  column: number;
}

/** 1-based line and column for a caret offset. */
export function lineColumnAt(text: string, offset: number): LineColumn {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, clamped);
  const line = before.split('\n').length;
  const lastBreak = before.lastIndexOf('\n');
  return { line, column: clamped - lastBreak };
}

/** Offset of the first character of a 1-based line, clamped to the text. */
export function lineStartOffset(text: string, line: number): number {
  if (line <= 1) return 0;
  let seen = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      seen++;
      if (seen === line) return i + 1;
    }
  }
  return text.length;
}

/** All match offsets for a literal query, honouring case sensitivity. */
export function findMatches(text: string, query: string, caseSensitive = false): number[] {
  if (!query) return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const offsets: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    offsets.push(i);
  }
  return offsets;
}

export function replaceFirst(
  text: string,
  query: string,
  replacement: string,
  caseSensitive = false
): string {
  if (!query) return text;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const at = haystack.indexOf(needle);
  return at === -1 ? text : text.slice(0, at) + replacement + text.slice(at + query.length);
}

export function replaceAll(
  text: string,
  query: string,
  replacement: string,
  caseSensitive = false
): string {
  if (!query) return text;
  const flags = caseSensitive ? 'g' : 'gi';
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A string replacement still expands `$&`, `$1`, `$$`. Escape `$` so the
  // text the user typed is inserted literally.
  const literal = replacement.replace(/\$/g, '$$$$');
  return text.replace(new RegExp(escaped, flags), literal);
}

function lineBounds(text: string, offset: number): { start: number; end: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const start = text.lastIndexOf('\n', clamped - 1) + 1;
  const nextBreak = text.indexOf('\n', clamped);
  const end = nextBreak === -1 ? text.length : nextBreak;
  return { start, end };
}

/** Duplicate the line containing the caret; returns the new text and caret. */
export function duplicateLine(text: string, offset: number): { text: string; offset: number } {
  const { start, end } = lineBounds(text, offset);
  const line = text.slice(start, end);
  const atEnd = end >= text.length;
  const insertAt = atEnd ? end : end + 1;
  const insert = atEnd ? `\n${line}` : `${line}\n`;
  const nextText = text.slice(0, insertAt) + insert + text.slice(insertAt);
  return { text: nextText, offset: offset + insert.length };
}

/** Move the current line up or down; returns the new text and caret. */
export function moveLine(
  text: string,
  offset: number,
  direction: -1 | 1
): { text: string; offset: number } {
  const lines = text.split('\n');
  const { line } = lineColumnAt(text, offset);
  const index = line - 1;
  const target = index + direction;
  if (target < 0 || target >= lines.length) return { text, offset };
  const column = offset - lineStartOffset(text, line);
  const current = lines[index] ?? '';
  lines[index] = lines[target] ?? '';
  lines[target] = current;
  const nextText = lines.join('\n');
  const nextOffset = lineStartOffset(nextText, target + 1) + column;
  return { text: nextText, offset: nextOffset };
}

/** Line-comment prefix for an extension, or null when we do not know one. */
export function commentPrefixFor(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'go', 'java', 'rs', 'c', 'h', 'css'].includes(ext)) {
    return '//';
  }
  if (['py', 'sh', 'bash', 'zsh', 'rb', 'toml', 'yml', 'yaml', 'conf', 'ini'].includes(ext)) {
    return '#';
  }
  if (['sql'].includes(ext)) return '--';
  if (['lua'].includes(ext)) return '--';
  if (['html', 'xml', 'md'].includes(ext)) return null;
  return null;
}

/** Toggle the comment prefix on the line containing the caret. */
export function toggleLineComment(
  text: string,
  offset: number,
  prefix: string
): { text: string; offset: number } {
  const { start, end } = lineBounds(text, offset);
  const line = text.slice(start, end);
  const indent = line.length - line.trimStart().length;
  const body = line.slice(indent);
  const commented = body.startsWith(`${prefix} `) || body === prefix;
  const nextBody = commented
    ? body.slice(body.startsWith(`${prefix} `) ? prefix.length + 1 : prefix.length)
    : `${prefix} ${body}`;
  const nextLine = line.slice(0, indent) + nextBody;
  return {
    text: text.slice(0, start) + nextLine + text.slice(end),
    offset: start + indent + nextBody.length
  };
}

export function indentSelection(
  text: string,
  start: number,
  end: number,
  unit: string,
  outdent = false
): { text: string; start: number; end: number } {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(text.length, Math.max(start, end));
  const blockStart = text.lastIndexOf('\n', from - 1) + 1;
  const blockEnd = text.indexOf('\n', to);
  const block = text.slice(blockStart, blockEnd === -1 ? text.length : blockEnd);
  const lines = block.split('\n');
  let deltaStart = 0;
  let delta = 0;
  const next = lines.map((line, i) => {
    if (outdent) {
      if (line.startsWith(unit)) {
        delta -= unit.length;
        if (i === 0) deltaStart = -unit.length;
        return line.slice(unit.length);
      }
      if (line.startsWith('\t')) {
        delta -= 1;
        if (i === 0) deltaStart = -1;
        return line.slice(1);
      }
      return line;
    }
    delta += unit.length;
    if (i === 0) deltaStart = unit.length;
    return unit + line;
  });
  const nextText =
    text.slice(0, blockStart) + next.join('\n') + text.slice(blockEnd === -1 ? text.length : blockEnd);
  return {
    text: nextText,
    start: Math.max(0, from + deltaStart),
    end: Math.max(0, to + delta)
  };
}

export function textStats(text: string): { lines: number; words: number; chars: number } {
  const lines = text.length === 0 ? 0 : text.split('\n').length;
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  return { lines, words, chars: text.length };
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Parse `git status --porcelain=v1 -b` into a branch label and dirty count. */
export function parseGitStatus(output: string): { branch: string; changes: number } {
  const lines = output.split('\n').filter((line) => line.trim().length > 0);
  const header = lines.find((line) => line.startsWith('## ')) ?? '';
  const rawBranch = header.replace(/^##\s+/, '').split('...')[0] ?? '';
  const branch = rawBranch.trim() || 'detached';
  const changes = lines.filter((line) => !line.startsWith('## ')).length;
  return { branch, changes };
}

/** Parse `grep -rn` output into path:line:text records, capped. */
export function parseGrepMatches(
  output: string,
  limit = 100
): Array<{ path: string; line: number; text: string }> {
  const out: Array<{ path: string; line: number; text: string }> = [];
  for (const raw of output.split('\n')) {
    if (!raw.trim() || out.length >= limit) continue;
    const first = raw.indexOf(':');
    const second = raw.indexOf(':', first + 1);
    if (first <= 0 || second <= first) continue;
    const lineNumber = Number.parseInt(raw.slice(first + 1, second), 10);
    if (!Number.isFinite(lineNumber)) continue;
    out.push({
      path: raw.slice(0, first),
      line: lineNumber,
      text: raw.slice(second + 1)
    });
  }
  return out;
}

/** One matched line from a unified diff, annotated for rendering. */
export interface DiffLine {
  kind: 'add' | 'del' | 'hunk' | 'context';
  text: string;
}

export function parseDiff(output: string, limit = 400): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const raw of output.split('\n')) {
    if (lines.length >= limit) break;
    if (raw.startsWith('@@')) lines.push({ kind: 'hunk', text: raw });
    else if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    else if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) lines.push({ kind: 'del', text: raw.slice(1) });
    else if (raw.length > 0) lines.push({ kind: 'context', text: raw });
  }
  return lines;
}


/**
 * Indentation to insert when Enter is pressed at `offset`. Returns null when
 * the default newline is already correct (no indentation and no open bracket).
 */
export function newlineIndent(
  text: string,
  offset: number,
  unit: string
): { text: string; offset: number } | null {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const line = text.slice(lineStart, offset);
  const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
  const opensBlock = /[\{\[\(]\s*$/.test(line);
  if (indent.length === 0 && !opensBlock) return null;
  const insert = `\n${indent}${opensBlock ? unit : ''}`;
  return {
    text: text.slice(0, offset) + insert + text.slice(offset),
    offset: offset + insert.length
  };
}
