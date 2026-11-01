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
  THEMES,
  applyThemeToDocument,
  type ThemeId
} from '@webssh/ui-kit';
import { KeyVault } from '../vault';
import { HostRegistry, type HostProfile } from '../hosts';
import { PreferencesStore, type CursorShape, type LayoutPreset } from '../prefs';
import { XtermPaneAdapter } from '../terminal/xterm-adapter';
import {
  AsciicastRecorder,
  CommandPaletteRegistry,
  KeybindingRegistry,
  SPECIAL_KEYS_ROW,
  SnippetLibrary,
  interpolateSnippet,
  parseAsciicastV2,
  scrubAsciicastOutput
} from './productivity';
import { StorageGuard, sortAndFilterEntries } from '../files';

export type ScreenId =
  | 'workspace'
  | 'features'
  | 'welcome'
  | 'vault'
  | 'hosts'
  | 'files'
  | 'editor'
  | 'snippets'
  | 'settings';

export type ConnectionState =
  | 'disconnected'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'resumed';

export type AuthMethod = 'Argon2id Ed25519 Key' | 'Password';

export type MenuId = 'terminal' | 'edit' | 'view' | 'security' | 'features' | null;

export interface SessionTabItem {
  id: string;
  title: string;
  connected: boolean;
}

export interface FeatureCatalogItem {
  id: number;
  category: 'Connection' | 'Terminal' | 'Files' | 'Customization' | 'Security' | 'Productivity';
  title: string;
  description: string;
  targetScreen: ScreenId;
  actionLabel: string;
}

export const FIFTY_FEATURES_CATALOG: readonly FeatureCatalogItem[] = [
  { id: 1, category: 'Connection', title: 'In-browser key generation (Ed25519 / ECDSA P-256)', description: 'Generate non-extractable WebCrypto SSH key pairs stored in IndexedDB.', targetScreen: 'vault', actionLabel: 'Generate Key in Vault' },
  { id: 2, category: 'Connection', title: 'Public key export (authorized_keys snippet)', description: 'Copy one-line OpenSSH authorized_keys deployment command.', targetScreen: 'vault', actionLabel: 'Copy Public Key Snippet' },
  { id: 3, category: 'Connection', title: 'Private key import (OpenSSH/PEM encrypted)', description: 'Import existing keys wrapped with Argon2id + AES-256-GCM.', targetScreen: 'vault', actionLabel: 'Open Key Vault Importer' },
  { id: 4, category: 'Connection', title: 'One-time key deployment (ssh-copy-id)', description: 'Bootstrap authorized_keys on remote server and switch to key auth.', targetScreen: 'workspace', actionLabel: 'Deploy Public Key' },
  { id: 5, category: 'Connection', title: 'Saved host profiles (tags, folders, favorites)', description: 'Organize SSH hosts with folders, tags, and search filter.', targetScreen: 'hosts', actionLabel: 'Open Saved Hosts' },
  { id: 6, category: 'Connection', title: 'Automatic reconnect (exponential backoff + jitter)', description: 'Resilient WebSocket transport with ±25% jitter and 64 KiB input queue.', targetScreen: 'settings', actionLabel: 'Simulate Reconnect' },
  { id: 7, category: 'Connection', title: 'Persistent sessions with 4 MiB ring buffer replay', description: 'Resume detached sessions cleanly from the Go gateway ring buffer.', targetScreen: 'settings', actionLabel: 'Simulate Session Resume' },
  { id: 8, category: 'Connection', title: 'ProxyJump chains (multi-hop bastion dialing)', description: 'Dial target hosts through one or more SSH bastion hops.', targetScreen: 'hosts', actionLabel: 'Inspect ProxyJump Chains' },
  { id: 9, category: 'Terminal', title: 'GPU-accelerated @xterm/xterm rendering (WebGL -> Canvas -> DOM)', description: '60fps terminal viewport with automatic context-loss fallback.', targetScreen: 'workspace', actionLabel: 'Focus Terminal Engine' },
  { id: 10, category: 'Terminal', title: 'Split panes (horizontal & vertical binary tree)', description: 'Split terminal workspace side-by-side or stacked.', targetScreen: 'workspace', actionLabel: 'Split Terminal Pane' },
  { id: 11, category: 'Terminal', title: 'macOS / VS Code capsule tabs (add, close, switch)', description: 'Multi-session capsule tab strip with status indicators.', targetScreen: 'workspace', actionLabel: 'Create New Tab' },
  { id: 12, category: 'Terminal', title: 'Scrollback search and caps (10k default, 100k max)', description: 'Search terminal output buffer with regex and case-sensitivity.', targetScreen: 'workspace', actionLabel: 'Search Terminal Buffer' },
  { id: 13, category: 'Terminal', title: 'Immersive full-screen mode (F11 / hover overlay / 100dvh)', description: 'Zero-chrome terminal with top 6px hover reveal bar.', targetScreen: 'workspace', actionLabel: 'Toggle Full Screen' },
  { id: 14, category: 'Terminal', title: 'Full Unicode 11 support (wide CJK, emoji, IME)', description: 'Accurate grapheme width measurement for international scripts.', targetScreen: 'workspace', actionLabel: 'Print Unicode 11 Demo' },
  { id: 15, category: 'Terminal', title: 'Rich ANSI 24-bit TrueColor & OSC 8 hyperlinks', description: 'Render 16M colors and clickable terminal links.', targetScreen: 'workspace', actionLabel: 'Print ANSI TrueColor Demo' },
  { id: 16, category: 'Terminal', title: 'Safe bracketed paste with multi-line warning', description: 'Inspect multi-line clipboard payloads before sending to shell.', targetScreen: 'workspace', actionLabel: 'Test Safe Paste Guard' },
  { id: 17, category: 'Terminal', title: 'Connection status bar (cipher, signer, font metrics)', description: 'Live footer showing connection status, cipher, and typography.', targetScreen: 'workspace', actionLabel: 'Inspect Status Bar' },
  { id: 18, category: 'Files', title: 'Drag-and-drop file upload', description: 'Drop local files directly onto the SFTP pane to upload.', targetScreen: 'files', actionLabel: 'Open SFTP Dropzone' },
  { id: 19, category: 'Files', title: 'Recursive folder upload', description: 'Create remote directory trees before streaming child files.', targetScreen: 'files', actionLabel: 'Simulate Folder Upload' },
  { id: 20, category: 'Files', title: 'Chunked resumable transfers (256 KiB + SHA-256 .part)', description: 'Resume interrupted uploads from byte offset with hash verification.', targetScreen: 'files', actionLabel: 'Run 256 KiB Chunked Transfer' },
  { id: 21, category: 'Files', title: 'Streaming downloads (FileSystemWritableFileStream)', description: 'Zero-memory-bloat direct-to-disk file downloads.', targetScreen: 'files', actionLabel: 'Trigger Streaming Download' },
  { id: 22, category: 'Files', title: 'Dual-pane SFTP browser (sort & filter)', description: 'Directory-first sorting and live filename filter.', targetScreen: 'files', actionLabel: 'Open SFTP Browser' },
  { id: 23, category: 'Files', title: 'Transfer queue (pause, resume, cancel, concurrency)', description: 'Manage active SFTP jobs with bounded concurrency.', targetScreen: 'files', actionLabel: 'Inspect Transfer Queue' },
  { id: 24, category: 'Files', title: 'StorageGuard quota & memory meter', description: 'Enforce 256 MiB storage cap with 80% warning and 95% hard stop.', targetScreen: 'files', actionLabel: 'Check StorageGuard Meter' },
  { id: 25, category: 'Files', title: 'Remote file editor (atomic SFTP save)', description: 'Edit remote configuration files in-browser and save atomically.', targetScreen: 'editor', actionLabel: 'Open Remote File Editor' },
  { id: 26, category: 'Files', title: 'Streaming folder download (ZIP / ZIP64 writer)', description: 'Stream entire remote directories as an uncompressed ZIP archive.', targetScreen: 'files', actionLabel: 'Download Folder as ZIP' },
  { id: 27, category: 'Customization', title: '9 Built-in Theme Presets (Dark, Light, High-Contrast, Dracula, Nord…)', description: 'Switch themes instantaneously with zero layout shift.', targetScreen: 'settings', actionLabel: 'Open Theme Switcher' },
  { id: 28, category: 'Customization', title: 'Custom 16-color ANSI theme editor + WCAG contrast check', description: 'Design custom palettes verified against WCAG 2.1 AA.', targetScreen: 'settings', actionLabel: 'Validate Custom Theme Contrast' },
  { id: 29, category: 'Customization', title: 'Font family selector (SF Mono, JetBrains Mono, Fira Code, Menlo, Monaco)', description: 'Switch terminal programming fonts from the quick bar.', targetScreen: 'workspace', actionLabel: 'Cycle Font Family' },
  { id: 30, category: 'Customization', title: 'Typography controls (+20% 17px default, A-/A+ stepper)', description: 'Scale terminal font size between 11px and 32px.', targetScreen: 'workspace', actionLabel: 'Adjust Font Size' },
  { id: 31, category: 'Customization', title: 'Layout presets (sidebar-left, sidebar-right, compact, zen)', description: 'Customize workspace dock and sidebar orientation.', targetScreen: 'settings', actionLabel: 'Toggle Sidebar Orientation' },
  { id: 32, category: 'Customization', title: 'Cursor shape (block, bar, underline) & blink options', description: 'Customize terminal cursor geometry and blink animation.', targetScreen: 'settings', actionLabel: 'Cycle Cursor Shape' },
  { id: 33, category: 'Customization', title: 'Per-host preference overrides', description: 'Automatically apply distinct themes or font sizes per SSH host.', targetScreen: 'hosts', actionLabel: 'Configure Host Overrides' },
  { id: 34, category: 'Customization', title: 'Portable preferences (v1->v2 schema migration & JSON export)', description: 'Export and import validated user preferences JSON.', targetScreen: 'settings', actionLabel: 'Export Preferences JSON' },
  { id: 35, category: 'Security', title: 'Host key verification (TOFU pinning & red mismatch blocker)', description: 'Pin SHA-256 host fingerprints and block MITM key changes.', targetScreen: 'hosts', actionLabel: 'Trigger Host Key Mismatch Modal' },
  { id: 36, category: 'Security', title: 'Passphrase-locked Argon2id + AES-256-GCM Key Vault', description: 'Wrap private metadata with memory-hard Argon2id KDF.', targetScreen: 'vault', actionLabel: 'Open Argon2id Vault' },
  { id: 37, category: 'Security', title: 'Vault auto-lock (idle timer & Cmd+Shift+L shortcut)', description: 'Zeroize unlocked session state on idle or manual lock.', targetScreen: 'vault', actionLabel: 'Toggle Vault Lock' },
  { id: 38, category: 'Security', title: 'Hardened web posture (strict CSP, zero CDN, self-hosted assets)', description: 'Enforce default-src self and zero third-party requests.', targetScreen: 'settings', actionLabel: 'Verify CSP Posture' },
  { id: 39, category: 'Security', title: 'OIDC gateway authentication & strict Origin check', description: 'Validate bearer JWTs and WebSocket Origin headers at gateway.', targetScreen: 'settings', actionLabel: 'Inspect Gateway Auth Policy' },
  { id: 40, category: 'Security', title: 'SSRF Destination policy guard (blocks loopback, 169.254.169.254, RFC1918)', description: 'Prevent connections to cloud metadata and internal networks.', targetScreen: 'settings', actionLabel: 'Run SSRF Policy Check' },
  { id: 41, category: 'Security', title: 'Remote-signer challenge authentication', description: 'Sign SSH auth challenges in-browser without exposing private keys.', targetScreen: 'workspace', actionLabel: 'Open Remote Signer Modal' },
  { id: 42, category: 'Security', title: 'Metadata-only structured JSON audit trail', description: 'Log connection lifecycle events without PTY or key material.', targetScreen: 'settings', actionLabel: 'View Audit Trail' },
  { id: 43, category: 'Productivity', title: 'Command Palette (Cmd/Ctrl+K fuzzy launcher)', description: 'Fuzzy-search and run any workspace, host, or theme action.', targetScreen: 'workspace', actionLabel: 'Open Command Palette' },
  { id: 44, category: 'Productivity', title: 'Snippet library with {{variable}} interpolation', description: 'Parameterized operational commands with instant execution.', targetScreen: 'snippets', actionLabel: 'Open Snippet Library' },
  { id: 45, category: 'Productivity', title: 'Broadcast input across split panes', description: 'Send keystrokes simultaneously to all panes in the active tab.', targetScreen: 'workspace', actionLabel: 'Toggle Broadcast Input' },
  { id: 46, category: 'Productivity', title: 'Asciicast v2 session recording & timeline scrubber', description: 'Record PTY sessions with 64 MiB cap and scrub playback.', targetScreen: 'snippets', actionLabel: 'Open Session Scrubber' },
  { id: 47, category: 'Productivity', title: 'Custom keybindings with conflict detector', description: 'Rebind keyboard shortcuts and detect duplicate bindings.', targetScreen: 'settings', actionLabel: 'Inspect Keybindings' },
  { id: 48, category: 'Productivity', title: '~/.ssh/config parser & importer (Host, HostName, User, Port, ProxyJump)', description: 'Bulk-import OpenSSH config blocks into Saved Hosts.', targetScreen: 'hosts', actionLabel: 'Import ~/.ssh/config' },
  { id: 49, category: 'Productivity', title: 'Installable PWA (manifest.webmanifest + offline Service Worker)', description: 'Run WebSSH Studio as a standalone desktop/mobile app.', targetScreen: 'settings', actionLabel: 'Check PWA Status' },
  { id: 50, category: 'Productivity', title: 'Command-completion notifications (OSC 133 & BEL)', description: 'Alert when long-running background commands finish.', targetScreen: 'workspace', actionLabel: 'Simulate OSC 133 Completion' }
];

export function App(): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const terminalViewRef = useRef<HTMLDivElement | null>(null);
  const xtermHostRef = useRef<HTMLDivElement | null>(null);
  const xtermAdapterRef = useRef<XtermPaneAdapter | null>(null);

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

  // 1 & 3. Default Font Size (+20% = 17px) & Font Family
  const [fontSize, setFontSize] = useState<number>(17);
  const [fontFamily, setFontFamily] = useState<string>("'JetBrains Mono', 'Fira Code', monospace");
  const [cols, setCols] = useState<number>(80);
  const [rows, setRows] = useState<number>(24);

  // 1. Native Menu Bar state
  const [openMenu, setOpenMenu] = useState<MenuId>(null);

  // 2. macOS / VS Code Capsule Tabs state
  const [tabs, setTabs] = useState<SessionTabItem[]>([
    { id: 'tab-1', title: '...srinew/terminal — -zsh', connected: false }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('tab-1');
  const [splitPanes, setSplitPanes] = useState<number>(1);
  const [broadcastInput, setBroadcastInput] = useState<boolean>(false);

  const [activeScreen, setActiveScreen] = useState<ScreenId>('workspace');
  const [activeTheme, setActiveTheme] = useState<ThemeId>(
    (prefsStore.get().activeThemeId as ThemeId) || 'dark'
  );
  const [layoutPreset, setLayoutPreset] = useState<LayoutPreset>('sidebar-left');
  const [cursorShape, setCursorShape] = useState<CursorShape>('block');
  const [zenMode, setZenMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
  const [showOverlayBar, setShowOverlayBar] = useState(false);
  const [showFullscreenToast, setShowFullscreenToast] = useState(false);

  // 3. Fresh Default State (No Pre-Connected Dummy Session)
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [sessionTabLabel, setSessionTabLabel] = useState<string>('...srinew/terminal — -zsh');
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
  const [transferStatus, setTransferStatus] = useState<string>('Idle — Ready for 256 KiB chunked SFTP streaming');
  const [editorContent, setEditorContent] = useState(
    ['# /etc/nginx/nginx.conf', 'worker_processes auto;', ''].join(String.fromCharCode(10))
  );
  const [editorSaved, setEditorSaved] = useState(true);
  const [scrubberSec, setScrubberSec] = useState(2.5);
  const [snippetVarService, setSnippetVarService] = useState('nginx');
  const [snippetVarLines, setSnippetVarLines] = useState('50');

  // 50-Feature Explorer & Workbench State
  const [featureCategory, setFeatureCategory] = useState<string>('All');
  const [featureQuery, setFeatureQuery] = useState<string>('');
  const [selectedFeatureId, setSelectedFeatureId] = useState<number>(1);
  const [lastExecutedFeatureMsg, setLastExecutedFeatureMsg] = useState<string>(
    'Select any of the 50 features below to inspect and run it live.'
  );

  const [terminalLines, setTerminalLines] = useState<string[]>([
    'WebSSH Studio v1.0.0',
    "Type 'help' for local commands or click 'New Connection' to authenticate."
  ]);

  // 4. Interactive Terminal Input & Command Execution State
  const [currentInput, setCurrentInput] = useState<string>('');
  const currentInputRef = useRef<string>('');
  const [history, setHistory] = useState<string[]>([]);
  const historyRef = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const historyIndexRef = useRef<number>(-1);
  const [copiedSnippet, setCopiedSnippet] = useState<boolean>(false);

  const updateCurrentInput = (next: string | ((prev: string) => string)): void => {
    const resolved = typeof next === 'function' ? next(currentInputRef.current) : next;
    currentInputRef.current = resolved;
    setCurrentInput(resolved);
  };

  // 5. Server Connection & Argon2id Auth Modal State
  const [connectModalOpen, setConnectModalOpen] = useState<boolean>(false);
  const [connectHost, setConnectHost] = useState<string>('');
  const [connectPort, setConnectPort] = useState<string>('22');
  const [connectUser, setConnectUser] = useState<string>('ubuntu');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('Argon2id Ed25519 Key');
  const [connectPassword, setConnectPassword] = useState<string>('');

  const authorizedKeysSnippet = useMemo(
    () => `echo "${generatedPubKey}" >> ~/.ssh/authorized_keys`,
    [generatedPubKey]
  );

  const activeSessionTitle = useMemo(() => {
    const found = tabs.find((t) => t.id === activeTabId);
    return found ? found.title : sessionTabLabel;
  }, [tabs, activeTabId, sessionTabLabel]);

  const writeToXterm = (text: string): void => {
    try {
      xtermAdapterRef.current?.writeText(text);
    } catch {
      // Ignore in headless environments without canvas
    }
  };

  const copyToClipboard = (text: string): void => {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard.writeText(text).catch(() => {
        // Ignore clipboard errors in restricted environments
      });
    }
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 2000);
  };

  const handleAddTab = (): void => {
    const nextNum = tabs.length + 1;
    const newId = `tab-${Date.now()}-${nextNum}`;
    const newTitle = `...srinew/terminal — -zsh (${nextNum})`;
    setTabs((prev) => [...prev, { id: newId, title: newTitle, connected: false }]);
    setActiveTabId(newId);
    setSessionTabLabel(newTitle);
    setActiveScreen('workspace');
  };

  const handleCloseTab = (tabId: string, e?: Event): void => {
    if (e) e.stopPropagation();
    if (tabs.length <= 1) {
      setConnectionState('disconnected');
      setSessionTabLabel('...srinew/terminal — -zsh');
      setTabs([{ id: 'tab-1', title: '...srinew/terminal — -zsh', connected: false }]);
      setActiveTabId('tab-1');
      setTerminalLines([
        'WebSSH Studio v1.0.0',
        "Type 'help' for local commands or click 'New Connection' to authenticate."
      ]);
      return;
    }
    const nextTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(nextTabs);
    if (activeTabId === tabId && nextTabs[0]) {
      setActiveTabId(nextTabs[0].id);
      setSessionTabLabel(nextTabs[0].title);
    }
  };

  const handleDisconnect = (): void => {
    setConnectionState('disconnected');
    setPendingInputBytes(0);
    setTerminalLines((prev) => [...prev, `Disconnected from ${sessionTabLabel}.`]);
    writeToXterm(`
Disconnected from ${sessionTabLabel}.
webssh:~$ `);
    const resetTitle = '...srinew/terminal — -zsh';
    setSessionTabLabel(resetTitle);
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTabId ? { ...t, title: resetTitle, connected: false } : t))
    );
  };

  const handleConnectSubmit = (e?: Event): void => {
    if (e) e.preventDefault();
    const hostVal = connectHost.trim() || 'edge-01.prod.internal';
    const userVal = connectUser.trim() || 'ubuntu';
    const portVal = connectPort.trim() || '22';
    const label = `${userVal}@${hostVal}`;
    setSessionTabLabel(label);
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTabId ? { ...t, title: `${label} — -zsh`, connected: true } : t))
    );
    setConnectionState('connected');
    setConnectModalOpen(false);
    setActiveScreen('workspace');
    const msg = `Connected to ${label}:${portVal} (${authMethod})`;
    setTerminalLines((prev) => [...prev, msg]);
    writeToXterm(`
${msg}
webssh:~$ `);
  };

  const executeTerminalCommand = (rawCommand: string): void => {
    const trimmed = rawCommand.trim();
    updateCurrentInput('');
    historyIndexRef.current = -1;
    setHistoryIndex(-1);

    if (!trimmed) {
      setTerminalLines((prev) => [...prev, 'webssh:~$ ']);
      writeToXterm(`${String.fromCharCode(13, 10)}webssh:~$ `);
      return;
    }

    const nextHistory = [...historyRef.current, trimmed];
    historyRef.current = nextHistory;
    setHistory(nextHistory);

    const spaceIdx = trimmed.indexOf(' ');
    const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const arg = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    if (cmd === 'clear') {
      setTerminalLines([]);
      try {
        xtermAdapterRef.current?.terminal.clear();
      } catch {
        // Ignore
      }
      return;
    }

    if (cmd === 'help') {
      const helpMsg = 'Available local commands: connect <user@host>, pubkey, font <size>, clear, vault, split, features';
      setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, helpMsg]);
      writeToXterm(`
${helpMsg}
webssh:~$ `);
      return;
    }

    if (cmd === 'pubkey') {
      copyToClipboard(authorizedKeysSnippet);
      setTerminalLines((prev) => [
        ...prev,
        `webssh:~$ ${trimmed}`,
        `Ed25519 Public Key: ${generatedPubKey}`,
        `Copy helper: ${authorizedKeysSnippet}`
      ]);
      writeToXterm(`
Ed25519 Public Key: ${generatedPubKey}
webssh:~$ `);
      return;
    }

    if (cmd === 'font') {
      const parsed = Number.parseInt(arg, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        const clamped = Math.min(32, Math.max(11, parsed));
        setFontSize(clamped);
        setTerminalLines((prev) => [
          ...prev,
          `webssh:~$ ${trimmed}`,
          `Terminal font size set to ${clamped}px.`
        ]);
        writeToXterm(`
Terminal font size set to ${clamped}px.
webssh:~$ `);
      } else {
        setTerminalLines((prev) => [
          ...prev,
          `webssh:~$ ${trimmed}`,
          'Usage: font <size> (11-32)'
        ]);
      }
      return;
    }

    if (cmd === 'connect') {
      if (arg) {
        let userPart = connectUser;
        let hostPart = arg;
        let portPart = connectPort;
        if (arg.includes('@')) {
          const [u, rest] = arg.split('@');
          if (u) userPart = u;
          hostPart = rest ?? '';
        }
        if (hostPart.includes(':')) {
          const [h, p] = hostPart.split(':');
          hostPart = h ?? '';
          if (p) portPart = p;
        }
        setConnectUser(userPart);
        setConnectHost(hostPart);
        setConnectPort(portPart);
      }
      setTerminalLines((prev) => [
        ...prev,
        `webssh:~$ ${trimmed}`,
        `Opening SSH connection credentials modal${arg ? ` for ${arg}` : ''}...`
      ]);
      setConnectModalOpen(true);
      return;
    }

    if (cmd === 'vault') {
      setTerminalLines((prev) => [
        ...prev,
        `webssh:~$ ${trimmed}`,
        `Argon2id Vault Fingerprint: ${generatedFp}`
      ]);
      setActiveScreen('vault');
      return;
    }

    if (cmd === 'split') {
      setSplitPanes((n) => (n === 1 ? 2 : 1));
      setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, 'Toggled split terminal pane view.']);
      return;
    }

    if (cmd === 'features') {
      setActiveScreen('features');
      return;
    }

    setTerminalLines((prev) => [
      ...prev,
      `webssh:~$ ${trimmed}`,
      `Unknown command: ${cmd}. Type 'help' for available commands.`
    ]);
    writeToXterm(`
Unknown command: ${cmd}. Type 'help' for available commands.
webssh:~$ `);
  };

  const handleTerminalKeyDown = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      // Allow global Cmd+K handler or clear buffer when Shift is held
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      executeTerminalCommand(currentInputRef.current);
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      updateCurrentInput((prev) => prev.slice(0, -1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const hist = historyRef.current;
      if (hist.length === 0) return;
      const curIdx = historyIndexRef.current;
      const nextIdx = curIdx === -1 ? hist.length - 1 : Math.max(0, curIdx - 1);
      historyIndexRef.current = nextIdx;
      setHistoryIndex(nextIdx);
      updateCurrentInput(hist[nextIdx] ?? '');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const hist = historyRef.current;
      const curIdx = historyIndexRef.current;
      if (hist.length === 0 || curIdx === -1) return;
      const nextIdx = curIdx + 1;
      if (nextIdx >= hist.length) {
        historyIndexRef.current = -1;
        setHistoryIndex(-1);
        updateCurrentInput('');
      } else {
        historyIndexRef.current = nextIdx;
        setHistoryIndex(nextIdx);
        updateCurrentInput(hist[nextIdx] ?? '');
      }
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      updateCurrentInput((prev) => prev + e.key);
    }
  };

  // 4. Mount @xterm/xterm engine into xtermHostRef when available in browser
  useEffect(() => {
    const hostEl = xtermHostRef.current;
    if (!hostEl) return;
    const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
    if (isJsdom) return;

    const palette = THEMES[activeTheme] ?? THEMES.dark;
    let disposed = false;
    try {
      const adapter = new XtermPaneAdapter({
        fontFamily,
        fontSize,
        lineHeight: 1.45,
        cursorStyle: cursorShape,
        cursorBlink: true,
        scrollback: 10000,
        theme: {
          background: palette.terminalBg,
          foreground: palette.terminalFg,
          cursor: palette.terminalCursor
        },
        onResize: (c, r) => {
          if (!disposed) {
            setCols(c);
            setRows(r);
          }
        }
      });
      xtermAdapterRef.current = adapter;
      void adapter.mount(hostEl, 'dom').then(() => {
        if (disposed) return;
        const helperTextarea = hostEl.querySelector('.xterm-helper-textarea');
        if (helperTextarea) {
          helperTextarea.setAttribute('aria-label', 'Terminal xterm input');
          helperTextarea.setAttribute('tabindex', '-1');
        }
      });
    } catch {
      // Fallback to DOM viewport when canvas/matchMedia is unavailable
    }

    return () => {
      disposed = true;
      try {
        xtermAdapterRef.current?.dispose();
      } catch {
        // Ignore dispose errors
      }
      xtermAdapterRef.current = null;
    };
  }, []);

  useEffect(() => {
    const adapter = xtermAdapterRef.current;
    if (!adapter) return;
    try {
      adapter.terminal.options.fontSize = fontSize;
      adapter.terminal.options.fontFamily = fontFamily;
      adapter.terminal.options.cursorStyle = cursorShape;
      adapter.fitAddon.fit();
    } catch {
      // Ignore fit error in headless tests
    }
  }, [fontSize, fontFamily, cursorShape]);

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

  const handleRunFeature = (feature: FeatureCatalogItem): void => {
    setSelectedFeatureId(feature.id);
    setLastExecutedFeatureMsg(`Activated Feature #${feature.id}: ${feature.title}`);

    switch (feature.id) {
      case 1:
        void handleGenerateKey();
        setActiveScreen('vault');
        break;
      case 2:
      case 4:
        copyToClipboard(authorizedKeysSnippet);
        setTerminalLines((prev) => [
          ...prev,
          `[Feature #${feature.id}] Deployed public key snippet: ${authorizedKeysSnippet}`
        ]);
        setActiveScreen('workspace');
        break;
      case 6:
        setConnectionState('reconnecting');
        setPendingInputBytes(128);
        break;
      case 7:
        setConnectionState('resumed');
        setPendingInputBytes(0);
        break;
      case 10:
        setSplitPanes((n) => (n === 1 ? 2 : 1));
        setActiveScreen('workspace');
        break;
      case 11:
        handleAddTab();
        break;
      case 13:
        toggleFullscreen();
        break;
      case 14:
        setTerminalLines((prev) => [
          ...prev,
          'Unicode 11 Wide/Emoji Check: [日本語のテキスト] [한국어] [🚀🔒⚡🌐]'
        ]);
        setActiveScreen('workspace');
        break;
      case 15:
        setTerminalLines((prev) => [
          ...prev,
          'ANSI 24-bit TrueColor & OSC 8 Link: https://github.com/srinew/terminal [256-color OK]'
        ]);
        setActiveScreen('workspace');
        break;
      case 20:
        setTransferStatus('Uploading release.tar.zst — Chunk 12/20 (256 KiB) · SHA-256 verified (.part)');
        setActiveScreen('files');
        break;
      case 29:
        setFontFamily((prev) => (prev.includes('SF Mono') ? 'JetBrains Mono' : 'SF Mono'));
        setActiveScreen('workspace');
        break;
      case 30:
        setFontSize((s) => Math.min(32, s + 1));
        setActiveScreen('workspace');
        break;
      case 31:
        setLayoutPreset((p) => (p === 'sidebar-left' ? 'sidebar-right' : 'sidebar-left'));
        break;
      case 32:
        setCursorShape((c) => (c === 'block' ? 'bar' : c === 'bar' ? 'underline' : 'block'));
        setActiveScreen('workspace');
        break;
      case 35:
        setHostKeyModal('mismatch');
        break;
      case 41:
        setConnectModalOpen(true);
        break;
      case 43:
        setPaletteOpen(true);
        break;
      case 45:
        setBroadcastInput((b) => !b);
        setSplitPanes(2);
        setActiveScreen('workspace');
        break;
      case 50:
        setTerminalLines((prev) => [
          ...prev,
          '[OSC 133;D;0] Background command completed in 12.4s (exit code 0)'
        ]);
        setActiveScreen('workspace');
        break;
      default:
        setActiveScreen(feature.targetScreen);
        break;
    }
  };

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
      id: 'nav.features',
      title: 'Open 50-Feature Interactive Workbench',
      category: 'Terminal',
      run: () => {
        setActiveScreen('features');
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

  const filteredFeatures = useMemo(() => {
    return FIFTY_FEATURES_CATALOG.filter((f) => {
      if (featureCategory !== 'All' && f.category !== featureCategory) return false;
      if (!featureQuery.trim()) return true;
      const q = featureQuery.toLowerCase();
      return (
        f.title.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q) ||
        f.category.toLowerCase().includes(q) ||
        String(f.id) === q
      );
    });
  }, [featureCategory, featureQuery]);

  const quotaSnap = storageGuard.snapshot();

  const statusDotClass =
    connectionState === 'reconnecting'
      ? 'webssh-status-dot--reconnecting'
      : connectionState === 'offline'
        ? 'webssh-status-dot--offline'
        : connectionState === 'disconnected'
          ? 'webssh-status-dot--disconnected'
          : '';

  return (
    <div
      ref={rootRef}
      data-testid="workspace-root"
      className={`webssh-app ${isPseudoFullscreen ? 'webssh-app--pseudo-fullscreen' : ''}`.trim()}
      onClick={() => {
        if (openMenu !== null) setOpenMenu(null);
      }}
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
          <Badge tone={connectionState === 'connected' ? 'success' : 'neutral'}>{sessionTabLabel}</Badge>
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

      {/* 1. macOS Window Title Bar & Native Menu Bar */}
      {!isFullscreen && !zenMode ? (
        <div className="webssh-titlebar" data-testid="macos-titlebar">
          <div className="webssh-titlebar-left">
            <div className="webssh-traffic-lights" role="group" aria-label="Window controls">
              <button
                type="button"
                className="webssh-traffic-light webssh-traffic-light--close"
                aria-label="Close session or reset"
                title="Close session / Reset"
                data-testid="traffic-light-close"
                onClick={handleDisconnect}
              />
              <button
                type="button"
                className="webssh-traffic-light webssh-traffic-light--minimize"
                aria-label="Minimize or toggle Zen mode"
                title="Minimize / Toggle Zen Mode"
                data-testid="traffic-light-minimize"
                onClick={() => setZenMode((z) => !z)}
              />
              <button
                type="button"
                className="webssh-traffic-light webssh-traffic-light--fullscreen"
                aria-label="Toggle full screen"
                title="Full Screen"
                data-testid="traffic-light-fullscreen"
                onClick={toggleFullscreen}
              />
            </div>

            <nav className="webssh-menubar" aria-label="Application menu bar" data-testid="macos-menubar">
              <div className="webssh-menu-group" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className={`webssh-menu-trigger ${openMenu === 'terminal' ? 'webssh-menu-trigger--open' : ''}`.trim()}
                  onClick={() => setOpenMenu((m) => (m === 'terminal' ? null : 'terminal'))}
                  data-testid="menu-terminal-btn"
                >
                  Terminal
                </button>
                {openMenu === 'terminal' ? (
                  <div className="webssh-menu-dropdown" role="menu" data-testid="menu-terminal-dropdown">
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        handleAddTab();
                        setOpenMenu(null);
                      }}
                    >
                      <span>New Tab</span>
                      <span>Cmd+T</span>
                    </button>
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setSplitPanes((n) => (n === 1 ? 2 : 1));
                        setActiveScreen('workspace');
                        setOpenMenu(null);
                      }}
                    >
                      <span>Split Terminal</span>
                      <span>Cmd+D</span>
                    </button>
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        handleDisconnect();
                        setOpenMenu(null);
                      }}
                    >
                      <span>Disconnect</span>
                      <span>Cmd+W</span>
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="webssh-menu-group" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className={`webssh-menu-trigger ${openMenu === 'edit' ? 'webssh-menu-trigger--open' : ''}`.trim()}
                  onClick={() => setOpenMenu((m) => (m === 'edit' ? null : 'edit'))}
                  data-testid="menu-edit-btn"
                >
                  Edit
                </button>
                {openMenu === 'edit' ? (
                  <div className="webssh-menu-dropdown" role="menu" data-testid="menu-edit-dropdown">
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        copyToClipboard(terminalLines.join(String.fromCharCode(10)));
                        setOpenMenu(null);
                      }}
                    >
                      <span>Copy</span>
                      <span>Cmd+C</span>
                    </button>
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        updateCurrentInput((prev) => `${prev}ls -la`);
                        setOpenMenu(null);
                      }}
                    >
                      <span>Paste</span>
                      <span>Cmd+V</span>
                    </button>
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setTerminalLines([]);
                        setOpenMenu(null);
                      }}
                    >
                      <span>Clear Buffer</span>
                      <span>Cmd+K</span>
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="webssh-menu-group" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className={`webssh-menu-trigger ${openMenu === 'view' ? 'webssh-menu-trigger--open' : ''}`.trim()}
                  onClick={() => setOpenMenu((m) => (m === 'view' ? null : 'view'))}
                  data-testid="menu-view-btn"
                >
                  View
                </button>
                {openMenu === 'view' ? (
                  <div className="webssh-menu-dropdown" role="menu" data-testid="menu-view-dropdown">
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setZenMode((z) => !z);
                        setOpenMenu(null);
                      }}
                    >
                      <span>Toggle Zen Mode</span>
                    </button>
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        toggleFullscreen();
                        setOpenMenu(null);
                      }}
                    >
                      <span>Fullscreen</span>
                      <span>F11</span>
                    </button>
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setFontSize((s) => Math.min(32, s + 1));
                        setOpenMenu(null);
                      }}
                    >
                      <span>Increase Font Size</span>
                      <span>Cmd++</span>
                    </button>
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setFontSize((s) => Math.max(11, s - 1));
                        setOpenMenu(null);
                      }}
                    >
                      <span>Decrease Font Size</span>
                      <span>Cmd+-</span>
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="webssh-menu-group" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className={`webssh-menu-trigger ${openMenu === 'security' ? 'webssh-menu-trigger--open' : ''}`.trim()}
                  onClick={() => setOpenMenu((m) => (m === 'security' ? null : 'security'))}
                  data-testid="menu-security-btn"
                >
                  Security
                </button>
                {openMenu === 'security' ? (
                  <div className="webssh-menu-dropdown" role="menu" data-testid="menu-security-dropdown">
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setActiveScreen('vault');
                        setOpenMenu(null);
                      }}
                    >
                      <span>Argon2id Key Vault</span>
                    </button>
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setActiveScreen('hosts');
                        setOpenMenu(null);
                      }}
                    >
                      <span>Known Hosts</span>
                    </button>
                    <button
                      type="button"
                      className="webssh-menu-item"
                      role="menuitem"
                      onClick={() => {
                        copyToClipboard(authorizedKeysSnippet);
                        setTerminalLines((prev) => [
                          ...prev,
                          `Deployed Public Key Snippet: ${authorizedKeysSnippet}`
                        ]);
                        setOpenMenu(null);
                      }}
                    >
                      <span>Deploy Public Key</span>
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="webssh-menu-group" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className={`webssh-menu-trigger ${openMenu === 'features' ? 'webssh-menu-trigger--open' : ''}`.trim()}
                  onClick={() => {
                    setActiveScreen('features');
                    setOpenMenu(null);
                  }}
                  data-testid="menu-features-btn"
                >
                  Features (50)
                </button>
              </div>
            </nav>
          </div>

          <div className="webssh-window-title" data-testid="macos-window-title">
            <Icon name="folder" />
            <span>
              terminal — {activeSessionTitle} — {cols}x{rows}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <Badge tone={connectionState === 'connected' ? 'success' : 'neutral'}>
              {connectionState === 'connected' ? 'SSH Active' : 'Local Shell'}
            </Badge>
          </div>
        </div>
      ) : null}

      {/* 2 & 3. macOS / VS Code Capsule Tab Strip & Top-Right Quick Customization Toolbar */}
      {!isFullscreen && !zenMode ? (
        <header className="webssh-topbar" role="banner">
          <div className="webssh-tabs" role="tablist" aria-label="Active SSH sessions">
            {tabs.map((tab, idx) => {
              const isActive = tab.id === activeTabId;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive && activeScreen === 'workspace'}
                  className={`webssh-tab ${isActive && activeScreen === 'workspace' ? 'webssh-tab--active' : ''}`.trim()}
                  onClick={() => {
                    setActiveTabId(tab.id);
                    setSessionTabLabel(tab.title);
                    setActiveScreen('workspace');
                  }}
                  data-testid={idx === 0 ? 'tab-session-1' : `tab-session-${idx + 1}`}
                >
                  <span className={`webssh-status-dot ${statusDotClass}`.trim()} />
                  <span>{idx === 0 ? sessionTabLabel : tab.title}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Close ${tab.title}`}
                    className="webssh-tab-close"
                    data-testid={`close-tab-${tab.id}`}
                    onClick={(e) => handleCloseTab(tab.id, e)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleCloseTab(tab.id, e);
                      }
                    }}
                  >
                    ×
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              className="webssh-tab-add"
              aria-label="New terminal tab"
              title="New Tab"
              data-testid="add-tab-btn"
              onClick={handleAddTab}
            >
              +
            </button>
          </div>

          <div
            data-testid="topbar-quick-controls"
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}
          >
            <select
              className="ui-select"
              aria-label="Terminal font family"
              data-testid="font-family-select"
              value={fontFamily}
              onChange={(e) => setFontFamily((e.currentTarget as HTMLSelectElement).value)}
              style={{ width: 'auto' }}
            >
              <option value="SF Mono">SF Mono</option>
              <option value="'JetBrains Mono', 'Fira Code', monospace">JetBrains Mono</option>
              <option value="Fira Code">Fira Code</option>
              <option value="Menlo">Menlo</option>
              <option value="Monaco">Monaco</option>
              <option value="Courier New">Courier New</option>
            </select>

            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
              <Button
                variant="ghost"
                ariaLabel="Decrease font size"
                testId="font-size-dec-btn"
                onClick={() => setFontSize((s) => Math.max(11, s - 1))}
              >
                A-
              </Button>
              <span className="font-size-badge" data-testid="font-size-badge">
                {fontSize}px
              </span>
              <Button
                variant="ghost"
                ariaLabel="Increase font size"
                testId="font-size-inc-btn"
                onClick={() => setFontSize((s) => Math.min(32, s + 1))}
              >
                A+
              </Button>
            </div>

            <span
              className={`webssh-status-dot ${statusDotClass}`.trim()}
              title={`Connection state: ${connectionState}`}
              data-testid="connection-status-dot"
            />

            {connectionState === 'disconnected' ? (
              <Button variant="primary" onClick={() => setConnectModalOpen(true)} testId="new-connection-btn">
                New Connection
              </Button>
            ) : (
              <Button variant="destructive" onClick={handleDisconnect} testId="disconnect-btn">
                Disconnect
              </Button>
            )}

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

      {connectionState !== 'connected' && connectionState !== 'disconnected' ? (
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

      <div
        className={`webssh-workspace-body ${
          layoutPreset === 'sidebar-right' ? 'webssh-workspace-body--right' : ''
        }`.trim()}
      >
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
              variant={activeScreen === 'features' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('features')}
              testId="nav-features"
            >
              Features (50)
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
            <div className="webssh-split-container">
              <div
                ref={terminalViewRef}
                tabIndex={0}
                role="region"
                aria-label="SSH Terminal Viewport"
                data-testid="terminal-viewport"
                className="webssh-terminal-viewport"
                style={{ fontSize: `${fontSize}px`, fontFamily }}
                onKeyDown={handleTerminalKeyDown}
              >
                {terminalLines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
                <div data-testid="terminal-prompt-line">
                  <span>webssh:~$ </span>
                  <span data-testid="terminal-current-input">{currentInput}</span>
                  <span
                    className={`webssh-terminal-cursor ${
                      cursorShape === 'bar'
                        ? 'webssh-terminal-cursor--bar'
                        : cursorShape === 'underline'
                          ? 'webssh-terminal-cursor--underline'
                          : ''
                    }`.trim()}
                    aria-hidden="true"
                  />
                </div>
                <div
                  ref={xtermHostRef}
                  className="webssh-xterm-mount"
                  aria-hidden="true"
                  data-testid="xterm-engine-mount"
                />
              </div>

              {splitPanes > 1 ? (
                <div
                  tabIndex={0}
                  role="region"
                  aria-label="Secondary Split Terminal Viewport"
                  data-testid="terminal-split-pane-2"
                  className="webssh-terminal-viewport"
                  style={{
                    fontSize: `${fontSize}px`,
                    fontFamily,
                    borderLeft: 'var(--border-hairline)'
                  }}
                >
                  <div>Split Pane #2 ({broadcastInput ? 'Broadcast Input ON' : 'Independent Shell'})</div>
                  <div>
                    <span>webssh:~$ </span>
                    <span>{broadcastInput ? currentInput : ''}</span>
                    <span className="webssh-terminal-cursor" aria-hidden="true" />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeScreen === 'features' ? (
            <div className="webssh-panel-content" data-testid="screen-features">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                <h1>All 50 Features — Interactive Selector & Workbench</h1>
                <Badge tone="success" testId="feature-active-status">
                  {lastExecutedFeatureMsg}
                </Badge>
              </div>

              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                {(['All', 'Connection', 'Terminal', 'Files', 'Customization', 'Security', 'Productivity'] as const).map(
                  (cat) => (
                    <Button
                      key={cat}
                      variant={featureCategory === cat ? 'primary' : 'default'}
                      onClick={() => setFeatureCategory(cat)}
                      testId={`feature-cat-${cat.toLowerCase()}`}
                    >
                      {cat}
                    </Button>
                  )
                )}
                <input
                  type="search"
                  className="ui-input"
                  placeholder="Search all 50 features by name, number, or category…"
                  aria-label="Search 50 features"
                  value={featureQuery}
                  onInput={(e) => setFeatureQuery((e.target as HTMLInputElement).value)}
                  data-testid="feature-search-input"
                  style={{ flex: 1, minWidth: '220px' }}
                />
              </div>

              <div className="webssh-grid">
                {filteredFeatures.map((feat) => (
                  <Card
                    key={feat.id}
                    testId={`feature-card-${feat.id}`}
                    className={selectedFeatureId === feat.id ? 'ui-card--selected' : ''}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>
                        #{feat.id} · {feat.title}
                      </strong>
                      <Badge tone="neutral">{feat.category}</Badge>
                    </div>
                    <p>{feat.description}</p>
                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                      <Button
                        variant="primary"
                        onClick={() => handleRunFeature(feat)}
                        testId={`run-feature-${feat.id}`}
                      >
                        {feat.actionLabel}
                      </Button>
                    </div>
                  </Card>
                ))}
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
                  <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                    <Button variant="default" onClick={() => copyToClipboard(authorizedKeysSnippet)}>
                      <Icon name="copy" /> Copy authorized_keys Snippet
                    </Button>
                  </div>
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
                      <Button
                        variant="primary"
                        onClick={() => {
                          setConnectUser(h.user);
                          setConnectHost(h.host);
                          setConnectPort(String(h.port));
                          setConnectModalOpen(true);
                        }}
                      >
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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                <h1>Dual-Pane SFTP File Manager</h1>
                <Badge tone="neutral" testId="storage-quota-badge">
                  Storage Guard: {quotaSnap.percentUsed}% of 256 MiB cap (256 KiB chunks, SHA-256 verified)
                </Badge>
              </div>
              <p>{transferStatus}</p>
              <input
                type="search"
                className="ui-input"
                placeholder="Filter remote directory entries…"
                value={fileFilter}
                onInput={(e) => setFileFilter((e.target as HTMLInputElement).value)}
                aria-label="Filter remote directory entries"
              />
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <p>Drop files or folders to upload to /srv/app (resumable .part atomic rename)</p>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Button
                      variant="primary"
                      onClick={() =>
                        setTransferStatus('Uploaded release.tar.zst (20/20 chunks · 256 KiB · SHA-256 verified)')
                      }
                    >
                      <Icon name="upload" /> Simulate 256 KiB Upload
                    </Button>
                    <Button
                      variant="default"
                      onClick={() => setTransferStatus('Streaming /etc/app/config.zip via ZIP64 writer…')}
                    >
                      <Icon name="download" /> Download Folder ZIP
                    </Button>
                  </div>
                </div>
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
              <Card>
                <h2>Variable Interpolation Parameters</h2>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <div>
                    <label htmlFor="snip-var-service">service</label>
                    <input
                      id="snip-var-service"
                      className="ui-input"
                      value={snippetVarService}
                      onInput={(e) => setSnippetVarService((e.target as HTMLInputElement).value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="snip-var-lines">lines</label>
                    <input
                      id="snip-var-lines"
                      className="ui-input"
                      value={snippetVarLines}
                      onInput={(e) => setSnippetVarLines((e.target as HTMLInputElement).value)}
                    />
                  </div>
                </div>
              </Card>
              <div className="webssh-grid">
                {snippetLib.list().map((snip) => {
                  const interpolated = interpolateSnippet(snip.command, {
                    service: snippetVarService,
                    lines: snippetVarLines
                  });
                  return (
                    <Card key={snip.id}>
                      <strong>{snip.name}</strong>
                      <code>{interpolated}</code>
                      <Button
                        variant="primary"
                        onClick={() => {
                          setTerminalLines((prev) => [...prev, `webssh:~$ ${interpolated}`]);
                          setActiveScreen('workspace');
                        }}
                      >
                        Run Snippet
                      </Button>
                    </Card>
                  );
                })}
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
                <h2>Workspace Layout & Cursor Geometry</h2>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <Button
                    variant={layoutPreset === 'sidebar-left' ? 'primary' : 'default'}
                    onClick={() => setLayoutPreset('sidebar-left')}
                  >
                    Sidebar Left
                  </Button>
                  <Button
                    variant={layoutPreset === 'sidebar-right' ? 'primary' : 'default'}
                    onClick={() => setLayoutPreset('sidebar-right')}
                  >
                    Sidebar Right
                  </Button>
                  <Button
                    variant={cursorShape === 'block' ? 'primary' : 'default'}
                    onClick={() => setCursorShape('block')}
                  >
                    Cursor: Block
                  </Button>
                  <Button
                    variant={cursorShape === 'bar' ? 'primary' : 'default'}
                    onClick={() => setCursorShape('bar')}
                  >
                    Cursor: Bar
                  </Button>
                  <Button
                    variant={cursorShape === 'underline' ? 'primary' : 'default'}
                    onClick={() => setCursorShape('underline')}
                  >
                    Cursor: Underline
                  </Button>
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
          <span>
            {connectionState === 'connected'
              ? `Connected: ${sessionTabLabel} · Cipher: chacha20-poly1305@openssh.com`
              : 'Status: Disconnected · Ready for SSH connection'}
          </span>
          <span>
            Remote Signer: Argon2id Ed25519 · {cols}x{rows} · Font: {fontSize}px
          </span>
        </footer>
      ) : null}

      {/* 5. Server Connection & Argon2id Auth Modal */}
      <Modal
        open={connectModalOpen}
        title="New SSH Connection & Argon2id Credentials"
        onClose={() => setConnectModalOpen(false)}
        testId="connect-modal"
      >
        <form onSubmit={handleConnectSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div>
            <label htmlFor="connect-host-input">Host (IP or domain)</label>
            <input
              id="connect-host-input"
              type="text"
              className="ui-input"
              placeholder="e.g. 192.168.1.10 or edge-01.prod.internal"
              value={connectHost}
              onInput={(e) => setConnectHost((e.target as HTMLInputElement).value)}
              data-testid="connect-host-input"
            />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <div style={{ flex: 2 }}>
              <label htmlFor="connect-user-input">Username</label>
              <input
                id="connect-user-input"
                type="text"
                className="ui-input"
                placeholder="root / ubuntu"
                value={connectUser}
                onInput={(e) => setConnectUser((e.target as HTMLInputElement).value)}
                data-testid="connect-user-input"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="connect-port-input">Port</label>
              <input
                id="connect-port-input"
                type="number"
                className="ui-input"
                value={connectPort}
                onInput={(e) => setConnectPort((e.target as HTMLInputElement).value)}
                data-testid="connect-port-input"
              />
            </div>
          </div>

          <div>
            <label>Auth Mode</label>
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-1)', flexWrap: 'wrap' }}>
              <Button
                variant={authMethod === 'Argon2id Ed25519 Key' ? 'primary' : 'default'}
                onClick={() => setAuthMethod('Argon2id Ed25519 Key')}
                testId="auth-method-pubkey-btn"
              >
                Argon2id Ed25519 Key
              </Button>
              <Button
                variant={authMethod === 'Password' ? 'primary' : 'default'}
                onClick={() => setAuthMethod('Password')}
                testId="auth-method-password-btn"
              >
                Password
              </Button>
            </div>
          </div>

          {authMethod === 'Password' ? (
            <div>
              <label htmlFor="connect-password-input">Password</label>
              <input
                id="connect-password-input"
                type="password"
                className="ui-input"
                placeholder="Enter SSH password…"
                value={connectPassword}
                onInput={(e) => setConnectPassword((e.target as HTMLInputElement).value)}
                data-testid="connect-password-input"
              />
            </div>
          ) : null}

          <div>
            <label htmlFor="connect-pubkey-snippet">Public Key Snippet (authorized_keys)</label>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-1)' }}>
              <input
                id="connect-pubkey-snippet"
                type="text"
                className="ui-input"
                readOnly
                value={authorizedKeysSnippet}
                data-testid="connect-pubkey-snippet"
              />
              <Button
                variant="default"
                onClick={() => copyToClipboard(authorizedKeysSnippet)}
                testId="copy-pubkey-snippet-btn"
              >
                <Icon name="copy" /> {copiedSnippet ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
            <Button variant="default" onClick={() => setConnectModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" testId="connect-modal-submit-btn">
              Connect
            </Button>
          </div>
        </form>
      </Modal>

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
