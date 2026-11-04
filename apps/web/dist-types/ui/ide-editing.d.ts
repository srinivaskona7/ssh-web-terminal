/**
 * Pure helpers for the in-app light IDE. Kept separate so the path and
 * conflict rules can be tested without a browser or a transport.
 */
export declare function joinPath(base: string, name: string): string;
export declare function parentPath(path: string): string;
export declare function baseName(path: string): string;
/** A NUL byte is the practical signal that a file is not editable text. */
export declare function isProbablyBinary(content: string): boolean;
/** True when the file on the server is no longer what the buffer opened. */
export declare function hasRemoteConflict(originalContent: string, remoteContent: string): boolean;
export declare function sortEntries<T extends {
    name: string;
    isDir: boolean;
}>(entries: T[]): T[];
export interface LineColumn {
    line: number;
    column: number;
}
/** 1-based line and column for a caret offset. */
export declare function lineColumnAt(text: string, offset: number): LineColumn;
/** Offset of the first character of a 1-based line, clamped to the text. */
export declare function lineStartOffset(text: string, line: number): number;
/** All match offsets for a literal query, honouring case sensitivity. */
export declare function findMatches(text: string, query: string, caseSensitive?: boolean): number[];
export declare function replaceFirst(text: string, query: string, replacement: string, caseSensitive?: boolean): string;
export declare function replaceAll(text: string, query: string, replacement: string, caseSensitive?: boolean): string;
/** Duplicate the line containing the caret; returns the new text and caret. */
export declare function duplicateLine(text: string, offset: number): {
    text: string;
    offset: number;
};
/** Move the current line up or down; returns the new text and caret. */
export declare function moveLine(text: string, offset: number, direction: -1 | 1): {
    text: string;
    offset: number;
};
/** Line-comment prefix for an extension, or null when we do not know one. */
export declare function commentPrefixFor(path: string): string | null;
/** Toggle the comment prefix on the line containing the caret. */
export declare function toggleLineComment(text: string, offset: number, prefix: string): {
    text: string;
    offset: number;
};
export declare function indentSelection(text: string, start: number, end: number, unit: string, outdent?: boolean): {
    text: string;
    start: number;
    end: number;
};
export declare function textStats(text: string): {
    lines: number;
    words: number;
    chars: number;
};
export declare function formatBytes(size: number): string;
/** Parse `git status --porcelain=v1 -b` into a branch label and dirty count. */
export declare function parseGitStatus(output: string): {
    branch: string;
    changes: number;
};
/** Parse `grep -rn` output into path:line:text records, capped. */
export declare function parseGrepMatches(output: string, limit?: number): Array<{
    path: string;
    line: number;
    text: string;
}>;
/** One matched line from a unified diff, annotated for rendering. */
export interface DiffLine {
    kind: 'add' | 'del' | 'hunk' | 'context';
    text: string;
}
export declare function parseDiff(output: string, limit?: number): DiffLine[];
//# sourceMappingURL=ide-editing.d.ts.map