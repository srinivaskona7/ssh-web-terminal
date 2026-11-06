import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Badge, Button } from '@webssh/ui-kit';
import type { SftpEntryInfo, WorkspaceRemoteSession } from '../session/adapters';
import { posixQuote } from '../recipes/engine';
import {
  baseName,
  commentPrefixFor,
  detectEol,
  duplicateLine,
  findMatches,
  formatBytes,
  hasRemoteConflict,
  indentSelection,
  newlineIndent,
  isProbablyBinary,
  joinPath,
  lineColumnAt,
  lineStartOffset,
  moveLine,
  normalizeEol,
  parentPath,
  parseDiff,
  parseGitStatus,
  parseGrepMatches,
  replaceAll,
  replaceFirst,
  sortEntries,
  textStats,
  toggleLineComment
} from './ide-editing';
import { IDE_STORE_KEY } from './ide-storage';

interface OpenFile {
  path: string;
  content: string;
  original: string;
  /** Line ending the file used on the server; the buffer is always LF. */
  eol: '\r\n' | '\n';
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  error: string | null;
  /** Object URL for a read-only image tab; the text fields are unused for it. */
  preview?: string;
}

const AUTO_SAVE_DELAY_MS = 1200;

/** Image types previewed read-only. SVG is excluded: it is XML that can carry script. */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
};

function imageMimeFor(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME_BY_EXTENSION[ext] ?? null;
}
const MAX_OUTPUT_LINES = 400;
const INDENT_UNIT = '  ';
const STORE_KEY = IDE_STORE_KEY;

/** What came of one save attempt; save-all counts only `saved`. */
type SaveOutcome = 'saved' | 'conflict' | 'failed' | 'busy' | 'missing';

const BRACKET_PARTNER = new Map<string, string>([
  ['(', ')'],
  ['[', ']'],
  ['{', '}']
]);
const BRACKET_OPENER = new Map<string, string>([
  [')', '('],
  [']', '['],
  ['}', '{']
]);

/**
 * The bracket pair the caret is standing next to, preferring the character
 * before it. Nesting is counted, but brackets inside strings or comments are
 * not excluded — this is a hint, not a parser.
 */
function bracketPairAt(text: string, caret: number): { open: number; close: number } | null {
  for (const at of [caret - 1, caret]) {
    const ch = text[at];
    if (ch === undefined) continue;
    const closer = BRACKET_PARTNER.get(ch);
    if (closer) {
      let depth = 0;
      for (let i = at; i < text.length; i += 1) {
        if (text[i] === ch) depth += 1;
        else if (text[i] === closer) {
          depth -= 1;
          if (depth === 0) return { open: at, close: i };
        }
      }
    }
    const opener = BRACKET_OPENER.get(ch);
    if (opener) {
      let depth = 0;
      for (let i = at; i >= 0; i -= 1) {
        if (text[i] === ch) depth += 1;
        else if (text[i] === opener) {
          depth -= 1;
          if (depth === 0) return { open: i, close: at };
        }
      }
    }
  }
  return null;
}

function loadValue<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return (key in parsed ? (parsed[key] as T) : fallback);
  } catch {
    return fallback;
  }
}

function saveValue(key: string, value: unknown): void {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    parsed[key] = value;
    window.localStorage.setItem(STORE_KEY, JSON.stringify(parsed));
  } catch {
    // Storage being unavailable must not break editing.
  }
}

/**
 * A small workspace editor: browse a project over SFTP, edit files in the
 * browser, auto-save them atomically back to the server, and run commands.
 *
 * It is deliberately not a full IDE: no language servers, no debugger, no
 * extension host. The server only sees ordinary SFTP reads/writes and the
 * commands the user types, so nothing needs installing on the host.
 */
export function LightIde({
  session,
  connectedLabel
}: {
  session: WorkspaceRemoteSession | null;
  connectedLabel: string;
}): JSX.Element {
  const [root, setRoot] = useState<string>('.');
  const [projects, setProjects] = useState<string[]>(() => loadValue<string[]>('projects', ['.']));
  const [recentFiles, setRecentFiles] = useState<string[]>(() =>
    loadValue<string[]>('recentFiles', [])
  );
  const [entries, setEntries] = useState<SftpEntryInfo[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [autoSave, setAutoSave] = useState<boolean>(() => loadValue<boolean>('autoSave', true));
  const [fontSize, setFontSize] = useState<number>(() => loadValue<number>('fontSize', 14));
  const [wrap, setWrap] = useState<boolean>(() => loadValue<boolean>('wrap', false));
  const [status, setStatus] = useState<string>('');
  const [cursor, setCursor] = useState<{ line: number; column: number }>({ line: 1, column: 1 });
  const [bracketMatch, setBracketMatch] = useState<{ open: number; close: number } | null>(null);
  const [dragging, setDragging] = useState<boolean>(false);
  const [sftpState, setSftpState] = useState<'unknown' | 'ready' | 'unavailable'>('unknown');
  /** Collapse the file explorer to give the editor more room. */
  const [explorerCollapsed, setExplorerCollapsed] = useState<boolean>(false);
  /** Bottom panel tab: 'output' | 'search' | 'git'. */
  const [bottomPanelTab, setBottomPanelTab] = useState<'output' | 'search' | 'git'>('output');

  const [findQuery, setFindQuery] = useState<string>('');
  const [replaceValue, setReplaceValue] = useState<string>('');
  const [caseSensitive, setCaseSensitive] = useState<boolean>(false);
  const [matchIndex, setMatchIndex] = useState<number>(0);
  const [selectionTick, setSelectionTick] = useState<number>(0);
  const [gotoLine, setGotoLine] = useState<string>('');

  const [command, setCommand] = useState<string>('');
  const [output, setOutput] = useState<string[]>([]);
  const [runInRoot, setRunInRoot] = useState<boolean>(true);
  // Kept in memory on purpose: a command line can carry a token or password,
  // and local storage persists past the session.
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [presets, setPresets] = useState<string[]>(() => loadValue<string[]>('presets', []));

  const [quickOpen, setQuickOpen] = useState<string>('');
  const [quickResults, setQuickResults] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<
    Array<{ path: string; line: number; text: string }>
  >([]);
  const [git, setGit] = useState<{ branch: string; changes: number } | null>(null);
  const [diff, setDiff] = useState<Array<{ kind: string; text: string }>>([]);
  const [saveProgress, setSaveProgress] = useState<{ path: string; percent: number } | null>(null);

  const timers = useRef<Map<string, number>>(new Map());
  const savingRef = useRef<Set<string>>(new Set());
  const saveProgressIntervals = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const filesRef = useRef(files);
  filesRef.current = files;
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const bracketLayerRef = useRef<HTMLDivElement | null>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);
  const pendingGotoLine = useRef<number | null>(null);
  const saveRef = useRef<((path: string, force?: boolean) => Promise<SaveOutcome>) | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);

  const connected = Boolean(session?.isConnected());
  const capabilities = {
    list: typeof session?.listDir === 'function',
    read: typeof session?.readFile === 'function',
    write: typeof session?.writeFile === 'function'
  };
  const canEdit = connected && capabilities.read && capabilities.write;

  const persistHistory = (value: string[]): void => {
    setHistory(value);
  };

  const clearTimer = (path: string): void => {
    const handle = timers.current.get(path);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timers.current.delete(path);
    }
  };

  const armTimer = (path: string, delay = AUTO_SAVE_DELAY_MS): void => {
    clearTimer(path);
    const handle = window.setTimeout(() => {
      timers.current.delete(path);
      void saveRef.current?.(path);
    }, delay);
    timers.current.set(path, handle);
  };

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent): void => {
      if (filesRef.current.some((file) => file.dirty)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // Leaving the screen must not silently drop edits: flush pending buffers.
  useEffect(
    () => () => {
      const pending = Array.from(timers.current.keys());
      for (const handle of timers.current.values()) window.clearTimeout(handle);
      timers.current.clear();
      const paths = new Set([...pending, ...filesRef.current.filter((f) => f.dirty).map((f) => f.path)]);
      for (const path of paths) void saveRef.current?.(path);
    },
    []
  );

  const refresh = async (target = root): Promise<void> => {
    if (!session?.isConnected()) {
      setListError('Disconnected — reconnect before listing files.');
      return;
    }
    if (!session.listDir) {
      setListError('SFTP is unavailable on this connection, so files cannot be listed.');
      return;
    }
    setBusy(true);
    setListError(null);
    try {
      const listed = await session.listDir(target);
      setEntries(sortEntries(listed));
      setRoot(target);
      if (!projects.includes(target)) {
        const next = [...projects, target].slice(-12);
        setProjects(next);
        saveValue('projects', next);
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (!session || !session.isConnected()) {
      setSftpState('unavailable');
      setEntries([]);
      return;
    }
    setSftpState(capabilities.list && capabilities.read && capabilities.write ? 'unknown' : 'unavailable');
    if (session.probeSftp) {
      void session.probeSftp().then((ok) => {
        if (!cancelled) setSftpState(ok ? 'ready' : 'unavailable');
      });
    } else if (capabilities.list) {
      setSftpState('ready');
    }
    if (capabilities.list) void refresh('.');
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const rememberFile = (path: string): void => {
    setRecentFiles((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, 20);
      saveValue('recentFiles', next);
      return next;
    });
  };

  const updateFile = (path: string, patch: Partial<OpenFile>): void => {
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, ...patch } : f)));
  };

  // The caret drives both the line/column readout and the bracket highlight.
  const syncCaret = (textarea: HTMLTextAreaElement, content: string): void => {
    const offset = textarea.selectionStart;
    setCursor(lineColumnAt(content, offset));
    setBracketMatch(bracketPairAt(content, offset));
  };

  const save = async (path: string, force = false): Promise<SaveOutcome> => {
    const buffer = filesRef.current.find((f) => f.path === path);
    if (!buffer) return 'missing';
    if (!session?.isConnected()) {
      updateFile(path, { saving: false, error: 'Disconnected — change not saved.' });
      setStatus(`Disconnected — ${path} was not saved.`);
      return 'failed';
    }
    if (!session.writeFile || !session.readFile) {
      updateFile(path, { saving: false, error: 'SFTP write is unavailable on this connection.' });
      return 'failed';
    }
    if (savingRef.current.has(path)) {
      armTimer(path, 300);
      return 'busy';
    }
    clearTimer(path);
    savingRef.current.add(path);
    updateFile(path, { saving: true, error: null });
    const content = buffer.content;
    const contentBytes = new TextEncoder().encode(normalizeEol(content, buffer.eol)).byteLength;
    const isLargeFile = contentBytes > 3 * 1024 * 1024;
    if (isLargeFile) {
      setSaveProgress({ path, percent: 0 });
      const progressInterval = setInterval(() => {
        setSaveProgress((prev) => {
          if (!prev || prev.path !== path) return prev;
          const next = prev.percent + 10;
          if (next >= 90) return prev;
          return { path, percent: next };
        });
      }, 200);
      saveProgressIntervals.current.set(path, progressInterval);
    }
    try {
      if (!force) {
        const remote = await session.readFile(path);
        if (hasRemoteConflict(buffer.original, normalizeEol(remote, '\n'))) {
          updateFile(path, { saving: false, conflict: true });
          setStatus(`${path} changed on the server — resolve the conflict before saving.`);
          return 'conflict';
        }
      }
      await session.writeFile(path, new TextEncoder().encode(normalizeEol(content, buffer.eol)));
      const latest = filesRef.current.find((f) => f.path === path);
      const unchanged = !latest || latest.content === content;
      updateFile(path, {
        saving: false,
        dirty: unchanged ? false : latest.dirty,
        conflict: false,
        error: null,
        original: content
      });
      setStatus(unchanged ? `Saved ${path}` : `Saved ${path} — newer edits are still pending`);
      return 'saved';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateFile(path, {
        saving: false,
        error: message
      });
      setStatus(`Save failed for ${path}: ${message}`);
      return 'failed';
    } finally {
      savingRef.current.delete(path);
      const interval = saveProgressIntervals.current.get(path);
      if (interval) {
        clearInterval(interval);
        saveProgressIntervals.current.delete(path);
      }
      if (saveProgress?.path === path) setSaveProgress(null);
    }
  };
  saveRef.current = save;

  // Save-all reports what actually reached the server: a buffer that hit the
  // read-before-write conflict check is counted as not saved.
  const saveAll = async (): Promise<void> => {
    const pending = filesRef.current.filter((file) => file.dirty);
    if (pending.length === 0) {
      setStatus('Nothing to save — no unsaved changes.');
      return;
    }
    if (!session?.isConnected()) {
      setStatus('Disconnected — no files were saved.');
      return;
    }
    if (!session.writeFile || !session.readFile) {
      setStatus('SFTP write is unavailable on this connection — no files were saved.');
      return;
    }
    const outcomes = await Promise.all(pending.map((file) => save(file.path)));
    const saved = outcomes.filter((outcome) => outcome === 'saved').length;
    setStatus(
      saved === pending.length
        ? `Saved ${saved} file(s).`
        : `Saved ${saved} of ${pending.length} file(s) — the rest were not written.`
    );
  };

  const openFile = async (path: string, line?: number): Promise<void> => {
    if (!session?.isConnected()) {
      setStatus('Disconnected — cannot open files.');
      return;
    }
    if (!session.readFile || !canEdit) {
      setStatus('SFTP is unavailable on this connection — cannot open files.');
      return;
    }
    const existing = filesRef.current.find((f) => f.path === path);
    if (existing) {
      setActivePath(path);
      if (line) {
        pendingGotoLine.current = line;
        setSelectionTick((tick) => tick + 1);
      }
      return;
    }
    const imageMime = imageMimeFor(path);
    if (imageMime && session.readFileBytes) {
      setBusy(true);
      try {
        const bytes = await session.readFileBytes(path);
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: imageMime }));
        setFiles((prev) => [
          ...prev,
          { path, content: '', original: '', eol: '\n', dirty: false, saving: false, conflict: false, error: null, preview: url }
        ]);
        setActivePath(path);
      } catch (err) {
        setStatus(`Could not open ${baseName(path)}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      const raw = await session.readFile(path);
      const eol = detectEol(raw);
      const content = normalizeEol(raw, '\n');
      if (isProbablyBinary(content)) {
        setStatus(`${baseName(path)} looks binary — not opened in the text editor.`);
        return;
      }
      setFiles((prev) => [
        ...prev,
        {
          path,
          content,
          original: content,
          eol,
          dirty: false,
          saving: false,
          conflict: false,
          error: null
        }
      ]);
      setActivePath(path);
      rememberFile(path);
      if (line) {
        pendingGotoLine.current = line;
        setSelectionTick((tick) => tick + 1);
      }
      setStatus(`Opened ${path}`);
    } catch (err) {
      setStatus(`Open failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const closeFile = (path: string): void => {
    const buffer = filesRef.current.find((f) => f.path === path);
    if (buffer?.dirty && !window.confirm(`${baseName(path)} has unsaved changes. Close anyway?`)) {
      return;
    }
    clearTimer(path);
    if (buffer?.preview) URL.revokeObjectURL(buffer.preview);
    setFiles((prev) => prev.filter((f) => f.path !== path));
    if (activePath === path) {
      const next = filesRef.current.find((f) => f.path !== path);
      setActivePath(next ? next.path : null);
    }
  };

  const applyEdit = (path: string, nextText: string, start: number, end = start): void => {
    updateFile(path, { content: nextText, dirty: true, error: null });
    pendingSelection.current = { start, end };
    if (autoSave) armTimer(path);
  };

  const onEdit = (path: string, value: string): void => {
    updateFile(path, { content: value, dirty: true, error: null });
    if (autoSave) armTimer(path);
  };

  const active = activePath ? files.find((f) => f.path === activePath) ?? null : null;

  // One DOM node per line: past this many rows the gutter would cost more than
  // it helps (openFile has no size cap, and the editor still works without it).
  const gutterLines = active ? active.content.split('\n').length : 0;
  const showGutter = !wrap && gutterLines > 0 && gutterLines <= 5000;

  // A diff belongs to one file; switching tabs must not leave the old one on
  // screen looking like it describes the new file.
  useEffect(() => {
    setDiff([]);
  }, [activePath]);

  // The gutter unmounts while wrapping and its offset only follows `scroll`
  // events, so a fresh mount would restart at 1 against mid-file text.
  useEffect(() => {
    const gutter = gutterRef.current;
    const editor = editorRef.current;
    if (gutter && editor) gutter.style.transform = `translateY(${-editor.scrollTop}px)`;
  }, [wrap, activePath, gutterLines]);

  const toggleWrap = (): void => {
    setWrap((prev) => {
      saveValue('wrap', !prev);
      return !prev;
    });
  };

  const changeFontSize = (next: number): void => {
    const clamped = Math.max(11, Math.min(24, next));
    setFontSize(clamped);
    saveValue('fontSize', clamped);
  };

  // Apply a pending caret position after a programmatic edit re-renders.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (pendingGotoLine.current !== null && active) {
      const offset = lineStartOffset(active.content, pendingGotoLine.current);
      editor.focus();
      editor.setSelectionRange(offset, offset);
      setCursor(lineColumnAt(active.content, offset));
      setBracketMatch(bracketPairAt(active.content, offset));
      pendingGotoLine.current = null;
      return;
    }
    const pending = pendingSelection.current;
    if (!pending) return;
    pendingSelection.current = null;
    editor.focus();
    editor.setSelectionRange(pending.start, pending.end);
    setCursor(lineColumnAt(active?.content ?? '', pending.start));
    setBracketMatch(bracketPairAt(active?.content ?? '', pending.start));
  }, [active?.content, active?.path, selectionTick]);

  const matches = active ? findMatches(active.content, findQuery, caseSensitive) : [];

  const focusMatch = (index: number): void => {
    if (!active || matches.length === 0) return;
    const bounded = ((index % matches.length) + matches.length) % matches.length;
    setMatchIndex(bounded);
    const at = matches[bounded] ?? 0;
    const editor = editorRef.current;
    if (editor) {
      editor.focus();
      editor.setSelectionRange(at, at + findQuery.length);
    }
    setCursor(lineColumnAt(active.content, at));
    setStatus(`Match ${bounded + 1} of ${matches.length}`);
  };

  const doReplace = (all: boolean): void => {
    if (!active) return;
    const next = all
      ? replaceAll(active.content, findQuery, replaceValue, caseSensitive)
      : replaceFirst(active.content, findQuery, replaceValue, caseSensitive);
    if (next === active.content) {
      setStatus('Nothing to replace.');
      return;
    }
    applyEdit(active.path, next, next.length);
    setStatus(all ? 'Replaced all matches.' : 'Replaced the first match.');
  };

  const doGotoLine = (): void => {
    if (!active) return;
    const target = Number.parseInt(gotoLine, 10);
    if (!Number.isFinite(target) || target < 1) {
      setStatus('Enter a line number of 1 or greater.');
      return;
    }
    const offset = lineStartOffset(active.content, target);
    const editor = editorRef.current;
    if (editor) {
      editor.focus();
      editor.setSelectionRange(offset, offset);
    }
    setCursor(lineColumnAt(active.content, offset));
  };

  const onEditorKeyDown = (event: KeyboardEvent): void => {
    if (!active) return;
    const textarea = event.currentTarget as HTMLTextAreaElement;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const key = event.key;
    const mod = event.metaKey || event.ctrlKey;

    if (mod && event.altKey && key.toLowerCase() === 's') {
      event.preventDefault();
      void saveAll();
      return;
    }
    if (mod && key.toLowerCase() === 's') {
      event.preventDefault();
      void save(active.path);
      return;
    }
    if (mod && key.toLowerCase() === 'f') {
      event.preventDefault();
      document.querySelector<HTMLInputElement>('[data-testid="ide-find-input"]')?.focus();
      return;
    }
    if (mod && key.toLowerCase() === 'd') {
      event.preventDefault();
      const result = duplicateLine(active.content, start);
      applyEdit(active.path, result.text, result.offset);
      return;
    }
    if (mod && key === '/') {
      event.preventDefault();
      const prefix = commentPrefixFor(active.path);
      if (!prefix) {
        setStatus('No line-comment syntax is known for this file type.');
        return;
      }
      const result = toggleLineComment(active.content, start, prefix);
      applyEdit(active.path, result.text, result.offset);
      return;
    }
    if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault();
      const result = moveLine(active.content, start, key === 'ArrowUp' ? -1 : 1);
      applyEdit(active.path, result.text, result.offset);
      return;
    }
    // Bracket pairs: type the partner along with an opening bracket, and step
    // over a closer that is already in front of the caret. A selection is left
    // to the browser, which replaces it as usual.
    if (start === end && !event.isComposing && !mod && !event.altKey) {
      const closer = BRACKET_PARTNER.get(key);
      if (closer) {
        event.preventDefault();
        if (active.content[start] === closer) {
          textarea.setSelectionRange(start + 1, start + 1);
          syncCaret(textarea, active.content);
          return;
        }
        const next = `${active.content.slice(0, start)}${key}${closer}${active.content.slice(start)}`;
        applyEdit(active.path, next, start + 1);
        return;
      }
      if (BRACKET_OPENER.has(key) && active.content[start] === key) {
        event.preventDefault();
        textarea.setSelectionRange(start + 1, start + 1);
        syncCaret(textarea, active.content);
        return;
      }
    }
    if (
      key === 'Enter' &&
      start === end &&
      !event.isComposing &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      // Carry the current indentation onto the next line and open one extra
      // level after a bracket, so multi-line edits do not need manual spacing.
      const result = newlineIndent(active.content, start, INDENT_UNIT);
      if (result) {
        event.preventDefault();
        applyEdit(active.path, result.text, result.offset);
        return;
      }
    }
    if (key === 'Tab') {
      event.preventDefault();
      const result = indentSelection(
        active.content,
        start,
        end,
        INDENT_UNIT,
        Boolean(event.shiftKey)
      );
      applyEdit(active.path, result.text, result.start, result.end);
    }
  };

  const trackCursor = (event: Event): void => {
    const textarea = event.currentTarget as HTMLTextAreaElement;
    syncCaret(textarea, textarea.value);
  };

  const newFile = async (): Promise<void> => {
    if (!session?.writeFile || !canEdit) {
      setStatus('SFTP write is unavailable on this connection.');
      return;
    }
    const name = window.prompt('New file name', 'untitled.txt')?.trim();
    if (!name) return;
    const path = joinPath(root, name);
    // write_file truncates: creating over an existing entry would wipe it.
    if (entries.some((entry) => entry.name === name)) {
      if (!window.confirm(`${path} already exists. Replace its contents with an empty file?`)) {
        return;
      }
    }
    try {
      await session.writeFile(path, new Uint8Array(0));
      setStatus(`Created ${path}`);
      await refresh(root);
      await openFile(path);
    } catch (err) {
      setStatus(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const newFolder = async (): Promise<void> => {
    if (!session?.makeDir || !canEdit) {
      setStatus('This connection cannot create folders.');
      return;
    }
    const name = window.prompt('New folder name', 'src')?.trim();
    if (!name) return;
    try {
      await session.makeDir(joinPath(root, name));
      setStatus(`Created folder ${joinPath(root, name)}`);
      await refresh(root);
    } catch (err) {
      setStatus(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const renameActive = async (): Promise<void> => {
    if (!active || !session?.renamePath) {
      setStatus('Renaming is unavailable on this connection.');
      return;
    }
    if (active.saving) {
      setStatus('Wait for the current save to finish before renaming.');
      return;
    }
    const next = window.prompt('Rename to', baseName(active.path))?.trim();
    if (!next || next === baseName(active.path)) return;
    const target = joinPath(parentPath(active.path), next);
    const wasDirty = active.dirty;
    try {
      await session.renamePath(active.path, target);
      // The buffer keeps its edits and dirty flag: moving a file must not make
      // unsaved text look saved, or the pending save lands on a path that no
      // longer exists.
      clearTimer(active.path);
      setFiles((prev) =>
        prev.map((f) => (f.path === active.path ? { ...f, path: target } : f))
      );
      setActivePath(target);
      if (wasDirty && autoSave) armTimer(target);
      setStatus(`Renamed to ${target}${wasDirty ? ' — unsaved edits still pending' : ''}`);
      await refresh(root);
    } catch (err) {
      setStatus(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const deleteActive = async (): Promise<void> => {
    if (!active || !session?.removePath || !canEdit) {
      setStatus('Deleting is unavailable on this connection.');
      return;
    }
    if (!window.confirm(`Delete ${active.path} on the server? This cannot be undone.`)) return;
    try {
      await session.removePath(active.path);
      clearTimer(active.path);
      setFiles((prev) => prev.filter((f) => f.path !== active.path));
      setActivePath(null);
      setStatus(`Deleted ${active.path}`);
      await refresh(root);
    } catch (err) {
      setStatus(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const downloadActive = (): void => {
    if (!active) return;
    const blob = new Blob([active.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = baseName(active.path);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus(`Downloaded ${baseName(active.path)}`);
  };

  const uploadFile = async (file: File): Promise<{ ok: boolean; message: string }> => {
    if (!session?.writeFile || !canEdit) {
      const message = 'SFTP write is unavailable on this connection.';
      setStatus(message);
      return { ok: false, message };
    }
    if (file.size > 8 * 1024 * 1024) {
      const message = 'Files over 8 MiB must be uploaded from the Files screen.';
      setStatus(message);
      return { ok: false, message };
    }
    const path = joinPath(root, file.name);
    if (entries.some((entry) => entry.name === file.name)) {
      if (!window.confirm(`${path} already exists. Replace it with the uploaded file?`)) {
        return { ok: false, message: `${path} was not replaced.` };
      }
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await session.writeFile(path, bytes);
      setStatus(`Uploaded ${path}`);
      await refresh(root);
      return { ok: true, message: `Uploaded ${path}` };
    } catch (err) {
      const message = `Upload failed: ${err instanceof Error ? err.message : String(err)}`;
      setStatus(message);
      return { ok: false, message };
    }
  };

  // Dropping onto the file pane uses the same upload path as the picker, so
  // the 8 MiB cap and the overwrite prompt still apply.
  const dropFiles = async (event: DragEvent): Promise<void> => {
    event.preventDefault();
    setDragging(false);
    if (!session?.isConnected() || !canEdit) {
      setStatus('SFTP is unavailable on this connection — the dropped files were not uploaded.');
      return;
    }
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (dropped.length === 0) return;
    const results: Array<{ ok: boolean; message: string }> = [];
    for (const file of dropped) results.push(await uploadFile(file));
    const failed = results.filter((result) => !result.ok);
    setStatus(
      failed.length === 0
        ? `Uploaded ${results.length} file(s) into ${root}`
        : `Uploaded ${results.length - failed.length} of ${results.length} file(s) — ${failed[0]?.message ?? ''}`
    );
  };

  const runExec = async (commandLine: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    if (!session) throw new Error('No session');
    return session.exec(commandLine);
  };

  const quickFind = async (): Promise<void> => {
    if (!session?.isConnected()) {
      setStatus('Disconnected — cannot search files.');
      return;
    }
    const needle = quickOpen.trim();
    if (!needle) return;
    try {
      const result = await runExec(
        `find ${posixQuote(root)} -maxdepth 5 -type f 2>/dev/null | head -n 500`
      );
      const matches = result.stdout
        .split('\n')
        .filter((line) => line.toLowerCase().includes(needle.toLowerCase()))
        .slice(0, 60);
      setQuickResults(matches);
      setStatus(`${matches.length} matching file(s) in ${root}`);
    } catch (err) {
      setStatus(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const searchProject = async (): Promise<void> => {
    if (!session?.isConnected()) {
      setStatus('Disconnected — cannot search the project.');
      return;
    }
    const needle = searchQuery.trim();
    if (!needle) return;
    try {
      const result = await runExec(
        `grep -rn --binary-files=without-match -m1 -- ${posixQuote(needle)} ${posixQuote(root)} 2>/dev/null | head -n 200`
      );
      const parsed = parseGrepMatches(result.stdout, 100);
      setSearchResults(parsed);
      setStatus(`${parsed.length} match(es) for ${needle}`);
    } catch (err) {
      setStatus(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const refreshGit = async (): Promise<void> => {
    if (!session?.isConnected()) {
      setStatus('Disconnected — cannot read git status.');
      return;
    }
    try {
      const result = await runExec(`git -C ${posixQuote(root)} status --porcelain=v1 -b 2>/dev/null`);
      if (!result.stdout.trim()) {
        setGit(null);
        setStatus('No git repository at this folder (or git is not installed).');
        return;
      }
      const parsed = parseGitStatus(result.stdout);
      setGit(parsed);
      setStatus(`git: ${parsed.branch} · ${parsed.changes} change(s)`);
    } catch (err) {
      setStatus(`git status failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const showDiff = async (): Promise<void> => {
    if (!active || !session?.isConnected()) {
      setStatus('Open a file on a live connection to see its diff.');
      return;
    }
    try {
      const result = await runExec(
        `git -C ${posixQuote(root)} diff -- ${posixQuote(active.path)} 2>/dev/null`
      );
      const parsed = parseDiff(result.stdout);
      setDiff(parsed);
      setStatus(parsed.length ? `${parsed.length} diff line(s) for ${active.path}` : 'No git diff for this file.');
    } catch (err) {
      setStatus(`git diff failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runCommand = async (raw?: string): Promise<void> => {
    const cmd = (raw ?? command).trim();
    if (!cmd) return;
    if (!session?.isConnected()) {
      setOutput((prev) => [...prev.slice(-MAX_OUTPUT_LINES), `Disconnected — cannot run: ${cmd}`]);
      return;
    }
    const line = runInRoot && root.trim() && root !== '.' ? `cd ${posixQuote(root)} && ${cmd}` : cmd;
    setOutput((prev) => [...prev.slice(-MAX_OUTPUT_LINES), `$ ${cmd}`]);
    if (raw === undefined) {
      setCommand('');
      const next = [...history.filter((h) => h !== cmd), cmd].slice(-200);
      persistHistory(next);
      setHistoryIndex(-1);
    }
    try {
      const result = await session.exec(line);
      const lines = [result.stdout, result.stderr]
        .filter((part) => part.trim().length > 0)
        .join('\n')
        .split('\n')
        .filter((text) => text.length > 0);
      setOutput((prev) => [...prev, ...lines, `(exit ${result.exitCode})`].slice(-MAX_OUTPUT_LINES));
    } catch (err) {
      setOutput((prev) =>
        [...prev, `Command failed: ${err instanceof Error ? err.message : String(err)}`].slice(
          -MAX_OUTPUT_LINES
        )
      );
    }
  };

  const onCommandKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runCommand();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (history.length === 0) return;
    event.preventDefault();
    const next =
      event.key === 'ArrowUp'
        ? Math.min(historyIndex + 1, history.length - 1)
        : Math.max(historyIndex - 1, -1);
    setHistoryIndex(next);
    setCommand(next === -1 ? '' : history[history.length - 1 - next] ?? '');
  };

  const pinCommand = (): void => {
    const cmd = command.trim();
    if (!cmd || presets.includes(cmd)) return;
    const next = [...presets, cmd].slice(-12);
    setPresets(next);
    saveValue('presets', next);
    setStatus(`Pinned: ${cmd}`);
  };

  const removePreset = (cmd: string): void => {
    const next = presets.filter((p) => p !== cmd);
    setPresets(next);
    saveValue('presets', next);
  };

  const copyOutput = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(output.join('\n'));
      setStatus('Copied command output.');
    } catch {
      setStatus('Clipboard is unavailable in this browser context.');
    }
  };

  const badgeTone = sftpState === 'ready' ? 'success' : sftpState === 'unknown' ? 'warning' : 'danger';
  const badgeText = !connected
    ? 'Not connected'
    : sftpState === 'unknown'
      ? 'Checking SFTP…'
      : sftpState === 'ready'
        ? 'SFTP ready'
        : 'SFTP unavailable';

  return (
    <section className="ws-mod" data-testid="screen-ide">
      <header className="ws-mod-head">
        <div>
          <h2>Workspace editor</h2>
          <p className="ws-mod-muted">
            {connectedLabel || 'Not connected'} · files are read and written over SFTP; nothing is
            installed on the server.
          </p>
        </div>
        <div className="ws-mod-actions">
          <Button variant="ghost" onClick={() => void setExplorerCollapsed(!explorerCollapsed)} testId="ide-collapse-explorer" title={explorerCollapsed ? 'Show file explorer' : 'Collapse file explorer'}>
            {explorerCollapsed ? '▸ Explorer' : '◂ Explorer'}
          </Button>
          <Badge tone={badgeTone}>{badgeText}</Badge>
          <label className="ws-mod-check" htmlFor="ide-auto-save">
            Auto-save
            <input
              id="ide-auto-save"
              type="checkbox"
              checked={autoSave}
              data-testid="ide-auto-save"
              onChange={(e) => {
                const next = (e.currentTarget as HTMLInputElement).checked;
                setAutoSave(next);
                saveValue('autoSave', next);
                if (!next) {
                  for (const handle of timers.current.values()) window.clearTimeout(handle);
                  timers.current.clear();
                }
              }}
            />
          </label>
          <Button variant="ghost" onClick={() => changeFontSize(fontSize - 1)} testId="ide-font-dec">
            A-
          </Button>
          <span data-testid="ide-font-size">{fontSize}px</span>
          <Button variant="ghost" onClick={() => changeFontSize(fontSize + 1)} testId="ide-font-inc">
            A+
          </Button>
          <Button
            variant={wrap ? 'primary' : 'ghost'}
            onClick={toggleWrap}
            ariaPressed={wrap}
            title="Wrap long lines"
            testId="ide-wrap-toggle"
          >
            Wrap
          </Button>
        </div>
      </header>

      <div className="ws-mod-filters">
        <select
          className="ui-input"
          aria-label="Saved projects"
          data-testid="ide-projects"
          value={projects.includes(root) ? root : ''}
          onChange={(e) => void refresh((e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">Recent projects…</option>
          {projects.map((project) => (
            <option key={project} value={project}>
              {project}
            </option>
          ))}
        </select>
        <input
          className="ui-input"
          aria-label="Project folder"
          data-testid="ide-root-input"
          value={root}
          onInput={(e) => setRoot((e.currentTarget as HTMLInputElement).value)}
          style={{ flex: '1 1 240px' }}
        />
        <Button onClick={() => void refresh(root)} testId="ide-open-project">
          Open folder
        </Button>
        <Button variant="ghost" onClick={() => void refresh(parentPath(root))} testId="ide-up">
          Up
        </Button>
        <Button variant="ghost" onClick={() => void refresh('.')} testId="ide-home">
          Home
        </Button>
        <Button
          variant="ghost"
          testId="ide-forget-project"
          onClick={() => {
            const next = projects.filter((p) => p !== root);
            setProjects(next);
            saveValue('projects', next);
            setStatus(`Forgot ${root}`);
          }}
        >
          Forget
        </Button>
      </div>

      {listError ? (
        <p className="ws-mod-error" role="status" data-testid="ide-list-error">
          {listError}
        </p>
      ) : null}

      <div className={`ws-mod-split ide-workspace-split ${explorerCollapsed ? 'ide-explorer-collapsed' : ''}`}>
        {!explorerCollapsed ? (
          <aside
            className={dragging ? 'ws-mod-list ide-drop-active' : 'ws-mod-list'}
            aria-label="Project files"
            data-testid="ide-drop-zone"
            style={{ overflowX: 'hidden' }}
            onDragOver={(event) => {
              event.preventDefault();
              if (!dragging) setDragging(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragging(false);
              }
            }}
            onDrop={(event) => void dropFiles(event)}
          >
            <h3>{root}</h3>
            <div className="ws-mod-actions">
              <Button variant="ghost" onClick={() => void newFile()} testId="ide-new-file">
                New file
              </Button>
              <Button variant="ghost" onClick={() => void newFolder()} testId="ide-new-folder">
                New folder
              </Button>
              <Button variant="ghost" onClick={() => uploadRef.current?.click()} testId="ide-upload">
                Upload
              </Button>
              <input
                ref={(el) => {
                  uploadRef.current = el;
                }}
                type="file"
                aria-label="Upload a file into the open folder"
                data-testid="ide-upload-input"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = (e.currentTarget as HTMLInputElement).files?.[0];
                  if (file) void uploadFile(file);
                  (e.currentTarget as HTMLInputElement).value = '';
                }}
              />
            </div>
            <ul data-testid="ide-file-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="ui-button"
                    data-testid={`ide-entry-${entry.name}`}
                    onClick={() => void (entry.isDir ? refresh(entry.path) : openFile(entry.path))}
                    style={{ width: '100%', textAlign: 'left' }}
                  >
                    {entry.isDir ? '▸ ' : '  '}
                    {entry.name}
                    {!entry.isDir && entry.size > 0 ? ` · ${formatBytes(entry.size)}` : ''}
                  </button>
                </li>
              ))}
              {entries.length === 0 && !busy ? <li>No entries listed.</li> : null}
              {busy ? <li>Loading…</li> : null}
            </ul>

            <h4 style={{ marginBottom: 'var(--space-1)' }}>Quick open</h4>
            <div className="ws-mod-filters">
              <input
                className="ui-input"
                aria-label="Find a file by name"
                data-testid="ide-quick-open"
                value={quickOpen}
                onInput={(e) => setQuickOpen((e.currentTarget as HTMLInputElement).value)}
              />
              <Button variant="ghost" onClick={() => void quickFind()} testId="ide-quick-open-run">
                Find
              </Button>
            </div>
            {quickResults.length > 0 ? (
              <ul data-testid="ide-quick-results" style={{ listStyle: 'none', padding: 0 }}>
                {quickResults.map((path) => (
                  <li key={path}>
                    <button type="button" onClick={() => void openFile(path)}>
                      {path}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {recentFiles.length > 0 ? (
              <>
                <h4 style={{ marginBottom: 'var(--space-1)' }}>Recent files</h4>
                <ul data-testid="ide-recent-files" style={{ listStyle: 'none', padding: 0 }}>
                  {recentFiles.slice(0, 8).map((path) => (
                    <li key={path}>
                      <button type="button" onClick={() => void openFile(path)}>
                        {baseName(path)}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </aside>
        ) : null}

        <section className="ws-mod-content" aria-label="Editor">
          <div role="tablist" aria-label="Open files" data-testid="ide-tabs">
            {files.map((file) => (
              <span key={file.path}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={file.path === activePath}
                  onClick={() => setActivePath(file.path)}
                  data-testid={`ide-tab-${baseName(file.path)}`}
                >
                  {baseName(file.path)}
                  {file.dirty ? ' *' : ''}
                  {file.conflict ? ' ⚠' : ''}
                  {file.error ? ' !' : ''}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${baseName(file.path)}`}
                  onClick={() => closeFile(file.path)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          {active ? (
            <div className="ws-mod-detail">
              <div className="ws-mod-actions">
                <span data-testid="ide-active-path">{active.path}</span>
                <Badge tone={active.conflict ? 'danger' : active.saving ? 'warning' : active.dirty ? 'warning' : 'success'}>
                  {active.conflict ? 'Conflict' : active.saving ? 'Saving…' : active.dirty ? 'Unsaved' : 'Saved'}
                </Badge>
                {active.saving ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                    <span className="ws-mod-muted">Saving to server…</span>
                    {saveProgress?.path === active.path ? (
                      <div className="ide-save-progress">
                        <div
                          className="ide-save-progress-bar"
                          style={{ width: `${saveProgress.percent}%` }}
                        />
                        <span className="ide-save-progress-text">{saveProgress.percent}%</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {active.error ? (
                  <Badge tone="danger" data-testid="ide-save-error-badge">
                    Save error
                  </Badge>
                ) : null}
                <Button onClick={() => void save(active.path)} testId="ide-save">
                  Save now
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void saveAll()}
                  title="Save every buffer with unsaved changes (Ctrl/Cmd+Alt+S)"
                  testId="ide-save-all"
                >
                  Save all
                </Button>
                {active.conflict ? (
                  <Button
                    variant="danger"
                    onClick={() => void save(active.path, true)}
                    testId="ide-overwrite"
                  >
                    Overwrite with my version
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={() => setDiff([])} testId="ide-clear-diff">
                  Clear diff
                </Button>
              </div>

              <div className="ws-mod-filters">
                <input
                  className="ui-input"
                  aria-label="Find in file"
                  data-testid="ide-find-input"
                  placeholder="Find"
                  value={findQuery}
                  onInput={(e) => {
                    setFindQuery((e.currentTarget as HTMLInputElement).value);
                    setMatchIndex(0);
                  }}
                  style={{ flex: '1 1 140px' }}
                />
                <Button variant="ghost" onClick={() => focusMatch(matchIndex + 1)} testId="ide-find-next">
                  Next
                </Button>
                <Button variant="ghost" onClick={() => focusMatch(matchIndex - 1)} testId="ide-find-prev">
                  Prev
                </Button>
                <label htmlFor="ide-case">Aa</label>
                <input
                  id="ide-case"
                  type="checkbox"
                  checked={caseSensitive}
                  data-testid="ide-case-sensitive"
                  onChange={(e) => setCaseSensitive((e.currentTarget as HTMLInputElement).checked)}
                />
                <span data-testid="ide-match-count">
                  {findQuery ? `${matches.length} match(es)` : '—'}
                </span>
                <input
                  className="ui-input"
                  aria-label="Replace with"
                  data-testid="ide-replace-input"
                  placeholder="Replace"
                  value={replaceValue}
                  onInput={(e) => setReplaceValue((e.currentTarget as HTMLInputElement).value)}
                  style={{ flex: '1 1 120px' }}
                />
                <Button variant="ghost" onClick={() => doReplace(false)} testId="ide-replace-one">
                  Replace
                </Button>
                <Button variant="ghost" onClick={() => doReplace(true)} testId="ide-replace-all">
                  Replace all
                </Button>
              </div>

              <div className="ws-mod-filters">
                <input
                  className="ui-input"
                  aria-label="Go to line"
                  data-testid="ide-goto-line"
                  placeholder="Line"
                  value={gotoLine}
                  onInput={(e) => setGotoLine((e.currentTarget as HTMLInputElement).value)}
                  style={{ width: '80px' }}
                />
                <Button variant="ghost" onClick={doGotoLine} testId="ide-goto-line-run">
                  Go
                </Button>
                <Button variant="ghost" onClick={downloadActive} testId="ide-download">
                  Download copy
                </Button>
                <Button variant="ghost" onClick={() => void renameActive()} testId="ide-rename">
                  Rename
                </Button>
                <Button variant="danger" onClick={() => void deleteActive()} testId="ide-delete">
                  Delete
                </Button>
                <span data-testid="ide-cursor">
                  Ln {cursor.line}, Col {cursor.column}
                </span>
                <span data-testid="ide-stats">
                  {textStats(active.content).lines} lines · {textStats(active.content).words} words ·{' '}
                  {textStats(active.content).chars} chars
                </span>
              </div>

              {active.preview ? (
                <div className="ide-image-preview">
                  <img src={active.preview} alt={baseName(active.path)} data-testid="ide-image-preview" />
                </div>
              ) : (
              <div className="ide-editor-shell">
                {showGutter ? (
                <div
                  className="ide-gutter"
                  aria-hidden="true"
                  // Match the editor's font size exactly: the CSS default
                  // (--font-size-sm) made each number row 3.2px shorter than a
                  // code line, so the gutter drifted a line every ~7 rows.
                  style={{ fontSize: `${fontSize}px` }}
                >
                  <div
                    ref={(el) => {
                      gutterRef.current = el;
                    }}
                    className="ide-gutter-lines"
                    data-testid="ide-gutter"
                  >
                    {Array.from({ length: gutterLines }, (_v, i) => (
                      <span key={i}>{i + 1}</span>
                    ))}
                  </div>
                </div>
                ) : null}
                <div className="ide-editor-pane">
                <textarea
                  ref={(el) => {
                    editorRef.current = el;
                  }}
                  className="ui-input ide-editor"
                  aria-label={`Editing ${active.path}`}
                  data-testid="ide-editor"
                  value={active.content}
                  onInput={(e) => onEdit(active.path, (e.currentTarget as HTMLTextAreaElement).value)}
                  onKeyDown={onEditorKeyDown}
                  onSelect={trackCursor}
                  onClick={trackCursor}
                  onKeyUp={trackCursor}
                  onScroll={(e) => {
                    const el = e.currentTarget as HTMLTextAreaElement;
                    if (gutterRef.current) {
                      gutterRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
                    }
                    if (bracketLayerRef.current) {
                      bracketLayerRef.current.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
                    }
                  }}
                  spellcheck={false}
                  data-wrap={wrap ? 'on' : 'off'}
                  style={{
                    width: '100%',
                    fontFamily: 'var(--font-font-mono)',
                    fontSize: `${fontSize}px`,
                    lineHeight: 'var(--font-line-height-editor)',
                    whiteSpace: wrap ? 'pre-wrap' : 'pre',
                    overflowWrap: wrap ? 'anywhere' : 'normal',
                    overflow: 'auto'
                  }}
                />
                {/* One monospace cell per bracket, positioned in ch/em so no
                    measurement is needed. Withdrawn while wrapping, where a
                    logical offset no longer maps to a fixed column. */}
                {!wrap && bracketMatch ? (
                  <div
                    ref={(el) => {
                      bracketLayerRef.current = el;
                      // A fresh mount must start where the editor is scrolled
                      // to, not at the top-left of the file.
                      const editor = editorRef.current;
                      if (el && editor) {
                        el.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
                      }
                    }}
                    className="ide-bracket-layer"
                    aria-hidden="true"
                    data-testid="ide-bracket-layer"
                    style={{ fontSize: `${fontSize}px` }}
                  >
                    {[bracketMatch.open, bracketMatch.close].map((offset) => {
                      const at = lineColumnAt(active.content, offset);
                      return (
                        <span
                          key={offset}
                          className="ide-bracket-marker"
                          data-testid="ide-bracket-marker"
                          data-offset={offset}
                          style={{
                            left: `${at.column - 1}ch`,
                            top: `calc(${at.line - 1} * var(--font-line-height-editor) * 1em)`
                          }}
                        >
                          {active.content[offset]}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
                </div>
              </div>
              )}
              {active.error ? (
                <div className="ws-mod-error" role="alert" data-testid="ide-save-error-banner">
                  Save failed for {active.path}: {active.error}
                </div>
              ) : null}
              {active.conflict ? (
                <>
                  <div className="ws-mod-error" role="alert" data-testid="ide-conflict-banner">
                    {active.path} changed on the server since you opened it.
                  </div>
                  <div className="ws-mod-actions" style={{ marginTop: 'var(--space-2)' }}>
                  <Button
                    variant="default"
                    onClick={() => {
                      // Re-read the remote file and replace the local buffer with it.
                      void session?.readFile?.(active.path).then((remote) => {
                        updateFile(active.path, {
                          content: normalizeEol(remote, '\n'),
                          original: normalizeEol(remote, '\n'),
                          dirty: false,
                          conflict: false,
                          error: null
                        });
                        setStatus(`Reverted to server version of ${active.path}.`);
                      });
                    }}
                    testId="ide-preserve-local"
                  >
                    Keep server version (discard my edits)
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => void save(active.path, true)}
                    testId="ide-overwrite"
                  >
                    Overwrite with my version
                  </Button>
                </div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="ws-mod-detail">
              <p className="ws-mod-muted">
                Select a file to edit. Auto-save writes back over SFTP after a short pause; pending
                edits are flushed when you leave this screen.
              </p>
            </div>
          )}
        </section>
      </div>

      <div className="ws-mod-split ide-secondary-split">
        <div className="ide-bottom-panel-tabs">
          <button
            type="button"
            className={`ide-bottom-panel-tab ${bottomPanelTab === 'output' ? 'ide-bottom-panel-tab--active' : ''}`}
            onClick={() => setBottomPanelTab('output')}
            data-testid="ide-bottom-tab-output"
          >
            Output
          </button>
          <button
            type="button"
            className={`ide-bottom-panel-tab ${bottomPanelTab === 'search' ? 'ide-bottom-panel-tab--active' : ''}`}
            onClick={() => setBottomPanelTab('search')}
            data-testid="ide-bottom-tab-search"
          >
            Search
          </button>
          <button
            type="button"
            className={`ide-bottom-panel-tab ${bottomPanelTab === 'git' ? 'ide-bottom-panel-tab--active' : ''}`}
            onClick={() => setBottomPanelTab('git')}
            data-testid="ide-bottom-tab-git"
          >
            Git
          </button>
        </div>
        <div className="ide-bottom-panel-content">
          {bottomPanelTab === 'output' ? (
            <>
              <div className="ws-mod-filters">
                <input
                  className="ui-input"
                  aria-label="Command"
                  data-testid="ide-command-input"
                  value={command}
                  onInput={(e) => setCommand((e.currentTarget as HTMLInputElement).value)}
                  onKeyDown={onCommandKeyDown}
                  style={{ flex: 1 }}
                />
                <Button onClick={() => void runCommand()} testId="ide-run-command">
                  Run
                </Button>
                <Button variant="ghost" onClick={pinCommand} testId="ide-pin-command">
                  Pin
                </Button>
              </div>
              <label htmlFor="ide-run-in-root">
                Run inside {root}
                <input
                  id="ide-run-in-root"
                  type="checkbox"
                  checked={runInRoot}
                  data-testid="ide-run-in-root"
                  onChange={(e) => setRunInRoot((e.currentTarget as HTMLInputElement).checked)}
                />
              </label>
              {presets.length > 0 ? (
                <div data-testid="ide-presets" className="ws-mod-chips">
                  {presets.map((preset) => (
                    <span key={preset}>
                      <button type="button" onClick={() => void runCommand(preset)}>
                        {preset}
                      </button>
                      <button type="button" aria-label={`Remove ${preset}`} onClick={() => removePreset(preset)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="ws-mod-actions">
                <Button variant="ghost" onClick={() => void copyOutput()} testId="ide-copy-output">
                  Copy output
                </Button>
                <Button variant="ghost" onClick={() => setOutput([])} testId="ide-clear-output">
                  Clear
                </Button>
                <Button variant="ghost" onClick={() => void refreshGit()} testId="ide-git-refresh">
                  Refresh git
                </Button>
                <Button variant="ghost" onClick={() => void showDiff()} testId="ide-git-diff">
                  Diff this file
                </Button>
                <span data-testid="ide-git-status">
                  {git ? `${git.branch} · ${git.changes} change(s)` : 'git: not checked'}
                </span>
              </div>
              <pre
                data-testid="ide-command-output"
                aria-live="polite"
                style={{ maxHeight: '220px', overflow: 'auto', whiteSpace: 'pre-wrap' }}
              >
                {output.join('\n')}
              </pre>
              {diff.length > 0 ? (
                <pre data-testid="ide-diff" style={{ maxHeight: '220px', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                  {diff
                    .map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`)
                    .join('\n')}
                </pre>
              ) : null}
            </>
          ) : bottomPanelTab === 'search' ? (
            <>
              <div className="ws-mod-filters">
                <input
                  className="ui-input"
                  aria-label="Search project text"
                  data-testid="ide-search-query"
                  value={searchQuery}
                  onInput={(e) => setSearchQuery((e.currentTarget as HTMLInputElement).value)}
                  style={{ flex: 1 }}
                />
                <Button variant="ghost" onClick={() => void searchProject()} testId="ide-search-run">
                  Search
                </Button>
              </div>
              {searchResults.length > 0 ? (
                <ul data-testid="ide-search-results" style={{ listStyle: 'none', padding: 0 }}>
                  {searchResults.map((hit) => (
                    <li key={`${hit.path}:${hit.line}`}>
                      <button type="button" onClick={() => void openFile(hit.path, hit.line)}>
                        {hit.path}:{hit.line} — {hit.text.slice(0, 120)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <>
              <div className="ws-mod-actions">
                <Button variant="ghost" onClick={() => void refreshGit()} testId="ide-git-refresh">
                  Refresh git
                </Button>
                <Button variant="ghost" onClick={() => void showDiff()} testId="ide-git-diff">
                  Diff this file
                </Button>
                <span data-testid="ide-git-status">
                  {git ? `${git.branch} · ${git.changes} change(s)` : 'git: not checked'}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      <p role="status" data-testid="ide-status" className="ws-mod-muted">
        {status}
      </p>
    </section>
  );
}
