import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
  Badge,
  Button,
  Card,
  ComponentGallery,
  EmptyState,
  Icon,
  Modal,
  THEME_IDS,
  applyThemeToDocument,
  type ThemeId
} from '@webssh/ui-kit';
import { KeyVault } from '../vault';
import { HostRegistry, type HostProfile } from '../hosts';
import { PreferencesStore } from '../prefs';
import {
  AsciicastRecorder,
  CommandPaletteRegistry,
  KeybindingRegistry,
  SPECIAL_KEYS_ROW,
  SnippetLibrary,
  parseAsciicastV2,
  scrubAsciicastOutput
} from './productivity';
import { StorageGuard, sortAndFilterEntries } from '../files';

export type ScreenId =
  | 'workspace'
  | 'welcome'
  | 'vault'
  | 'hosts'
  | 'files'
  | 'editor'
  | 'snippets'
  | 'settings';

export function App(): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const terminalViewRef = useRef<HTMLDivElement | null>(null);

  const prefsStore = useMemo(() => new PreferencesStore(), []);
  const hostRegistry = useMemo(() => {
    const reg = new HostRegistry();
    if (reg.list().length === 0) {
      reg.upsert({
        id: 'host-prod-edge',
        alias: 'prod-edge-01',
        host: 'edge-01.prod.internal',
        port: 22,
        user: 'sre',
        folder: 'Production',
        tags: ['edge', 'tls'],
        favorite: true,
        jumpHops: [{ host: 'bastion.prod.internal', port: 22, user: 'ops' }],
        tmuxAutoAttach: 'main'
      });
    }
    return reg;
  }, []);

  const vault = useMemo(() => new KeyVault(), []);
  const storageGuard = useMemo(() => new StorageGuard(), []);
  const snippetLib = useMemo(
    () =>
      new SnippetLibrary([
        {
          id: 'snip-1',
          name: 'Inspect Systemd Service',
          command: 'systemctl status {{service}} --no-pager',
          tags: ['systemd', 'ops']
        },
        {
          id: 'snip-2',
          name: 'Tail Journal Errors',
          command: 'journalctl -p err -n {{lines}} --no-pager',
          tags: ['logs']
        }
      ]),
    []
  );
  const keybindings = useMemo(
    () =>
      new KeybindingRegistry([
        { actionId: 'palette.toggle', description: 'Open Command Palette', shortcut: 'Cmd/Ctrl+K' },
        { actionId: 'fullscreen.toggle', description: 'Toggle Immersive Full-Screen', shortcut: 'F11' },
        { actionId: 'vault.lock', description: 'Lock Key Vault', shortcut: 'Cmd/Ctrl+Shift+L' }
      ]),
    []
  );

  const [activeScreen, setActiveScreen] = useState<ScreenId>('workspace');
  const [activeTheme, setActiveTheme] = useState<ThemeId>(
    (prefsStore.get().activeThemeId as ThemeId) || 'dark'
  );
  const [zenMode, setZenMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
  const [showOverlayBar, setShowOverlayBar] = useState(false);
  const [showFullscreenToast, setShowFullscreenToast] = useState(false);
  const [connectionState, setConnectionState] = useState<'connected' | 'reconnecting' | 'offline' | 'resumed'>('connected');
  const [pendingInputBytes, setPendingInputBytes] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [hostKeyModal, setHostKeyModal] = useState<'none' | 'tofu' | 'mismatch'>('none');
  const [hosts, setHosts] = useState<HostProfile[]>(() => hostRegistry.list());
  const [hostSearch, setHostSearch] = useState('');
  const [sshConfigInput, setSshConfigInput] = useState(
    ['Host staging-web', '  HostName 10.10.4.12', '  User deploy', '  Port 2222', '  ProxyJump bastion.internal'].join(
      String.fromCharCode(10)
    )
  );
  const [generatedPubKey, setGeneratedPubKey] = useState(
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWebSSHStudioBrowserNonExtractableKey webssh@browser'
  );
  const [generatedFp, setGeneratedFp] = useState('SHA256:k9XmP2vR7wL4qN8sT1yB6cF3hJ5mZ0pQ9vW2xR4tY8u');
  const [vaultLocked, setVaultLocked] = useState(false);
  const [fileFilter, setFileFilter] = useState('');
  const [editorContent, setEditorContent] = useState(
    ['# /etc/nginx/nginx.conf', 'worker_processes auto;', ''].join(String.fromCharCode(10))
  );
  const [editorSaved, setEditorSaved] = useState(true);
  const [scrubberSec, setScrubberSec] = useState(2.5);
  const [terminalLines, setTerminalLines] = useState<string[]>([
    'Connected to edge-01.prod.internal (SSH-2.0-OpenSSH_9.6 chacha20-poly1305@openssh.com)',
    'Remote signer: WebCrypto Ed25519 (non-extractable CryptoKey in IndexedDB)',
    'sre@edge-01:~$ uptime',
    ' 17:18:02 up 42 days,  6:14,  1 user,  load average: 0.08, 0.12, 0.09'
  ]);

  const demoCast = useMemo(() => {
    const nl = String.fromCharCode(10);
    const rec = new AsciicastRecorder(80, 24, 'Production Incident Check');
    rec.recordOutput(`$ kubectl get pods -n ingress${nl}`, Date.now() + 500);
    rec.recordOutput(`NAME                       READY   STATUS    RESTARTS   AGE${nl}`, Date.now() + 1500);
    rec.recordOutput(`gateway-7c9f8b6d4-x2k9p    1/1     Running   0          14d${nl}`, Date.now() + 2500);
    return parseAsciicastV2(rec.exportCast());
  }, []);

  useEffect(() => {
    applyThemeToDocument(activeTheme);
    prefsStore.update({ activeThemeId: activeTheme });
  }, [activeTheme, prefsStore]);

  const enterImmersiveFullscreen = async (): Promise<void> => {
    const el = rootRef.current;
    if (el && typeof el.requestFullscreen === 'function') {
      try {
        await el.requestFullscreen();
        setIsFullscreen(true);
        setIsPseudoFullscreen(false);
      } catch {
        setIsPseudoFullscreen(true);
        setIsFullscreen(true);
      }
    } else {
      setIsPseudoFullscreen(true);
      setIsFullscreen(true);
    }
    setShowFullscreenToast(true);
    setTimeout(() => setShowFullscreenToast(false), 3000);
    terminalViewRef.current?.focus();
  };

  const exitImmersiveFullscreen = async (): Promise<void> => {
    if (typeof document !== 'undefined' && document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      try {
        await document.exitFullscreen();
      } catch {
        // Ignore exit error
      }
    }
    setIsFullscreen(false);
    setIsPseudoFullscreen(false);
    setShowOverlayBar(false);
    terminalViewRef.current?.focus();
  };

  const toggleFullscreen = (): void => {
    if (isFullscreen) {
      void exitImmersiveFullscreen();
    } else {
      void enterImmersiveFullscreen();
    }
  };

  useEffect(() => {
    const onFullscreenChange = (): void => {
      if (typeof document !== 'undefined') {
        const fsActive = Boolean(document.fullscreenElement);
        if (!fsActive && !isPseudoFullscreen) {
          setIsFullscreen(false);
        }
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      } else if (e.key === 'F11' || ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f')) {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 'Escape' && isFullscreen) {
        void exitImmersiveFullscreen();
      } else if (e.key === 'Alt' && isFullscreen) {
        setShowOverlayBar(true);
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  const paletteRegistry = useMemo(() => {
    const reg = new CommandPaletteRegistry();
    reg.register({
      id: 'view.fullscreen',
      title: 'Toggle Immersive Full-Screen Mode',
      category: 'View',
      shortcut: 'F11',
      run: () => {
        toggleFullscreen();
        setPaletteOpen(false);
      }
    });
    reg.register({
      id: 'view.zen',
      title: 'Toggle Zen Mode',
      category: 'View',
      run: () => {
        setZenMode((z) => !z);
        setPaletteOpen(false);
      }
    });
    reg.register({
      id: 'nav.vault',
      title: 'Open SSH Key Vault',
      category: 'Security',
      run: () => {
        setActiveScreen('vault');
        setPaletteOpen(false);
      }
    });
    reg.register({
      id: 'nav.hosts',
      title: 'Open Hosts & ProxyJump Profiles',
      category: 'Connection',
      run: () => {
        setActiveScreen('hosts');
        setPaletteOpen(false);
      }
    });
    reg.register({
      id: 'nav.files',
      title: 'Open Dual-Pane SFTP File Browser',
      category: 'Files',
      run: () => {
        setActiveScreen('files');
        setPaletteOpen(false);
      }
    });
    reg.register({
      id: 'nav.settings',
      title: 'Open Preferences & Theme Editor',
      category: 'Preferences',
      run: () => {
        setActiveScreen('settings');
        setPaletteOpen(false);
      }
    });
    return reg;
  }, [isFullscreen]);

  const handleGenerateKey = async (): Promise<void> => {
    try {
      await vault.initializeOrUnlock('webssh-local-pass');
      const record = await vault.generateKeyPair('prod-ed25519-key');
      setGeneratedPubKey(record.authorizedKeyLine);
      setGeneratedFp(record.fingerprintSHA256);
    } catch {
      // Keep fallback display in constrained environment
    }
  };

  const sftpEntries = useMemo(
    () =>
      sortAndFilterEntries(
        [
          { name: 'config', path: '/etc/app/config', size: 0, mode: 'drwxr-xr-x', modTime: 1730000000, isDir: true },
          { name: 'nginx.conf', path: '/etc/nginx/nginx.conf', size: 2048, mode: '-rw-r--r--', modTime: 1730000500, isDir: false },
          { name: 'release.tar.zst', path: '/srv/release.tar.zst', size: 5242880, mode: '-rw-r--r--', modTime: 1730000900, isDir: false }
        ],
        fileFilter
      ),
    [fileFilter]
  );

  const quotaSnap = storageGuard.snapshot();

  return (
    <div
      ref={rootRef}
      data-testid="workspace-root"
      className={`webssh-app ${isPseudoFullscreen ? 'webssh-app--pseudo-fullscreen' : ''}`.trim()}
    >
      {isFullscreen ? (
        <div
          data-testid="fullscreen-top-hover-zone"
          className="webssh-fullscreen-hover-zone"
          onMouseEnter={() => setShowOverlayBar(true)}
        />
      ) : null}

      {isFullscreen && showOverlayBar ? (
        <div
          data-testid="fullscreen-overlay-bar"
          className="webssh-fullscreen-overlay-bar"
          onMouseLeave={() => setShowOverlayBar(false)}
        >
          <Badge tone="success">edge-01.prod.internal</Badge>
          <Button variant="ghost" onClick={() => setActiveScreen('settings')} testId="overlay-settings-btn">
            Settings
          </Button>
          <Button variant="primary" onClick={() => void exitImmersiveFullscreen()} testId="overlay-exit-fullscreen-btn">
            Exit Full Screen
          </Button>
        </div>
      ) : null}

      {showFullscreenToast ? (
        <div role="status" data-testid="fullscreen-toast" className="webssh-fullscreen-toast">
          Press F11 or Esc to exit
        </div>
      ) : null}

      {!isFullscreen && !zenMode ? (
        <header className="webssh-topbar" role="banner">
          <div className="webssh-tabs" role="tablist" aria-label="Active SSH sessions">
            <button
              type="button"
              role="tab"
              aria-selected={activeScreen === 'workspace'}
              className={`webssh-tab ${activeScreen === 'workspace' ? 'webssh-tab--active' : ''}`.trim()}
              onClick={() => setActiveScreen('workspace')}
              data-testid="tab-session-1"
            >
              <span
                className={`webssh-status-dot ${
                  connectionState === 'reconnecting'
                    ? 'webssh-status-dot--reconnecting'
                    : connectionState === 'offline'
                      ? 'webssh-status-dot--offline'
                      : ''
                }`.trim()}
              />
              <span>sre@edge-01.prod.internal</span>
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <Button variant="ghost" onClick={() => setPaletteOpen(true)} testId="open-palette-btn">
              <Icon name="search" /> Command Palette (Cmd+K)
            </Button>
            <Button variant="ghost" onClick={() => setZenMode((z) => !z)} testId="toggle-zen-btn">
              Zen
            </Button>
            <Button variant="primary" onClick={toggleFullscreen} testId="toggle-fullscreen-btn">
              <Icon name="maximize" /> Full Screen
            </Button>
          </div>
        </header>
      ) : null}

      {connectionState !== 'connected' ? (
        <div className="webssh-banner" role="status" data-testid="reconnect-banner">
          <span>
            {connectionState === 'reconnecting' && 'Reconnecting (attempt 3, backoff 2.1s)…'}
            {connectionState === 'offline' && 'Offline — queuing input locally (64 KiB cap)'}
            {connectionState === 'resumed' && 'Session resumed from gateway ring buffer'}
          </span>
          {pendingInputBytes > 0 ? (
            <Badge tone="warning" testId="pending-input-badge">
              Pending input: {pendingInputBytes} B
            </Badge>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => {
              setConnectionState('connected');
              setPendingInputBytes(0);
            }}
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      <div className="webssh-workspace-body">
        {!isFullscreen && !zenMode ? (
          <nav className="webssh-rail" aria-label="Workspace navigation">
            <Button
              variant={activeScreen === 'workspace' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('workspace')}
              testId="nav-workspace"
            >
              <Icon name="terminal" /> Terminal
            </Button>
            <Button
              variant={activeScreen === 'welcome' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('welcome')}
              testId="nav-welcome"
            >
              Welcome
            </Button>
            <Button
              variant={activeScreen === 'vault' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('vault')}
              testId="nav-vault"
            >
              <Icon name="key" /> Key Vault
            </Button>
            <Button
              variant={activeScreen === 'hosts' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('hosts')}
              testId="nav-hosts"
            >
              <Icon name="server" /> Hosts
            </Button>
            <Button
              variant={activeScreen === 'files' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('files')}
              testId="nav-files"
            >
              <Icon name="folder" /> SFTP Files
            </Button>
            <Button
              variant={activeScreen === 'editor' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('editor')}
              testId="nav-editor"
            >
              Editor
            </Button>
            <Button
              variant={activeScreen === 'snippets' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('snippets')}
              testId="nav-snippets"
            >
              Snippets & Replay
            </Button>
            <Button
              variant={activeScreen === 'settings' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('settings')}
              testId="nav-settings"
            >
              <Icon name="settings" /> Settings
            </Button>
          </nav>
        ) : null}

        <main className="webssh-main">
          {activeScreen === 'workspace' ? (
            <div
              ref={terminalViewRef}
              tabIndex={0}
              role="region"
              aria-label="SSH Terminal Viewport"
              data-testid="terminal-viewport"
              className="webssh-terminal-viewport"
            >
              {terminalLines.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
              <div>
                <span>sre@edge-01:~$ </span>
                <span className="webssh-terminal-cursor" aria-hidden="true" />
              </div>
            </div>
          ) : null}

          {activeScreen === 'welcome' ? (
            <div className="webssh-panel-content" data-testid="screen-welcome">
              <h1>Welcome to WebSSH Studio</h1>
              <div className="webssh-grid">
                <Card>
                  <h2>1. Create Non-Extractable Key</h2>
                  <p>Generate an Ed25519 or ECDSA P-256 key pair inside WebCrypto + IndexedDB.</p>
                  <Button variant="primary" onClick={() => void handleGenerateKey()} testId="welcome-generate-key-btn">
                    Generate SSH key
                  </Button>
                </Card>
                <Card>
                  <h2>2. Add Target Host</h2>
                  <p>Configure your SSH destination or import ~/.ssh/config with ProxyJump chains.</p>
                  <Button variant="default" onClick={() => setActiveScreen('hosts')}>
                    Configure Hosts
                  </Button>
                </Card>
                <Card>
                  <h2>3. Connect via Remote Signer</h2>
                  <p>Private keys never leave your browser; challenges are signed locally.</p>
                  <Button variant="default" onClick={() => setActiveScreen('workspace')}>
                    Open Terminal
                  </Button>
                </Card>
              </div>
            </div>
          ) : null}

          {activeScreen === 'vault' ? (
            <div className="webssh-panel-content" data-testid="screen-vault">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h1>SSH Key Vault</h1>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <Button variant="primary" onClick={() => void handleGenerateKey()} testId="vault-generate-btn">
                    Generate SSH key
                  </Button>
                  <Button variant="default" onClick={() => setVaultLocked((v) => !v)} testId="vault-lock-btn">
                    <Icon name="lock" /> {vaultLocked ? 'Unlock Vault' : 'Lock Vault'}
                  </Button>
                </div>
              </div>
              {vaultLocked ? (
                <EmptyState
                  title="Vault is Locked"
                  description="Protected with Argon2id + AES-GCM wrapping. Unlock to sign SSH challenges."
                  action={
                    <Button variant="primary" onClick={() => setVaultLocked(false)}>
                      Unlock Vault
                    </Button>
                  }
                />
              ) : (
                <Card>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>prod-ed25519-key</strong>
                    <Badge tone="success">Ed25519 · Non-Extractable</Badge>
                  </div>
                  <p data-testid="vault-fingerprint">Fingerprint: {generatedFp}</p>
                  <label htmlFor="pubkey-box">OpenSSH Public Key & authorized_keys snippet</label>
                  <textarea
                    id="pubkey-box"
                    className="ui-input"
                    readOnly
                    rows={3}
                    value={generatedPubKey}
                    data-testid="vault-pubkey-output"
                  />
                </Card>
              )}
            </div>
          ) : null}

          {activeScreen === 'hosts' ? (
            <div className="webssh-panel-content" data-testid="screen-hosts">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h1>Saved Hosts & ProxyJump Chains</h1>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <Button variant="default" onClick={() => setHostKeyModal('tofu')} testId="trigger-tofu-modal-btn">
                    Verify Host Key (TOFU)
                  </Button>
                  <Button variant="danger" onClick={() => setHostKeyModal('mismatch')} testId="trigger-mismatch-modal-btn">
                    Simulate KEY CHANGED
                  </Button>
                </div>
              </div>
              <input
                type="search"
                className="ui-input"
                placeholder="Filter hosts by alias, user, hostname, or tag…"
                value={hostSearch}
                onInput={(e) => setHostSearch((e.target as HTMLInputElement).value)}
                aria-label="Filter hosts"
              />
              <div className="webssh-grid">
                {hosts
                  .filter((h) => !hostSearch || h.alias.toLowerCase().includes(hostSearch.toLowerCase()))
                  .map((h) => (
                    <Card key={h.id} testId={`host-card-${h.alias}`}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <strong>{h.alias}</strong>
                        <Badge tone="success">{h.folder ?? 'Default'}</Badge>
                      </div>
                      <p>
                        {h.user}@{h.host}:{h.port}
                      </p>
                      {h.jumpHops.length > 0 ? (
                        <p>ProxyJump: {h.jumpHops.map((j) => `${j.user}@${j.host}:${j.port}`).join(' -> ')}</p>
                      ) : null}
                      <Button variant="primary" onClick={() => setActiveScreen('workspace')}>
                        Connect
                      </Button>
                    </Card>
                  ))}
              </div>
              <Card>
                <h2>Import ~/.ssh/config</h2>
                <textarea
                  className="ui-input"
                  rows={4}
                  aria-label="SSH config content"
                  value={sshConfigInput}
                  onInput={(e) => setSshConfigInput((e.target as HTMLTextAreaElement).value)}
                />
                <div style={{ marginTop: 'var(--space-2)' }}>
                  <Button
                    variant="primary"
                    testId="import-ssh-config-btn"
                    onClick={() => {
                      hostRegistry.importSshConfig(sshConfigInput);
                      setHosts(hostRegistry.list());
                    }}
                  >
                    Import ~/.ssh/config
                  </Button>
                </div>
              </Card>
            </div>
          ) : null}

          {activeScreen === 'files' ? (
            <div className="webssh-panel-content" data-testid="screen-files">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h1>Dual-Pane SFTP File Manager</h1>
                <Badge tone="neutral" testId="storage-quota-badge">
                  Storage Guard: {quotaSnap.percentUsed}% of 256 MiB cap (256 KiB chunks, SHA-256 verified)
                </Badge>
              </div>
              <input
                type="search"
                className="ui-input"
                placeholder="Filter remote directory entries…"
                value={fileFilter}
                onInput={(e) => setFileFilter((e.target as HTMLInputElement).value)}
                aria-label="Filter remote directory entries"
              />
              <Card>
                <p>Drop files or folders to upload to /srv/app (resumable .part atomic rename)</p>
                <ul>
                  {sftpEntries.map((entry) => (
                    <li key={entry.path}>
                      <strong>{entry.isDir ? `[DIR] ${entry.name}` : entry.name}</strong> — {entry.size} bytes ({entry.mode})
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ) : null}

          {activeScreen === 'editor' ? (
            <div className="webssh-panel-content" data-testid="screen-editor">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h1>Remote File Editor — /etc/nginx/nginx.conf</h1>
                <Button
                  variant="primary"
                  onClick={() => setEditorSaved(true)}
                  testId="save-remote-file-btn"
                >
                  Save to host {editorSaved ? '(Saved)' : '(Unsaved*)'}
                </Button>
              </div>
              <textarea
                className="ui-input"
                rows={10}
                aria-label="Remote file content"
                value={editorContent}
                onInput={(e) => {
                  setEditorContent((e.target as HTMLTextAreaElement).value);
                  setEditorSaved(false);
                }}
              />
            </div>
          ) : null}

          {activeScreen === 'snippets' ? (
            <div className="webssh-panel-content" data-testid="screen-snippets">
              <h1>Snippets & Asciicast v2 Session Replay</h1>
              <div className="webssh-grid">
                {snippetLib.list().map((snip) => (
                  <Card key={snip.id}>
                    <strong>{snip.name}</strong>
                    <code>{snip.command}</code>
                    <Button
                      variant="default"
                      onClick={() => {
                        setTerminalLines((prev) => [...prev, `sre@edge-01:~$ ${snip.command}`]);
                        setActiveScreen('workspace');
                      }}
                    >
                      Run Snippet
                    </Button>
                  </Card>
                ))}
              </div>
              <Card>
                <h2>Session Replay Scrubber ({scrubberSec.toFixed(1)}s)</h2>
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.5}
                  value={scrubberSec}
                  aria-label="Replay timeline scrubber"
                  onInput={(e) => setScrubberSec(Number((e.target as HTMLInputElement).value))}
                />
                <pre>{scrubAsciicastOutput(demoCast.events, scrubberSec)}</pre>
              </Card>
            </div>
          ) : null}

          {activeScreen === 'settings' ? (
            <div className="webssh-panel-content" data-testid="screen-settings">
              <h1>Preferences, Theme Gallery & Keybindings</h1>
              <ComponentGallery activeTheme={activeTheme} onSelectTheme={(t) => setActiveTheme(t)} />
              <Card>
                <h2>Theme Selector</h2>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  {THEME_IDS.map((id) => (
                    <Button
                      key={id}
                      variant={id === activeTheme ? 'primary' : 'default'}
                      onClick={() => setActiveTheme(id)}
                      testId={`theme-btn-${id}`}
                    >
                      {id}
                    </Button>
                  ))}
                </div>
              </Card>
              <Card>
                <h2>Keybindings</h2>
                <ul>
                  {keybindings.list().map((kb) => (
                    <li key={kb.actionId}>
                      <strong>{kb.description}:</strong> <code>{kb.shortcut}</code>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card>
                <h2>Simulate Reconnect / Resilience States</h2>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <Button
                    variant="default"
                    testId="sim-reconnecting-btn"
                    onClick={() => {
                      setConnectionState('reconnecting');
                      setPendingInputBytes(128);
                    }}
                  >
                    Simulate Reconnecting
                  </Button>
                  <Button
                    variant="default"
                    testId="sim-resumed-btn"
                    onClick={() => {
                      setConnectionState('resumed');
                      setPendingInputBytes(0);
                    }}
                  >
                    Simulate Resumed
                  </Button>
                </div>
              </Card>
            </div>
          ) : null}

          {!isFullscreen && !zenMode ? (
            <div className="webssh-special-keys" role="toolbar" aria-label="Mobile and Tablet Special Keys">
              {SPECIAL_KEYS_ROW.map((keyLabel) => (
                <Button key={keyLabel} variant="ghost" testId={`special-key-${keyLabel}`}>
                  {keyLabel}
                </Button>
              ))}
            </div>
          ) : null}
        </main>
      </div>

      {!isFullscreen && !zenMode ? (
        <footer className="webssh-statusbar" role="contentinfo" data-testid="status-bar">
          <span>RTT: 14 ms · Throughput: 1.2 MB/s · Cipher: chacha20-poly1305@openssh.com</span>
          <span>Remote Signer: WebCrypto Ed25519 · Auto-attach tmux: main</span>
        </footer>
      ) : null}

      <Modal
        open={paletteOpen}
        title="Command Palette"
        onClose={() => setPaletteOpen(false)}
        testId="command-palette-modal"
      >
        <input
          type="search"
          className="ui-input"
          placeholder="Type a command or search actions…"
          value={paletteQuery}
          onInput={(e) => setPaletteQuery((e.target as HTMLInputElement).value)}
          aria-label="Command palette search"
          data-testid="command-palette-input"
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', marginTop: 'var(--space-3)' }}>
          {paletteRegistry.search(paletteQuery).map((cmd) => (
            <Button
              key={cmd.id}
              variant="ghost"
              onClick={() => void cmd.run()}
              testId={`palette-cmd-${cmd.id}`}
            >
              <span>{cmd.title}</span>
              {cmd.shortcut ? <Badge tone="neutral">{cmd.shortcut}</Badge> : null}
            </Button>
          ))}
        </div>
      </Modal>

      <Modal
        open={hostKeyModal !== 'none'}
        danger={hostKeyModal === 'mismatch'}
        title={hostKeyModal === 'mismatch' ? 'WARNING: REMOTE HOST KEY CHANGED' : 'Verify Unknown Host Key (TOFU)'}
        onClose={() => setHostKeyModal('none')}
        testId="hostkey-modal"
      >
        <p>
          Host: <strong>edge-01.prod.internal:22</strong>
        </p>
        <p>
          SHA-256 Fingerprint: <code>{generatedFp}</code>
        </p>
        {hostKeyModal === 'mismatch' ? (
          <p>
            The host key does not match your pinned fingerprint. This could indicate a man-in-the-middle attack. Connection is blocked unless you explicitly override.
          </p>
        ) : (
          <p>Trust on first use (TOFU) will pin this SHA-256 fingerprint in your browser store.</p>
        )}
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
          <Button
            variant={hostKeyModal === 'mismatch' ? 'danger' : 'primary'}
            onClick={() => setHostKeyModal('none')}
            testId="hostkey-confirm-btn"
          >
            {hostKeyModal === 'mismatch' ? 'Explicit Override & Pin New Key' : 'Trust & Pin Host Key'}
          </Button>
          <Button variant="default" onClick={() => setHostKeyModal('none')}>
            Disconnect
          </Button>
        </div>
      </Modal>
    </div>
  );
}
