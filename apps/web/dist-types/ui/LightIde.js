import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "preact/jsx-runtime";
import { useEffect, useRef, useState } from 'preact/hooks';
import { Badge, Button } from '@webssh/ui-kit';
import { posixQuote } from '../recipes/engine';
import { baseName, commentPrefixFor, detectEol, duplicateLine, findMatches, formatBytes, hasRemoteConflict, indentSelection, newlineIndent, isProbablyBinary, joinPath, lineColumnAt, lineStartOffset, moveLine, normalizeEol, parentPath, parseDiff, parseGitStatus, parseGrepMatches, replaceAll, replaceFirst, sortEntries, textStats, toggleLineComment } from './ide-editing';
const AUTO_SAVE_DELAY_MS = 1200;
const MAX_OUTPUT_LINES = 400;
const INDENT_UNIT = '  ';
const STORE_KEY = 'webssh.ide.v1';
function loadValue(key, fallback) {
    try {
        const raw = window.localStorage.getItem(STORE_KEY);
        if (!raw)
            return fallback;
        const parsed = JSON.parse(raw);
        return (key in parsed ? parsed[key] : fallback);
    }
    catch {
        return fallback;
    }
}
function saveValue(key, value) {
    try {
        const raw = window.localStorage.getItem(STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        parsed[key] = value;
        window.localStorage.setItem(STORE_KEY, JSON.stringify(parsed));
    }
    catch {
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
export function LightIde({ session, connectedLabel }) {
    const [root, setRoot] = useState('.');
    const [projects, setProjects] = useState(() => loadValue('projects', ['.']));
    const [recentFiles, setRecentFiles] = useState(() => loadValue('recentFiles', []));
    const [entries, setEntries] = useState([]);
    const [listError, setListError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [files, setFiles] = useState([]);
    const [activePath, setActivePath] = useState(null);
    const [autoSave, setAutoSave] = useState(() => loadValue('autoSave', true));
    const [fontSize, setFontSize] = useState(() => loadValue('fontSize', 14));
    const [status, setStatus] = useState('');
    const [cursor, setCursor] = useState({ line: 1, column: 1 });
    const [sftpState, setSftpState] = useState('unknown');
    const [findQuery, setFindQuery] = useState('');
    const [replaceValue, setReplaceValue] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [matchIndex, setMatchIndex] = useState(0);
    const [selectionTick, setSelectionTick] = useState(0);
    const [gotoLine, setGotoLine] = useState('');
    const [command, setCommand] = useState('');
    const [output, setOutput] = useState([]);
    const [runInRoot, setRunInRoot] = useState(true);
    // Kept in memory on purpose: a command line can carry a token or password,
    // and local storage persists past the session.
    const [history, setHistory] = useState([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [presets, setPresets] = useState(() => loadValue('presets', []));
    const [quickOpen, setQuickOpen] = useState('');
    const [quickResults, setQuickResults] = useState([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [git, setGit] = useState(null);
    const [diff, setDiff] = useState([]);
    const timers = useRef(new Map());
    const savingRef = useRef(new Set());
    const filesRef = useRef(files);
    filesRef.current = files;
    const editorRef = useRef(null);
    const pendingSelection = useRef(null);
    const pendingGotoLine = useRef(null);
    const saveRef = useRef(null);
    const uploadRef = useRef(null);
    const connected = Boolean(session?.isConnected());
    const capabilities = {
        list: typeof session?.listDir === 'function',
        read: typeof session?.readFile === 'function',
        write: typeof session?.writeFile === 'function'
    };
    const canEdit = connected && capabilities.read && capabilities.write;
    const persistHistory = (value) => {
        setHistory(value);
    };
    const clearTimer = (path) => {
        const handle = timers.current.get(path);
        if (handle !== undefined) {
            window.clearTimeout(handle);
            timers.current.delete(path);
        }
    };
    const armTimer = (path, delay = AUTO_SAVE_DELAY_MS) => {
        clearTimer(path);
        const handle = window.setTimeout(() => {
            timers.current.delete(path);
            void saveRef.current?.(path);
        }, delay);
        timers.current.set(path, handle);
    };
    useEffect(() => {
        const handler = (event) => {
            if (filesRef.current.some((file) => file.dirty)) {
                event.preventDefault();
                event.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);
    // Leaving the screen must not silently drop edits: flush pending buffers.
    useEffect(() => () => {
        const pending = Array.from(timers.current.keys());
        for (const handle of timers.current.values())
            window.clearTimeout(handle);
        timers.current.clear();
        const paths = new Set([...pending, ...filesRef.current.filter((f) => f.dirty).map((f) => f.path)]);
        for (const path of paths)
            void saveRef.current?.(path);
    }, []);
    const refresh = async (target = root) => {
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
        }
        catch (err) {
            setListError(err instanceof Error ? err.message : String(err));
            setEntries([]);
        }
        finally {
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
                if (!cancelled)
                    setSftpState(ok ? 'ready' : 'unavailable');
            });
        }
        else if (capabilities.list) {
            setSftpState('ready');
        }
        if (capabilities.list)
            void refresh('.');
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session]);
    const rememberFile = (path) => {
        setRecentFiles((prev) => {
            const next = [path, ...prev.filter((p) => p !== path)].slice(0, 20);
            saveValue('recentFiles', next);
            return next;
        });
    };
    const updateFile = (path, patch) => {
        setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, ...patch } : f)));
    };
    const save = async (path, force = false) => {
        const buffer = filesRef.current.find((f) => f.path === path);
        if (!buffer)
            return;
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
                if (hasRemoteConflict(buffer.original, normalizeEol(remote, '\n'))) {
                    updateFile(path, { saving: false, conflict: true });
                    setStatus(`${path} changed on the server — not saved.`);
                    return;
                }
            }
            await session.writeFile(path, new TextEncoder().encode(normalizeEol(content, buffer.eol)));
            const latest = filesRef.current.find((f) => f.path === path);
            const unchanged = !latest || latest.content === content;
            updateFile(path, {
                saving: false,
                dirty: unchanged ? false : latest.dirty,
                conflict: false,
                original: content
            });
            setStatus(unchanged ? `Saved ${path}` : `Saved ${path} — newer edits are still pending`);
        }
        catch (err) {
            updateFile(path, {
                saving: false,
                error: err instanceof Error ? err.message : String(err)
            });
        }
        finally {
            savingRef.current.delete(path);
        }
    };
    saveRef.current = save;
    const openFile = async (path, line) => {
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
        }
        catch (err) {
            setStatus(`Open failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            setBusy(false);
        }
    };
    const closeFile = (path) => {
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
    const applyEdit = (path, nextText, start, end = start) => {
        updateFile(path, { content: nextText, dirty: true, error: null });
        pendingSelection.current = { start, end };
        if (autoSave)
            armTimer(path);
    };
    const onEdit = (path, value) => {
        updateFile(path, { content: value, dirty: true, error: null });
        if (autoSave)
            armTimer(path);
    };
    const active = activePath ? files.find((f) => f.path === activePath) ?? null : null;
    // A diff belongs to one file; switching tabs must not leave the old one on
    // screen looking like it describes the new file.
    useEffect(() => {
        setDiff([]);
    }, [activePath]);
    const changeFontSize = (next) => {
        const clamped = Math.max(11, Math.min(24, next));
        setFontSize(clamped);
        saveValue('fontSize', clamped);
    };
    // Apply a pending caret position after a programmatic edit re-renders.
    useEffect(() => {
        const editor = editorRef.current;
        if (!editor)
            return;
        if (pendingGotoLine.current !== null && active) {
            const offset = lineStartOffset(active.content, pendingGotoLine.current);
            editor.focus();
            editor.setSelectionRange(offset, offset);
            setCursor(lineColumnAt(active.content, offset));
            pendingGotoLine.current = null;
            return;
        }
        const pending = pendingSelection.current;
        if (!pending)
            return;
        pendingSelection.current = null;
        editor.focus();
        editor.setSelectionRange(pending.start, pending.end);
        setCursor(lineColumnAt(active?.content ?? '', pending.start));
    }, [active?.content, active?.path, selectionTick]);
    const matches = active ? findMatches(active.content, findQuery, caseSensitive) : [];
    const focusMatch = (index) => {
        if (!active || matches.length === 0)
            return;
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
    const doReplace = (all) => {
        if (!active)
            return;
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
    const doGotoLine = () => {
        if (!active)
            return;
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
    const onEditorKeyDown = (event) => {
        if (!active)
            return;
        const textarea = event.currentTarget;
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
            document.querySelector('[data-testid="ide-find-input"]')?.focus();
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
        if (key === 'Enter' &&
            start === end &&
            !event.isComposing &&
            !event.shiftKey &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey) {
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
            const result = indentSelection(active.content, start, end, INDENT_UNIT, Boolean(event.shiftKey));
            applyEdit(active.path, result.text, result.start, result.end);
        }
    };
    const trackCursor = (event) => {
        const textarea = event.currentTarget;
        const pos = lineColumnAt(textarea.value, textarea.selectionStart);
        setCursor(pos);
    };
    const newFile = async () => {
        if (!session?.writeFile || !canEdit) {
            setStatus('SFTP write is unavailable on this connection.');
            return;
        }
        const name = window.prompt('New file name', 'untitled.txt')?.trim();
        if (!name)
            return;
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
        }
        catch (err) {
            setStatus(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const newFolder = async () => {
        if (!session?.makeDir || !canEdit) {
            setStatus('This connection cannot create folders.');
            return;
        }
        const name = window.prompt('New folder name', 'src')?.trim();
        if (!name)
            return;
        try {
            await session.makeDir(joinPath(root, name));
            setStatus(`Created folder ${joinPath(root, name)}`);
            await refresh(root);
        }
        catch (err) {
            setStatus(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const renameActive = async () => {
        if (!active || !session?.renamePath) {
            setStatus('Renaming is unavailable on this connection.');
            return;
        }
        if (active.saving) {
            setStatus('Wait for the current save to finish before renaming.');
            return;
        }
        const next = window.prompt('Rename to', baseName(active.path))?.trim();
        if (!next || next === baseName(active.path))
            return;
        const target = joinPath(parentPath(active.path), next);
        const wasDirty = active.dirty;
        try {
            await session.renamePath(active.path, target);
            // The buffer keeps its edits and dirty flag: moving a file must not make
            // unsaved text look saved, or the pending save lands on a path that no
            // longer exists.
            clearTimer(active.path);
            setFiles((prev) => prev.map((f) => (f.path === active.path ? { ...f, path: target } : f)));
            setActivePath(target);
            if (wasDirty && autoSave)
                armTimer(target);
            setStatus(`Renamed to ${target}${wasDirty ? ' — unsaved edits still pending' : ''}`);
            await refresh(root);
        }
        catch (err) {
            setStatus(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const deleteActive = async () => {
        if (!active || !session?.removePath || !canEdit) {
            setStatus('Deleting is unavailable on this connection.');
            return;
        }
        if (!window.confirm(`Delete ${active.path} on the server? This cannot be undone.`))
            return;
        try {
            await session.removePath(active.path);
            clearTimer(active.path);
            setFiles((prev) => prev.filter((f) => f.path !== active.path));
            setActivePath(null);
            setStatus(`Deleted ${active.path}`);
            await refresh(root);
        }
        catch (err) {
            setStatus(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const downloadActive = () => {
        if (!active)
            return;
        const blob = new Blob([active.content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = baseName(active.path);
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
        setStatus(`Downloaded ${baseName(active.path)}`);
    };
    const uploadFile = async (file) => {
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
            if (!window.confirm(`${path} already exists. Replace it with the uploaded file?`))
                return;
        }
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            await session.writeFile(path, bytes);
            setStatus(`Uploaded ${path}`);
            await refresh(root);
        }
        catch (err) {
            setStatus(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const runExec = async (commandLine) => {
        if (!session)
            throw new Error('No session');
        return session.exec(commandLine);
    };
    const quickFind = async () => {
        if (!session?.isConnected()) {
            setStatus('Disconnected — cannot search files.');
            return;
        }
        const needle = quickOpen.trim();
        if (!needle)
            return;
        try {
            const result = await runExec(`find ${posixQuote(root)} -maxdepth 5 -type f 2>/dev/null | head -n 500`);
            const matches = result.stdout
                .split('\n')
                .filter((line) => line.toLowerCase().includes(needle.toLowerCase()))
                .slice(0, 60);
            setQuickResults(matches);
            setStatus(`${matches.length} matching file(s) in ${root}`);
        }
        catch (err) {
            setStatus(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const searchProject = async () => {
        if (!session?.isConnected()) {
            setStatus('Disconnected — cannot search the project.');
            return;
        }
        const needle = searchQuery.trim();
        if (!needle)
            return;
        try {
            const result = await runExec(`grep -rn --binary-files=without-match -m1 -- ${posixQuote(needle)} ${posixQuote(root)} 2>/dev/null | head -n 200`);
            const parsed = parseGrepMatches(result.stdout, 100);
            setSearchResults(parsed);
            setStatus(`${parsed.length} match(es) for ${needle}`);
        }
        catch (err) {
            setStatus(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const refreshGit = async () => {
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
        }
        catch (err) {
            setStatus(`git status failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const showDiff = async () => {
        if (!active || !session?.isConnected()) {
            setStatus('Open a file on a live connection to see its diff.');
            return;
        }
        try {
            const result = await runExec(`git -C ${posixQuote(root)} diff -- ${posixQuote(active.path)} 2>/dev/null`);
            const parsed = parseDiff(result.stdout);
            setDiff(parsed);
            setStatus(parsed.length ? `${parsed.length} diff line(s) for ${active.path}` : 'No git diff for this file.');
        }
        catch (err) {
            setStatus(`git diff failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const runCommand = async (raw) => {
        const cmd = (raw ?? command).trim();
        if (!cmd)
            return;
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
        }
        catch (err) {
            setOutput((prev) => [...prev, `Command failed: ${err instanceof Error ? err.message : String(err)}`].slice(-MAX_OUTPUT_LINES));
        }
    };
    const onCommandKeyDown = (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            void runCommand();
            return;
        }
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
            return;
        if (history.length === 0)
            return;
        event.preventDefault();
        const next = event.key === 'ArrowUp'
            ? Math.min(historyIndex + 1, history.length - 1)
            : Math.max(historyIndex - 1, -1);
        setHistoryIndex(next);
        setCommand(next === -1 ? '' : history[history.length - 1 - next] ?? '');
    };
    const pinCommand = () => {
        const cmd = command.trim();
        if (!cmd || presets.includes(cmd))
            return;
        const next = [...presets, cmd].slice(-12);
        setPresets(next);
        saveValue('presets', next);
        setStatus(`Pinned: ${cmd}`);
    };
    const removePreset = (cmd) => {
        const next = presets.filter((p) => p !== cmd);
        setPresets(next);
        saveValue('presets', next);
    };
    const copyOutput = async () => {
        try {
            await navigator.clipboard.writeText(output.join('\n'));
            setStatus('Copied command output.');
        }
        catch {
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
    return (_jsxs("section", { className: "ws-mod", "data-testid": "screen-ide", children: [_jsxs("header", { className: "ws-mod-head", children: [_jsxs("div", { children: [_jsx("h2", { children: "Workspace editor" }), _jsxs("p", { className: "ws-mod-muted", children: [connectedLabel || 'Not connected', " \u00B7 files are read and written over SFTP; nothing is installed on the server."] })] }), _jsxs("div", { className: "ws-mod-actions", children: [_jsx(Badge, { tone: badgeTone, children: badgeText }), _jsxs("label", { className: "ws-mod-check", htmlFor: "ide-auto-save", children: ["Auto-save", _jsx("input", { id: "ide-auto-save", type: "checkbox", checked: autoSave, "data-testid": "ide-auto-save", onChange: (e) => {
                                            const next = e.currentTarget.checked;
                                            setAutoSave(next);
                                            saveValue('autoSave', next);
                                            if (!next) {
                                                for (const handle of timers.current.values())
                                                    window.clearTimeout(handle);
                                                timers.current.clear();
                                            }
                                        } })] }), _jsx(Button, { variant: "ghost", onClick: () => changeFontSize(fontSize - 1), testId: "ide-font-dec", children: "A-" }), _jsxs("span", { "data-testid": "ide-font-size", children: [fontSize, "px"] }), _jsx(Button, { variant: "ghost", onClick: () => changeFontSize(fontSize + 1), testId: "ide-font-inc", children: "A+" })] })] }), _jsxs("div", { className: "ws-mod-filters", children: [_jsxs("select", { className: "ui-input", "aria-label": "Saved projects", "data-testid": "ide-projects", value: projects.includes(root) ? root : '', onChange: (e) => void refresh(e.currentTarget.value), children: [_jsx("option", { value: "", children: "Recent projects\u2026" }), projects.map((project) => (_jsx("option", { value: project, children: project }, project)))] }), _jsx("input", { className: "ui-input", "aria-label": "Project folder", "data-testid": "ide-root-input", value: root, onInput: (e) => setRoot(e.currentTarget.value), style: { flex: '1 1 240px' } }), _jsx(Button, { onClick: () => void refresh(root), testId: "ide-open-project", children: "Open folder" }), _jsx(Button, { variant: "ghost", onClick: () => void refresh(parentPath(root)), testId: "ide-up", children: "Up" }), _jsx(Button, { variant: "ghost", onClick: () => void refresh('.'), testId: "ide-home", children: "Home" }), _jsx(Button, { variant: "ghost", testId: "ide-forget-project", onClick: () => {
                            const next = projects.filter((p) => p !== root);
                            setProjects(next);
                            saveValue('projects', next);
                            setStatus(`Forgot ${root}`);
                        }, children: "Forget" })] }), listError ? (_jsx("p", { className: "ws-mod-error", role: "status", "data-testid": "ide-list-error", children: listError })) : null, _jsxs("div", { className: "ws-mod-split ide-workspace-split", children: [_jsxs("aside", { className: "ws-mod-list", "aria-label": "Project files", style: { overflowX: 'hidden' }, children: [_jsx("h3", { children: root }), _jsxs("div", { className: "ws-mod-actions", children: [_jsx(Button, { variant: "ghost", onClick: () => void newFile(), testId: "ide-new-file", children: "New file" }), _jsx(Button, { variant: "ghost", onClick: () => void newFolder(), testId: "ide-new-folder", children: "New folder" }), _jsx(Button, { variant: "ghost", onClick: () => uploadRef.current?.click(), testId: "ide-upload", children: "Upload" }), _jsx("input", { ref: (el) => {
                                            uploadRef.current = el;
                                        }, type: "file", "aria-label": "Upload a file into the open folder", "data-testid": "ide-upload-input", style: { display: 'none' }, onChange: (e) => {
                                            const file = e.currentTarget.files?.[0];
                                            if (file)
                                                void uploadFile(file);
                                            e.currentTarget.value = '';
                                        } })] }), _jsxs("ul", { "data-testid": "ide-file-list", style: { listStyle: 'none', padding: 0, margin: 0 }, children: [entries.map((entry) => (_jsx("li", { children: _jsxs("button", { type: "button", className: "ui-button", "data-testid": `ide-entry-${entry.name}`, onClick: () => void (entry.isDir ? refresh(entry.path) : openFile(entry.path)), style: { width: '100%', textAlign: 'left' }, children: [entry.isDir ? '▸ ' : '  ', entry.name, !entry.isDir && entry.size > 0 ? ` · ${formatBytes(entry.size)}` : ''] }) }, entry.path))), entries.length === 0 && !busy ? _jsx("li", { children: "No entries listed." }) : null, busy ? _jsx("li", { children: "Loading\u2026" }) : null] }), _jsx("h4", { style: { marginBottom: 'var(--space-1)' }, children: "Quick open" }), _jsxs("div", { className: "ws-mod-filters", children: [_jsx("input", { className: "ui-input", "aria-label": "Find a file by name", "data-testid": "ide-quick-open", value: quickOpen, onInput: (e) => setQuickOpen(e.currentTarget.value) }), _jsx(Button, { variant: "ghost", onClick: () => void quickFind(), testId: "ide-quick-open-run", children: "Find" })] }), quickResults.length > 0 ? (_jsx("ul", { "data-testid": "ide-quick-results", style: { listStyle: 'none', padding: 0 }, children: quickResults.map((path) => (_jsx("li", { children: _jsx("button", { type: "button", onClick: () => void openFile(path), children: path }) }, path))) })) : null, recentFiles.length > 0 ? (_jsxs(_Fragment, { children: [_jsx("h4", { style: { marginBottom: 'var(--space-1)' }, children: "Recent files" }), _jsx("ul", { "data-testid": "ide-recent-files", style: { listStyle: 'none', padding: 0 }, children: recentFiles.slice(0, 8).map((path) => (_jsx("li", { children: _jsx("button", { type: "button", onClick: () => void openFile(path), children: baseName(path) }) }, path))) })] })) : null] }), _jsxs("section", { className: "ws-mod-content", "aria-label": "Editor", children: [_jsx("div", { role: "tablist", "aria-label": "Open files", "data-testid": "ide-tabs", children: files.map((file) => (_jsxs("span", { children: [_jsxs("button", { type: "button", role: "tab", "aria-selected": file.path === activePath, onClick: () => setActivePath(file.path), "data-testid": `ide-tab-${baseName(file.path)}`, children: [baseName(file.path), file.dirty ? ' *' : '', file.conflict ? ' ⚠' : '', file.error ? ' !' : ''] }), _jsx("button", { type: "button", "aria-label": `Close ${baseName(file.path)}`, onClick: () => closeFile(file.path), children: "\u00D7" })] }, file.path))) }), active ? (_jsxs("div", { className: "ws-mod-detail", children: [_jsxs("div", { className: "ws-mod-actions", children: [_jsx("span", { "data-testid": "ide-active-path", children: active.path }), _jsx(Badge, { tone: active.conflict ? 'danger' : active.dirty ? 'warning' : 'success', children: active.conflict ? 'Remote changed' : active.dirty ? 'Unsaved' : 'Saved' }), active.saving ? _jsx("span", { children: "Saving\u2026" }) : null, _jsx(Button, { onClick: () => void save(active.path), testId: "ide-save", children: "Save now" }), active.conflict ? (_jsx(Button, { variant: "danger", onClick: () => void save(active.path, true), testId: "ide-overwrite", children: "Overwrite with my version" })) : null, _jsx(Button, { variant: "ghost", onClick: () => setDiff([]), testId: "ide-clear-diff", children: "Clear diff" })] }), _jsxs("div", { className: "ws-mod-filters", children: [_jsx("input", { className: "ui-input", "aria-label": "Find in file", "data-testid": "ide-find-input", placeholder: "Find", value: findQuery, onInput: (e) => {
                                                    setFindQuery(e.currentTarget.value);
                                                    setMatchIndex(0);
                                                }, style: { flex: '1 1 140px' } }), _jsx(Button, { variant: "ghost", onClick: () => focusMatch(matchIndex + 1), testId: "ide-find-next", children: "Next" }), _jsx(Button, { variant: "ghost", onClick: () => focusMatch(matchIndex - 1), testId: "ide-find-prev", children: "Prev" }), _jsx("label", { htmlFor: "ide-case", children: "Aa" }), _jsx("input", { id: "ide-case", type: "checkbox", checked: caseSensitive, "data-testid": "ide-case-sensitive", onChange: (e) => setCaseSensitive(e.currentTarget.checked) }), _jsx("span", { "data-testid": "ide-match-count", children: findQuery ? `${matches.length} match(es)` : '—' }), _jsx("input", { className: "ui-input", "aria-label": "Replace with", "data-testid": "ide-replace-input", placeholder: "Replace", value: replaceValue, onInput: (e) => setReplaceValue(e.currentTarget.value), style: { flex: '1 1 120px' } }), _jsx(Button, { variant: "ghost", onClick: () => doReplace(false), testId: "ide-replace-one", children: "Replace" }), _jsx(Button, { variant: "ghost", onClick: () => doReplace(true), testId: "ide-replace-all", children: "Replace all" })] }), _jsxs("div", { className: "ws-mod-filters", children: [_jsx("input", { className: "ui-input", "aria-label": "Go to line", "data-testid": "ide-goto-line", placeholder: "Line", value: gotoLine, onInput: (e) => setGotoLine(e.currentTarget.value), style: { width: '80px' } }), _jsx(Button, { variant: "ghost", onClick: doGotoLine, testId: "ide-goto-line-run", children: "Go" }), _jsx(Button, { variant: "ghost", onClick: downloadActive, testId: "ide-download", children: "Download copy" }), _jsx(Button, { variant: "ghost", onClick: () => void renameActive(), testId: "ide-rename", children: "Rename" }), _jsx(Button, { variant: "danger", onClick: () => void deleteActive(), testId: "ide-delete", children: "Delete" }), _jsxs("span", { "data-testid": "ide-cursor", children: ["Ln ", cursor.line, ", Col ", cursor.column] }), _jsxs("span", { "data-testid": "ide-stats", children: [textStats(active.content).lines, " lines \u00B7 ", textStats(active.content).words, " words \u00B7", ' ', textStats(active.content).chars, " chars"] })] }), _jsx("textarea", { ref: (el) => {
                                            editorRef.current = el;
                                        }, className: "ui-input ide-editor", "aria-label": `Editing ${active.path}`, "data-testid": "ide-editor", value: active.content, onInput: (e) => onEdit(active.path, e.currentTarget.value), onKeyDown: onEditorKeyDown, onSelect: trackCursor, onClick: trackCursor, onKeyUp: trackCursor, spellcheck: false, style: {
                                            width: '100%',
                                            fontFamily: 'var(--font-font-mono)',
                                            fontSize: `${fontSize}px`,
                                            whiteSpace: 'pre',
                                            overflow: 'auto'
                                        } }), active.error ? (_jsx("p", { role: "alert", "data-testid": "ide-save-error", children: active.error })) : null] })) : (_jsx("div", { className: "ws-mod-detail", children: _jsx("p", { className: "ws-mod-muted", children: "Select a file to edit. Auto-save writes back over SFTP after a short pause; pending edits are flushed when you leave this screen." }) }))] })] }), _jsxs("div", { className: "ws-mod-split ide-secondary-split", children: [_jsxs("section", { className: "ws-mod-detail", "aria-label": "Find in project", children: [_jsx("h3", { children: "Project search" }), _jsxs("div", { className: "ws-mod-filters", children: [_jsx("input", { className: "ui-input", "aria-label": "Search project text", "data-testid": "ide-search-query", value: searchQuery, onInput: (e) => setSearchQuery(e.currentTarget.value), style: { flex: 1 } }), _jsx(Button, { variant: "ghost", onClick: () => void searchProject(), testId: "ide-search-run", children: "Search" })] }), searchResults.length > 0 ? (_jsx("ul", { "data-testid": "ide-search-results", style: { listStyle: 'none', padding: 0 }, children: searchResults.map((hit) => (_jsx("li", { children: _jsxs("button", { type: "button", onClick: () => void openFile(hit.path, hit.line), children: [hit.path, ":", hit.line, " \u2014 ", hit.text.slice(0, 120)] }) }, `${hit.path}:${hit.line}`))) })) : null] }), _jsxs("section", { className: "ws-mod-detail", "aria-label": "Run a command", children: [_jsx("h3", { children: "Run a command" }), _jsxs("div", { className: "ws-mod-filters", children: [_jsx("input", { className: "ui-input", "aria-label": "Command", "data-testid": "ide-command-input", value: command, onInput: (e) => setCommand(e.currentTarget.value), onKeyDown: onCommandKeyDown, style: { flex: 1 } }), _jsx(Button, { onClick: () => void runCommand(), testId: "ide-run-command", children: "Run" }), _jsx(Button, { variant: "ghost", onClick: pinCommand, testId: "ide-pin-command", children: "Pin" })] }), _jsxs("label", { htmlFor: "ide-run-in-root", children: ["Run inside ", root, _jsx("input", { id: "ide-run-in-root", type: "checkbox", checked: runInRoot, "data-testid": "ide-run-in-root", onChange: (e) => setRunInRoot(e.currentTarget.checked) })] }), presets.length > 0 ? (_jsx("div", { "data-testid": "ide-presets", className: "ws-mod-chips", children: presets.map((preset) => (_jsxs("span", { children: [_jsx("button", { type: "button", onClick: () => void runCommand(preset), children: preset }), _jsx("button", { type: "button", "aria-label": `Remove ${preset}`, onClick: () => removePreset(preset), children: "\u00D7" })] }, preset))) })) : null, _jsxs("div", { className: "ws-mod-actions", children: [_jsx(Button, { variant: "ghost", onClick: () => void copyOutput(), testId: "ide-copy-output", children: "Copy output" }), _jsx(Button, { variant: "ghost", onClick: () => setOutput([]), testId: "ide-clear-output", children: "Clear" }), _jsx(Button, { variant: "ghost", onClick: () => void refreshGit(), testId: "ide-git-refresh", children: "Refresh git" }), _jsx(Button, { variant: "ghost", onClick: () => void showDiff(), testId: "ide-git-diff", children: "Diff this file" }), _jsx("span", { "data-testid": "ide-git-status", children: git ? `${git.branch} · ${git.changes} change(s)` : 'git: not checked' })] }), _jsx("pre", { "data-testid": "ide-command-output", "aria-live": "polite", style: { maxHeight: '220px', overflow: 'auto', whiteSpace: 'pre-wrap' }, children: output.join('\n') }), diff.length > 0 ? (_jsx("pre", { "data-testid": "ide-diff", style: { maxHeight: '220px', overflow: 'auto', whiteSpace: 'pre-wrap' }, children: diff
                                    .map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`)
                                    .join('\n') })) : null] })] }), _jsx("p", { role: "status", "data-testid": "ide-status", className: "ws-mod-muted", children: status })] }));
}
//# sourceMappingURL=LightIde.js.map