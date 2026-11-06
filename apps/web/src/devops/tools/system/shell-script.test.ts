import { describe, expect, it } from 'vitest';
import { contentLines, firstLine, shScript, splitSections } from './shell-script.js';

describe('shScript', () => {
  it('quotes the script and every argument', () => {
    expect(shScript('echo "$1"')).toBe(`sh -c 'echo "$1"'`);
    expect(shScript(`printf '%s' "$1"`, ["it's", '-n'])).toBe(`sh -c 'printf '\\''%s'\\'' "$1"' sh 'it'\\''s' '-n'`);
  });

  it('refuses scripts that a fish or csh login shell would alter', () => {
    expect(() => shScript('echo a\\\\b')).toThrow(/one line/);
    expect(() => shScript("echo a\\'b")).toThrow(/one line/);
    expect(() => shScript('echo a\necho b')).toThrow(/one line/);
    // `\n` inside printf's format is two characters, not a newline, and passes.
    expect(() => shScript('printf "%s\\n" "$1"')).not.toThrow();
  });
});

describe('splitSections', () => {
  it('splits marker lines into tagged sections and keeps the preamble', () => {
    const { preamble, sections } = splitSections('noise\n@@WEBSSH:uid 1000\n@@WEBSSH:ss\nNetid State\ntcp LISTEN\n@@WEBSSH:file /etc/a b.conf \n|x\n');
    expect(preamble).toEqual(['noise']);
    expect(sections).toEqual([
      { tag: 'uid', arg: '1000', lines: [] },
      { tag: 'ss', arg: '', lines: ['Netid State', 'tcp LISTEN'] },
      { tag: 'file', arg: '/etc/a b.conf', lines: ['|x', ''] }
    ]);
  });

  it('keeps only prefixed content lines, so file text cannot forge a marker', () => {
    const { sections } = splitSections('@@WEBSSH:file /etc/x\n|@@WEBSSH:file /etc/shadow\n|line\nsed: read error\n');
    expect(sections).toHaveLength(1);
    expect(contentLines(sections[0]!.lines)).toEqual(['@@WEBSSH:file /etc/shadow', 'line']);
  });
});

describe('firstLine', () => {
  it('returns the first non-blank trimmed line', () => {
    expect(firstLine('\n  \n  cat: x: Permission denied  \nmore')).toBe('cat: x: Permission denied');
    expect(firstLine('')).toBe('');
  });
});
