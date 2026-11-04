import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Badge, Button } from '@webssh/ui-kit';
import type { SftpEntryInfo, WorkspaceRemoteSession } from '../session/adapters';
import { posixQuote } from '../recipes/engine';
import {
  baseName,
  commentPrefixFor,
  duplicateLine,
  findMatches,
  formatBytes,
  hasRemoteConflict,
  indentSelection,
  isProbablyBinary,
  joinPath,
  lineColumnAt,
  lineStartOffset,
  moveLine,
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

interface OpenFile {
  path: string;
  content: string;
  original: string;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  error: string | null;
}

const AUTO_SAVE_DELAY_MS = 1200;
const MAX_OUTPUT_LINES = 400;
const INDENT_UNIT = '  ';
const STORE_KEY = 'webssh.ide.v1';

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
  const [status, setStatus] = useState<string>('');
  const [cursor, setCursor] = useState<{ line: number; column: number }>({ line: 1, column: 1 });
  const [sftpState, setSftpState] = useState<'unknown' | 'ready' | 'unavailable'>('unknown');

  const [findQuery, setFindQuery] = useState<string>('');
  const [replaceValue, setReplaceValue] = useState<string>('');
  const [caseSensitive, setCaseSensitive] = useState<boolean>(false);
  const [matchIndex, setMatchIndex] = useState<number>(0);
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

  const timers = useRef<Map<string, number>>(new Map());
  const savingRef = useRef<Set<string>>(new Set());
  const filesRef = useRef(files);
  filesRef.current = files;
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);
  const pendingGotoLine = useRef<number | null>(null);
  const saveRef = useRef<((path: string, force?: boolean) => Promise<void>) | null>(null);
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

  const save = async (path: string, force = false): Promise<void> => {
    const buffer = filesRef.current.find((f) => f.path === path);
    if (!buffer) return;
    if (!session?.isConnected()) {
      updateFile(path, { saving: false, error: 'Disconnected — change not saved.' });
      setStatus(`Disconnected — ${path} was not saved.`);
      return;
    }
    if (!session.writeFile || !session.readFile) {
      updateFile(path, { saving: false, error: 'SFTP write is unavailable on this connection.' });
      return;
    }
    if (savingRef.current.has(path)) {
      // A save is already in flight for this buffer; re-check shortly.
      armTimer(path, 300);
      return;
    }
    clearTimer(path);
    savingRef.current.add(path);
    updateFile(path, { saving: true, error: null });
    const content = buffer.content;
    try {
      if (!force) {
        const remote = await session.readFile(path);
        if (hasRemoteConflict(buffer.original, remote)) {
          updateFile(path, { saving: false, conflict: true });
          setStatus(`${path} changed on the server — not saved.`);
          return;
        }
      }
      await session.writeFile(path, new TextEncoder().encode(content));
      const latest = filesRef.current.find((f) => f.path === path);
      const unchanged = !latest || latest.content === content;
      updateFile(path, {
        saving: false,
        dirty: unchanged ? false : latest.dirty,
        conflict: false,
        original: content
      });
      setStatus(unchanged ? `Saved ${path}` : `Saved ${path} — newer edits are still pending`);
    } catch (err) {
      updateFile(path, {
        saving: false,
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      savingRef.current.delete(path);
    }
  };
  saveRef.current = save;

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
      if (line) pendingGotoLine.current = line;
      return;
    }
    setBusy(true);
    try {
      const content = await session.readFile(path);
      if (isProbablyBinary(content)) {
        setStatus(`${baseName(path)} looks binary — not opened in the text editor.`);
        return;
      }
      setFiles((prev) => [
        ...prev,
        { path, content, original: content, dirty: false, saving: false, conflict: false, error: null }
      ]);
      setActivePath(path);
      rememberFile(path);
      if (line) pendingGotoLine.current = line;
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

  // Apply a pending caret position after a programmatic edit re-renders.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (pendingGotoLine.current !== null && active) {
      const offset = lineStartOffset(active.content, pendingGotoLine.current);
      editor.focus();
      editor.setSelectionRange(offset, offset);
      setCursor(lineColumnAt(active.content, offset));
      pendingGotoLine.current = null;
      return;
    }
    const pending = pendingSelection.current;
    if (!pending) return;
    pendingSelection.current = null;
    editor.focus();
    editor.setSelectionRange(pending.start, pending.end);
    setCursor(lineColumnAt(active?.content ?? '', pending.start));
  }, [active?.content, active?.path]);

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
    const pos = lineColumnAt(textarea.value, textarea.selectionStart);
    setCursor(pos);
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
    const next = window.prompt('Rename to', baseName(active.path))?.trim();
    if (!next || next === baseName(active.path)) return;
    const target = joinPath(parentPath(active.path), next);
    try {
      await session.renamePath(active.path, target);
      setFiles((prev) =>
        prev.map((f) => (f.path === active.path ? { ...f, path: target, dirty: false } : f))
      );
      setActivePath(target);
      setStatus(`Renamed to ${target}`);
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

  const uploadFile = async (file: File): Promise<void> => {
    if (!session?.writeFile || !canEdit) {
      setStatus('SFTP write is unavailable on this connection.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setStatus('Files over 8 MiB must be uploaded from the Files screen.');
      return;
    }
    const path = joinPath(root, file.name);
    if (entries.some((entry) => entry.name === file.name)) {
      if (!window.confirm(`${path} already exists. Replace it with the uploaded file?`)) return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await session.writeFile(path, bytes);
      setStatus(`Uploaded ${path}`);
      await refresh(root);
    } catch (err) {
      setStatus(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <Badge tone={badgeTone}>{badgeText}</Badge>
          <label htmlFor="ide-auto-save">Auto-save</label>
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
          <Button variant="ghost" onClick={() => setFontSize((s) => Math.max(11, s - 1))} testId="ide-font-dec">
            A-
          </Button>
          <span data-testid="ide-font-size">{fontSize}px</span>
          <Button variant="ghost" onClick={() => setFontSize((s) => Math.min(24, s + 1))} testId="ide-font-inc">
            A+
          </Button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
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
        <p role="status" data-testid="ide-list-error">
          {listError}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        <div style={{ flex: '0 1 300px', minWidth: '220px' }}>
          <h3>{root}</h3>
          <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
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
                  {entry.isSymlink ? ' (link)' : ''}
                  {!entry.isDir && entry.size > 0 ? ` · ${formatBytes(entry.size)}` : ''}
                </button>
              </li>
            ))}
            {entries.length === 0 && !busy ? <li>No entries listed.</li> : null}
            {busy ? <li>Loading…</li> : null}
          </ul>

          <h4 style={{ marginBottom: 'var(--space-1)' }}>Quick open</h4>
          <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
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
        </div>

        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
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
            <div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                <span data-testid="ide-active-path">{active.path}</span>
                <Badge tone={active.conflict ? 'danger' : active.dirty ? 'warning' : 'success'}>
                  {active.conflict ? 'Remote changed' : active.dirty ? 'Unsaved' : 'Saved'}
                </Badge>
                {active.saving ? <span>Saving…</span> : null}
                <Button onClick={() => void save(active.path)} testId="ide-save">
                  Save now
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

              <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center', flexWrap: 'wrap' }}>
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

              <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center', flexWrap: 'wrap' }}>
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

              <textarea
                ref={(el) => {
                  editorRef.current = el;
                }}
                className="ui-input"
                aria-label={`Editing ${active.path}`}
                data-testid="ide-editor"
                value={active.content}
                onInput={(e) => onEdit(active.path, (e.currentTarget as HTMLTextAreaElement).value)}
                onKeyDown={onEditorKeyDown}
                onSelect={trackCursor}
                onClick={trackCursor}
                onKeyUp={trackCursor}
                spellcheck={false}
                style={{
                  width: '100%',
                  minHeight: '320px',
                  fontFamily: 'var(--font-font-mono)',
                  fontSize: `${fontSize}px`,
                  whiteSpace: 'pre',
                  overflow: 'auto'
                }}
              />
              {active.error ? (
                <p role="alert" data-testid="ide-save-error">
                  {active.error}
                </p>
              ) : null}
            </div>
          ) : (
            <p>
              Select a file to edit. Auto-save writes back over SFTP after a short pause; pending
              edits are flushed when you leave this screen.
            </p>
          )}
        </div>
      </div>

      <div style={{ marginTop: 'var(--space-3)' }}>
        <h3>Project search</h3>
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
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
      </div>

      <div style={{ marginTop: 'var(--space-3)' }}>
        <h3>Run a command</h3>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
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
          <div data-testid="ide-presets" style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
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
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
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
      </div>

      <p role="status" data-testid="ide-status">
        {status}
      </p>
    </section>
  );
}
