import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Badge, Button, Icon } from '@webssh/ui-kit';
import type { SftpEntryInfo, WorkspaceRemoteSession } from '../session/adapters';
import { XtermPaneAdapter, type TerminalRendererMode } from '../terminal/xterm-adapter';
import { TerminalPane, type PaneTransport } from '../terminal/TerminalPane';
import { ChannelOutputBuffer } from '../terminal/channel-output-buffer';
import { ConnectionRegistry, nextConnectionId } from '../session/connection-registry';
import type { LiveGatewaySessionClient, BrowserSshRelaySessionClient, TransportBackendMode } from '../transport';
import type { ThemeId } from '@webssh/ui-kit';

interface OpenFile {
  path: string;
  content: string;
  original: string;
  eol: '\r\n' | '\n';
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  error: string | null;
  preview?: string;
}

type SessionClient = LiveGatewaySessionClient | BrowserSshRelaySessionClient;

export function IntegratedWorkspace({
  session,
  connectedLabel,
  transport,
  host,
  port,
  user
}: {
  session: WorkspaceRemoteSession | null;
  connectedLabel: string;
  transport: TransportBackendMode;
  host: string;
  port: number;
  user: string;
}): JSX.Element {
  const [root, setRoot] = useState<string>('.');
  const [entries, setEntries] = useState<SftpEntryInfo[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [autoSave, setAutoSave] = useState<boolean>(true);
  const [fontSize, setFontSize] = useState<number>(14);
  const [wrap, setWrap] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('');
  const [cursor, setCursor] = useState<{ line: number; column: number }>({ line: 1, column: 1 });
  const [bracketMatch, setBracketMatch] = useState<{ open: number; close: number } | null>(null);
  const [dragging, setDragging] = useState<boolean>(false);
  const [sftpState, setSftpState] = useState<'unknown' | 'ready' | 'unavailable'>('unknown');
  const [explorerCollapsed, setExplorerCollapsed] = useState<boolean>(false);
  const [terminalHeight, setTerminalHeight] = useState<number>(0.35);

  const timers = useRef<Map<string, number>>(new Map());
  const savingRef = useRef<Set<string>>(new Set());
  const filesRef = useRef(files);
  filesRef.current = files;
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);
  const pendingGotoLine = useRef<number | null>(null);

  const connected = Boolean(session?.isConnected());
  const capabilities = {
    list: typeof session?.listDir === 'function',
    read: typeof session?.readFile === 'function',
    write: typeof session?.writeFile === 'function'
  };
  const canEdit = connected && capabilities.read && capabilities.write;

  const clearTimer = (path: string): void => {
    const handle = timers.current.get(path);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timers.current.delete(path);
    }
  };

  const armTimer = (path: string, delay = 1200): void => {
    clearTimer(path);
    const handle = window.setTimeout(() => {
      timers.current.delete(path);
      void saveRef.current?.(path);
    }, delay);
    timers.current.set(path, handle);
  };

  const connectionState = connected ? 'connected' : 'disconnected';

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
      setEntries(sortAndFilterEntries(listed, ''));
      setRoot(target);
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
  }, [session]);

  async function save(path: string, force = false): Promise<'saved' | 'conflict' | 'failed' | 'busy' | 'missing'> {
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
    try {
      if (!force) {
        const remote = await session.readFile(path);
        if (buffer.original !== remote) {
          updateFile(path, { saving: false, conflict: true });
          setStatus(`${path} changed on the server — not saved.`);
          return 'conflict';
        }
      }
      await session.writeFile(path, new TextEncoder().encode(buffer.content));
      updateFile(path, {
        saving: false,
        dirty: false,
        conflict: false,
        error: null,
        original: content
      });
      setStatus(`Saved ${path}`);
      return 'saved';
    } catch (err) {
      updateFile(path, {
        saving: false,
        error: err instanceof Error ? err.message : String(err)
      });
      return 'failed';
    } finally {
      savingRef.current.delete(path);
    }
  }

  const saveRef = useRef<(path: string, force?: boolean) => Promise<'saved' | 'conflict' | 'failed' | 'busy' | 'missing'>>(save);
  saveRef.current = save;

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

  const openFile = async (path: string): Promise<void> => {
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
      return;
    }
    setBusy(true);
    try {
      const raw = await session.readFile(path);
      const content = raw.replace(/\r\n/g, '\n');
      setFiles((prev) => [
        ...prev,
        { path, content, original: content, eol: '\n', dirty: false, saving: false, conflict: false, error: null }
      ]);
      setActivePath(path);
      setStatus(`Opened ${path}`);
    } catch (err) {
      setStatus(`Open failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const closeFile = (path: string): void => {
    const buffer = filesRef.current.find((f) => f.path === path);
    if (buffer?.dirty && !window.confirm(`${path} has unsaved changes. Close anyway?`)) {
      return;
    }
    setFiles((prev) => prev.filter((f) => f.path !== path));
    if (activePath === path) {
      const next = filesRef.current.find((f) => f.path !== path);
      setActivePath(next ? next.path : null);
    }
  };

  const applyEdit = (path: string, nextText: string): void => {
    updateFile(path, { content: nextText, dirty: true, error: null });
    if (autoSave) armTimer(path);
  };

  const onEdit = (path: string, value: string): void => {
    updateFile(path, { content: value, dirty: true, error: null });
    if (autoSave) armTimer(path);
  };

  const active = activePath ? files.find((f) => f.path === activePath) ?? null : null;

  const paneAdaptersRef = useRef<Map<string, XtermPaneAdapter>>(new Map());
  const channelOutputRef = useRef<ChannelOutputBuffer>(new ChannelOutputBuffer());
  const [tabs, setTabs] = useState<{ id: string; title: string; connected: boolean; channelId?: number; connectionId?: string }[]>([
    { id: 'tab-1', title: 'Terminal 1', connected: false, channelId: 1 }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('tab-1');
  const [cols, setCols] = useState<number>(80);
  const [rows, setRows] = useState<number>(24);

  const terminalViewRef = useRef<HTMLDivElement | null>(null);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const registerPaneAdapter = (paneId: string, adapter: XtermPaneAdapter | null): void => {
    if (!adapter) {
      paneAdaptersRef.current.delete(paneId);
      return;
    }
    paneAdaptersRef.current.set(paneId, adapter);
    const tab = tabsRef.current.find((t) => t.id === paneId);
    if (tab?.connectionId && tab.channelId !== undefined) {
      channelOutputRef.current.drainTo(`${tab.connectionId}:${tab.channelId}`, adapter);
    }
  };

  useEffect(() => {
    for (const tab of tabs) {
      if (!tab.connectionId || tab.channelId === undefined) continue;
      const adapter = paneAdaptersRef.current.get(tab.id);
      if (adapter) {
        channelOutputRef.current.drainTo(`${tab.connectionId}:${tab.channelId}`, adapter);
      }
    }
  }, [tabs]);

  const handleTerminalInput = (data: string): void => {
    const tab = tabsRef.current.find((t) => t.id === activeTabId);
    const channel = tab?.channelId ?? 1;
    const client = connectionRegistryRef.current.get(tab?.connectionId)?.client as PaneTransport;
    if (client?.isConnected) {
      client.sendPtyText(channel, data + '\r');
    }
  };

  const connectionRegistryRef = useRef<ConnectionRegistry<SessionClient>>(new ConnectionRegistry());

  useEffect(() => {
    if (session?.isConnected()) {
      const connectionId = nextConnectionId();
      connectionRegistryRef.current.add({
        id: connectionId,
        host,
        port,
        user,
        transport,
        client: session as unknown as SessionClient,
        channels: new Set([1])
      });
      setTabs((prev) =>
        prev.map((t) => ({ ...t, connectionId, channelId: 1, connected: true }))
      );
    }
    return () => {
      connectionRegistryRef.current.closeAll();
    };
  }, [session]);

  function updateFile(path: string, patch: Partial<OpenFile>): void {
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, ...patch } : f)));
  }

  const syncCaret = (textarea: HTMLTextAreaElement, content: string): void => {
    const offset = textarea.selectionStart;
    const before = content.slice(0, offset);
    setCursor({ line: before.split('\n').length, column: before.split('\n').pop()!.length });
    setBracketMatch(bracketPairAt(content, offset));
  };

  return (
    <section className="webssh-integrated-workspace" data-testid="screen-integrated-workspace">
      <header className="webssh-integrated-header">
        <div className="webssh-integrated-brand">
          <Icon name="home" size={16} />
          <span className="webssh-integrated-title">Integrated Workspace</span>
        </div>
        <div className="webssh-integrated-connection">
          <span className={`webssh-status-dot ${connected ? 'webssh-status-dot--connected' : 'webssh-status-dot--disconnected'}`} />
          <span>{connectedLabel}</span>
          <Badge tone={sftpState === 'ready' ? 'success' : 'danger'}>{sftpState === 'ready' ? 'SFTP Ready' : 'SFTP Unavailable'}</Badge>
        </div>
        <div className="webssh-integrated-actions">
          <Button variant="ghost" onClick={() => setExplorerCollapsed(!explorerCollapsed)} title="Toggle Explorer">
            {explorerCollapsed ? '▸' : '◂'}
          </Button>
          <Button variant="ghost" onClick={() => setTerminalHeight(Math.max(0.2, terminalHeight - 0.1))}>
            ▾ Terminal
          </Button>
          <Button variant="ghost" onClick={() => setTerminalHeight(Math.min(0.8, terminalHeight + 0.1))}>
            ▴ Terminal
          </Button>
        </div>
      </header>

      <div className="webssh-integrated-body">
        {!explorerCollapsed && (
          <aside className="webssh-integrated-explorer">
            <div className="webssh-integrated-explorer-header">
              <h3>{root}</h3>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button variant="ghost" onClick={() => void newFile()} title="New File">
                  <Icon name="file" size={14} />
                </Button>
                <Button variant="ghost" onClick={() => void newFolder()} title="New Folder">
                  <Icon name="folder" size={14} />
                </Button>
                <Button variant="ghost" onClick={() => uploadRef.current?.click()} title="Upload">
                  <Icon name="upload" size={14} />
                </Button>
                <input
                  ref={(el) => {
                    uploadRef.current = el;
                  }}
                  type="file"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = (e.currentTarget as HTMLInputElement).files?.[0];
                    if (file) void uploadFile(file);
                  }}
                />
              </div>
            </div>
            <ul className="webssh-integrated-file-list">
              {entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="webssh-integrated-entry"
                    onClick={() => (entry.isDir ? refresh(entry.path) : openFile(entry.path))}
                  >
                    {entry.isDir ? '📁 ' : '📄 '} {entry.name}
                  </button>
                </li>
              ))}
              {entries.length === 0 && !busy ? <li>No entries listed.</li> : null}
              {busy ? <li>Loading…</li> : null}
            </ul>
          </aside>
        )}

        <main className="webssh-integrated-editor">
          <div className="webssh-integrated-editor-tabs">
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                className={`webssh-integrated-tab ${file.path === activePath ? 'webssh-integrated-tab-active' : ''}`}
                onClick={() => setActivePath(file.path)}
              >
                {baseName(file.path)}
                {file.dirty ? ' ●' : ''}
                <span className="webssh-integrated-tab-close" onClick={(e) => {
                  e.stopPropagation();
                  closeFile(file.path);
                }}>
                  ×
                </span>
              </button>
            ))}
            <button type="button" className="webssh-integrated-tab webssh-integrated-tab-new" onClick={() => setActivePath('untitled.txt')}>
              +
            </button>
          </div>

          {active ? (
            <div className="webssh-integrated-editor-content">
              <div className="webssh-integrated-editor-toolbar">
                <Badge tone={active.conflict ? 'danger' : active.saving ? 'warning' : active.dirty ? 'warning' : 'success'}>
                  {active.conflict ? 'Conflict' : active.saving ? 'Saving…' : active.dirty ? 'Unsaved' : 'Saved'}
                </Badge>
                <span style={{ marginLeft: 'auto' }}>{active.path}</span>
                <Button variant="ghost" onClick={() => void save(active.path)} disabled={!active.dirty || active.saving}>
                  Save
                </Button>
              </div>
              <textarea
                ref={(el) => {
                  editorRef.current = el;
                }}
                className="webssh-integrated-textarea"
                aria-label={`Editing ${active.path}`}
                value={active.content}
                onInput={(e) => onEdit(active.path, (e.currentTarget as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                    e.preventDefault();
                    void save(active.path);
                  }
                }}
                onSelect={(e) => syncCaret(e.currentTarget as HTMLTextAreaElement, e.currentTarget.value)}
                onClick={(e) => syncCaret(e.currentTarget as HTMLTextAreaElement, e.currentTarget.value)}
                spellcheck={false}
                style={{
                  width: '100%',
                  height: '100%',
                  fontFamily: "'WebSSH Mono', monospace",
                  fontSize: `${fontSize}px`,
                  lineHeight: '1.6',
                  whiteSpace: 'pre',
                  overflow: 'auto',
                  resize: 'vertical'
                }}
              />
            </div>
          ) : (
            <div className="webssh-integrated-editor-empty">
              <Icon name="file" size={48} />
              <p>No file open. Select a file from the explorer to edit.</p>
            </div>
          )}
        </main>

        <div className="webssh-integrated-terminal">
          <div className="webssh-integrated-terminal-header">
            <span>Terminal</span>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button variant="ghost" onClick={() => setCols(80)}>80 cols</Button>
              <Button variant="ghost" onClick={() => setCols(120)}>120 cols</Button>
            </div>
          </div>
          <div
            ref={terminalViewRef}
            className="webssh-terminal-viewport"
            style={{ fontSize: `${fontSize}px`, fontFamily: "'WebSSH Mono', monospace" }}
            onClick={(e) => {
              const target = e.target as HTMLElement | null;
              if (target && typeof target.closest === 'function' && target.closest('.xterm')) {
                return;
              }
              terminalViewRef.current?.focus();
            }}
            onKeyDown={(e) => {
              if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                handleTerminalInput(e.key);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                handleTerminalInput('\r');
              } else if (e.key === 'Backspace') {
                e.preventDefault();
                handleTerminalInput('\b');
              } else if (e.key === 'Tab') {
                e.preventDefault();
                handleTerminalInput('\t');
              } else if (e.key === 'c' && e.ctrlKey) {
                e.preventDefault();
                handleTerminalInput('\x03');
              } else if (e.key === 'l' && e.ctrlKey) {
                e.preventDefault();
                handleTerminalInput('\x0c');
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                handleTerminalInput(e.key);
              }
            }}
          >
            <div className="webssh-terminal-panes" data-testid="terminal-panes">
              {tabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                return (
                <div
                  key={tab.id}
                  className="webssh-terminal-pane-slot"
                  style={{
                    display: isActive ? 'block' : 'none',
                    position: 'relative',
                    width: '100%',
                    height: '100%'
                  }}
                  data-testid={`pane-${tab.id}`}
                >
                  <TerminalPane
                    paneId={tab.id}
                    channelId={tab.channelId ?? null}
                    transport={(connectionRegistryRef.current.get(tab.connectionId)?.client as unknown as PaneTransport) ?? null}
                    active={isActive}
                    label={`${tab.title} terminal`}
                    fontFamily="'WebSSH Mono', monospace"
                    fontSize={fontSize}
                    lineHeight={1.45}
                    cursorStyle="block"
                    cursorBlink
                    scrollback={10000}
                    theme={{
                      background: 'var(--color-terminal-bg)',
                      foreground: 'var(--color-terminal-fg)',
                      cursor: 'var(--color-terminal-cursor)'
                    }}
                    onAdapter={registerPaneAdapter}
                    testId={`pane-${tab.id}`}
                  />
                </div>
                );
              })}
          </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// Helper functions
function bracketPairAt(text: string, caret: number): { open: number; close: number } | null {
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

function newFile(): void {
  // Placeholder - will be wired to session
}

function newFolder(): void {
  // Placeholder - will be wired to session
}

function uploadFile(_file: File): void {
  // Placeholder - will be wired to session
}

function sortAndFilterEntries(entries: SftpEntryInfo[], _filter: string): SftpEntryInfo[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || '/';
}
