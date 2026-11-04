import { describe, expect, it } from 'vitest';
import { baseName, commentPrefixFor, duplicateLine, findMatches, formatBytes, hasRemoteConflict, indentSelection, isProbablyBinary, joinPath, lineColumnAt, lineStartOffset, moveLine, parentPath, parseDiff, parseGitStatus, parseGrepMatches, replaceAll, replaceFirst, sortEntries, textStats, toggleLineComment } from './ide-editing';
describe('ide-editing helpers', () => {
    it('joins paths without doubling separators', () => {
        expect(joinPath('.', 'src')).toBe('./src');
        expect(joinPath('/home/ubuntu/', 'app.ts')).toBe('/home/ubuntu/app.ts');
        expect(joinPath('', 'x')).toBe('/x');
        expect(joinPath('/home', '/etc/hosts')).toBe('/etc/hosts');
    });
    it('finds the parent path, stopping at root', () => {
        expect(parentPath('/home/ubuntu/app')).toBe('/home/ubuntu');
        expect(parentPath('/home/')).toBe('/');
        expect(parentPath('single')).toBe('/');
    });
    it('extracts a base name', () => {
        expect(baseName('/home/ubuntu/app.ts')).toBe('app.ts');
        expect(baseName('/')).toBe('/');
    });
    it('treats NUL bytes as binary', () => {
        expect(isProbablyBinary('plain text\n')).toBe(false);
        expect(isProbablyBinary('a\u0000b')).toBe(true);
    });
    it('reports a conflict only when the remote differs from the opened copy', () => {
        expect(hasRemoteConflict('a', 'a')).toBe(false);
        expect(hasRemoteConflict('a', 'b')).toBe(true);
    });
    it('sorts directories first, then by name', () => {
        const sorted = sortEntries([
            { name: 'z.txt', isDir: false },
            { name: 'src', isDir: true },
            { name: 'a.txt', isDir: false }
        ]);
        expect(sorted.map((e) => e.name)).toEqual(['src', 'a.txt', 'z.txt']);
    });
    it('maps offsets to line and column and back', () => {
        const text = 'one\ntwo\nthree';
        expect(lineColumnAt(text, 0)).toEqual({ line: 1, column: 1 });
        expect(lineColumnAt(text, 5)).toEqual({ line: 2, column: 2 });
        expect(lineColumnAt(text, text.length)).toEqual({ line: 3, column: 6 });
        expect(lineStartOffset(text, 1)).toBe(0);
        expect(lineStartOffset(text, 2)).toBe(4);
        expect(lineStartOffset(text, 99)).toBe(text.length);
    });
    it('finds and replaces literal matches with case control', () => {
        const text = 'Foo foo FOO';
        expect(findMatches(text, 'foo')).toEqual([0, 4, 8]);
        expect(findMatches(text, 'foo', true)).toEqual([4]);
        expect(replaceFirst(text, 'foo', 'bar')).toBe('bar foo FOO');
        expect(replaceAll(text, 'foo', 'bar')).toBe('bar bar bar');
        expect(replaceAll(text, 'foo', 'bar', true)).toBe('Foo bar FOO');
        expect(replaceAll('a.b', '.', '-')).toBe('a-b');
        // A replacement is literal text, not a replacement pattern.
        expect(replaceAll('price', 'price', '$& $1 $$')).toBe('$& $1 $$');
    });
    it('duplicates and moves the current line', () => {
        const dup = duplicateLine('a\nb\nc', 3);
        expect(dup.text).toBe('a\nb\nb\nc');
        expect(lineColumnAt(dup.text, dup.offset).line).toBe(3);
        const up = moveLine('a\nb\nc', 2, -1);
        expect(up.text).toBe('b\na\nc');
        const down = moveLine('a\nb\nc', 0, 1);
        expect(down.text).toBe('b\na\nc');
        expect(moveLine('a', 0, -1).text).toBe('a');
    });
    it('toggles a line comment and picks a prefix by extension', () => {
        expect(toggleLineComment('  let a = 1;', 5, '//').text).toBe('  // let a = 1;');
        expect(toggleLineComment('  // let a = 1;', 8, '//').text).toBe('  let a = 1;');
        expect(commentPrefixFor('main.go')).toBe('//');
        expect(commentPrefixFor('run.sh')).toBe('#');
        expect(commentPrefixFor('README.md')).toBeNull();
    });
    it('indents and outdents a selection', () => {
        const indented = indentSelection('a\nb', 0, 3, '  ');
        expect(indented.text).toBe('  a\n  b');
        expect(indented.end).toBe(7);
        const outdented = indentSelection(indented.text, 2, 7, '  ', true);
        expect(outdented.text).toBe('a\nb');
    });
    it('counts text and formats file sizes', () => {
        expect(textStats('')).toEqual({ lines: 0, words: 0, chars: 0 });
        expect(textStats('a b\nc')).toEqual({ lines: 2, words: 3, chars: 5 });
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(999)).toBe('999 B');
        expect(formatBytes(2048)).toBe('2.0 KB');
    });
    it('parses git status, grep hits and diffs', () => {
        expect(parseGitStatus('## main...origin/main\n M a.ts\n?? b.ts\n')).toEqual({
            branch: 'main',
            changes: 2
        });
        expect(parseGitStatus('')).toEqual({ branch: 'detached', changes: 0 });
        const hits = parseGrepMatches('src/a.ts:12:hello\nnot-a-hit\nsrc/b.ts:3:world\n');
        expect(hits).toEqual([
            { path: 'src/a.ts', line: 12, text: 'hello' },
            { path: 'src/b.ts', line: 3, text: 'world' }
        ]);
        const diff = parseDiff('@@ -1 +1 @@\n-old\n+new\n context');
        expect(diff).toEqual([
            { kind: 'hunk', text: '@@ -1 +1 @@' },
            { kind: 'del', text: 'old' },
            { kind: 'add', text: 'new' },
            { kind: 'context', text: ' context' }
        ]);
    });
});
//# sourceMappingURL=ide-editing.test.js.map