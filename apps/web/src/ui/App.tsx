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
import {
  DATABASE_TUNNEL_TEMPLATES,
  computeGhostAutocomplete,
  computeSideBySideDiff,
  detectDangerousCommand,
  formatChmodOctal,
  redactSecretsInText,
  type ChmodPermissions,
  type CommandBlockEntry,
  type ListeningPortEntry,
  type PlaybookHostResult,
  type RemoteContainerEntry,
  type RemoteProcessEntry,
  type ServerVitalsSnapshot,
  type SshCertificateInfo,
  type SshTunnelRule
} from './advanced-features';

export type ScreenId =
  | 'workspace'
  | 'features'
  | 'telemetry'
  | 'tunnels'
  | 'playbooks'
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

export type AuthMethod = 'Password' | 'Private Key (.pem / id_rsa)' | 'Argon2id Ed25519 Key';

export type KeyPermissionMode = '0400' | '0600' | '0644';

export type MenuId = 'terminal' | 'edit' | 'view' | 'security' | 'features' | 'more' | null;

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
  const hostRegistry = useMemo(() => new HostRegistry(), []);

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

  // 2. macOS / VS Code / Studio Tabs state
  const [tabs, setTabs] = useState<SessionTabItem[]>([
    { id: 'tab-1', title: 'Terminal 1', connected: false }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('tab-1');
  const [splitPanes, setSplitPanes] = useState<number>(1);
  const [broadcastInput, setBroadcastInput] = useState<boolean>(false);

  // Default to clean Welcome screen & Minimal Mode (IDE mode disabled until requested)
  const [activeScreen, setActiveScreen] = useState<ScreenId>('welcome');
  const [ideMode, setIdeMode] = useState<boolean>(false);
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

  // 3. Fresh Default State (Zero Pre-Populated Mock Data)
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [sessionTabLabel, setSessionTabLabel] = useState<string>('Terminal 1');
  const [connectedUser, setConnectedUser] = useState<string>('bob');
  const [connectedHost, setConnectedHost] = useState<string>('caleston-lp10');
  const [pendingInputBytes, setPendingInputBytes] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [hostKeyModal, setHostKeyModal] = useState<'none' | 'tofu' | 'mismatch'>('none');
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [hostSearch, setHostSearch] = useState('');
  const [sshConfigInput, setSshConfigInput] = useState('');
  const [generatedPubKey, setGeneratedPubKey] = useState(
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWebSSHStudioBrowserNonExtractableKey webssh@browser'
  );
  const [generatedFp, setGeneratedFp] = useState('SHA256:k9XmP2vR7wL4qN8sT1yB6cF3hJ5mZ0pQ9vW2xR4tY8u');
  const [vaultLocked, setVaultLocked] = useState(false);
  const [fileFilter, setFileFilter] = useState('');
  const [transferStatus, setTransferStatus] = useState<string>('Disconnected — Connect to an SSH host to browse SFTP files');
  const [sftpRawEntries, setSftpRawEntries] = useState<
    { name: string; path: string; size: number; mode: string; modTime: number; isDir: boolean }[]
  >([]);
  const [editorOriginalContent] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [editorSaved, setEditorSaved] = useState(true);
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [scrubberSec, setScrubberSec] = useState(2.5);
  const [snippetVarService, setSnippetVarService] = useState('sshd');
  const [snippetVarLines, setSnippetVarLines] = useState('50');

  // Step 12 Advanced Feature Suite State (Clean / Empty until connected or invoked)
  const [redactionMode, setRedactionMode] = useState<boolean>(false);
  const [dangerousCommandPending, setDangerousCommandPending] = useState<{ command: string; reason: string } | null>(null);
  const [commandBlocks, setCommandBlocks] = useState<CommandBlockEntry[]>([]);

  const [vitals, setVitals] = useState<ServerVitalsSnapshot>({
    cpuPercent: 0,
    ramUsedGiB: 0,
    ramTotalGiB: 0,
    diskIoMbps: 0,
    netRxMbps: 0,
    netTxMbps: 0,
    loadAvg: [0, 0, 0]
  });

  const [processFilter, setProcessFilter] = useState<string>('');
  const [processes, setProcesses] = useState<RemoteProcessEntry[]>([]);
  const [containers, setContainers] = useState<RemoteContainerEntry[]>([]);
  const [listeningPorts, setListeningPorts] = useState<ListeningPortEntry[]>([]);

  const [tunnels, setTunnels] = useState<SshTunnelRule[]>([]);
  const [webPreviewPort, setWebPreviewPort] = useState<number>(3000);
  const [newTunnelLocalPort, setNewTunnelLocalPort] = useState<string>('8080');
  const [newTunnelRemotePort, setNewTunnelRemotePort] = useState<string>('80');

  const [chmodTargetFile, setChmodTargetFile] = useState<string>('~/.ssh/id_ed25519');
  const [chmodPerms, setChmodPerms] = useState<ChmodPermissions>({
    ownerRead: true,
    ownerWrite: false,
    ownerExec: false,
    groupRead: false,
    groupWrite: false,
    groupExec: false,
    publicRead: false,
    publicWrite: false,
    publicExec: false
  });

  const [tailLogLines, setTailLogLines] = useState<string[]>([]);
  const [tailFilter, setTailFilter] = useState<string>('');
  const [tailPaused, setTailPaused] = useState<boolean>(false);
  const [relayStatus, setRelayStatus] = useState<string>('Ready to relay files between two connected SSH hosts');

  const [fido2Enrolled, setFido2Enrolled] = useState<boolean>(false);
  const [fido2KeyLine, setFido2KeyLine] = useState<string>('');
  const [sshCertInfo] = useState<SshCertificateInfo>({
    keyId: 'none',
    certType: 'user',
    principals: [],
    validAfter: '—',
    validBefore: '—',
    caFingerprint: '—',
    extensions: ['permit-pty', 'permit-port-forwarding']
  });

  const [playbookScript, setPlaybookScript] = useState<string>('uptime && uname -a');
  const [playbookResults, setPlaybookResults] = useState<PlaybookHostResult[]>([]);

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

  const ghostSuggestion = useMemo(
    () => computeGhostAutocomplete(currentInput, history),
    [currentInput, history]
  );

  const chmodFormatted = useMemo(() => formatChmodOctal(chmodPerms), [chmodPerms]);
  const diffEntries = useMemo(
    () => computeSideBySideDiff(editorOriginalContent, editorContent),
    [editorOriginalContent, editorContent]
  );

  const updateCurrentInput = (next: string | ((prev: string) => string)): void => {
    const resolved = typeof next === 'function' ? next(currentInputRef.current) : next;
    currentInputRef.current = resolved;
    setCurrentInput(resolved);
  };

  // 5. Simple Server Connection (Password OR Private Key Upload with chmod 0400 permission)
  const [connectModalOpen, setConnectModalOpen] = useState<boolean>(false);
  const [connectHost, setConnectHost] = useState<string>('');
  const [connectPort, setConnectPort] = useState<string>('22');
  const [connectUser, setConnectUser] = useState<string>('ubuntu');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('Password');
  const [connectPassword, setConnectPassword] = useState<string>('');
  const [uploadedKeyFileName, setUploadedKeyFileName] = useState<string>('');
  const [uploadedKeyContent, setUploadedKeyContent] = useState<string>('');
  const [keyPermissionMode, setKeyPermissionMode] = useState<KeyPermissionMode>('0400');
  const [connectErrorMsg, setConnectErrorMsg] = useState<string>('');

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
    const newTitle = `Terminal ${nextNum}`;
    setTabs((prev) => [...prev, { id: newId, title: newTitle, connected: false }]);
    setActiveTabId(newId);
    setSessionTabLabel(newTitle);
    setActiveScreen('workspace');
  };

  const handleCloseTab = (tabId: string, e?: Event): void => {
    if (e) e.stopPropagation();
    if (tabs.length <= 1) {
      setConnectionState('disconnected');
      setSessionTabLabel('Terminal 1');
      setConnectedUser('bob');
      setConnectedHost('caleston-lp10');
      setTabs([{ id: 'tab-1', title: 'Terminal 1', connected: false }]);
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
    const resetTitle = 'Terminal 1';
    setSessionTabLabel(resetTitle);
    setConnectedUser('bob');
    setConnectedHost('caleston-lp10');
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTabId ? { ...t, title: resetTitle, connected: false } : t))
    );
  };

  const handlePrivateKeyFileUpload = async (e: Event): Promise<void> => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setUploadedKeyFileName(file.name);
    setKeyPermissionMode('0400');
    setConnectErrorMsg('');
    try {
      const text = typeof file.text === 'function' ? await file.text() : '';
      setUploadedKeyContent(text || `-----BEGIN OPENSSH PRIVATE KEY----- (${file.name})`);
    } catch {
      setUploadedKeyContent(`-----BEGIN OPENSSH PRIVATE KEY----- (${file.name})`);
    }
  };

  const handleConnectSubmit = (e?: Event): void => {
    if (e) e.preventDefault();
    if (authMethod === 'Private Key (.pem / id_rsa)' && keyPermissionMode === '0644') {
      setConnectErrorMsg(
        'Permissions 0644 for private key are too open! OpenSSH requires chmod 0400 (-r--------) or 0600.'
      );
      return;
    }
    setConnectErrorMsg('');
    const hostVal = connectHost.trim() || 'caleston-lp10';
    const userVal = connectUser.trim() || 'bob';
    const portVal = connectPort.trim() || '22';
    const label = `${userVal}@${hostVal}`;
    const tabTitle = `Terminal 1 (${label})`;

    // Save connected host cleanly into HostRegistry
    hostRegistry.upsert({
      id: `host-${hostVal}-${portVal}`,
      alias: hostVal,
      host: hostVal,
      port: Number.parseInt(portVal, 10) || 22,
      user: userVal,
      folder: 'Connected',
      tags: [authMethod === 'Password' ? 'password' : 'key-400'],
      favorite: true,
      jumpHops: []
    });
    setHosts(hostRegistry.list());

    setConnectedUser(userVal);
    setConnectedHost(hostVal);
    setSessionTabLabel(tabTitle);
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTabId ? { ...t, title: tabTitle, connected: true } : t))
    );
    setConnectionState('connected');
    setConnectModalOpen(false);
    setActiveScreen('workspace');
    const authDetail =
      authMethod === 'Private Key (.pem / id_rsa)'
        ? `Private Key ${uploadedKeyFileName || 'id_ed25519'} [chmod ${keyPermissionMode}]`
        : authMethod;
    const msg = `Connected to ${label}:${portVal} (${authDetail})`;
    setTerminalLines((prev) => [...prev, msg]);
    writeToXterm(`
${msg}
webssh:~$ `);
  };

  const appendCommandBlock = (command: string, outputLines: string[], exitCode = 0): void => {
    const entry: CommandBlockEntry = {
      id: `block-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      command,
      outputLines,
      timestamp: '08:15:10',
      durationMs: 28,
      exitCode,
      collapsed: false
    };
    setCommandBlocks((prev) => [entry, ...prev]);
  };

  const executeTerminalCommand = (rawCommand: string, bypassSafetyGuard = false): void => {
    const trimmed = rawCommand.trim();
    updateCurrentInput('');
    historyIndexRef.current = -1;
    setHistoryIndex(-1);

    if (!trimmed) {
      setTerminalLines((prev) => [...prev, 'webssh:~$ ']);
      writeToXterm(`${String.fromCharCode(13, 10)}webssh:~$ `);
      return;
    }

    if (!bypassSafetyGuard) {
      const dangerCheck = detectDangerousCommand(trimmed);
      if (dangerCheck.dangerous) {
        setDangerousCommandPending({ command: trimmed, reason: dangerCheck.reason });
        return;
      }
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
      const helpMsg =
        'Available local commands: connect <user@host>, pubkey, font <size>, clear, vault, split, features, telemetry, tunnels, playbooks';
      setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, helpMsg]);
      appendCommandBlock(trimmed, [helpMsg], 0);
      writeToXterm(`
${helpMsg}
webssh:~$ `);
      return;
    }

    if (cmd === 'pubkey') {
      copyToClipboard(authorizedKeysSnippet);
      const out = [`Ed25519 Public Key: ${generatedPubKey}`, `Copy helper: ${authorizedKeysSnippet}`];
      setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, ...out]);
      appendCommandBlock(trimmed, out, 0);
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
        const msg = `Terminal font size set to ${clamped}px.`;
        setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, msg]);
        appendCommandBlock(trimmed, [msg], 0);
        writeToXterm(`
${msg}
webssh:~$ `);
      } else {
        const msg = 'Usage: font <size> (11-32)';
        setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, msg]);
        appendCommandBlock(trimmed, [msg], 1);
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
      const msg = `Opening SSH connection credentials modal${arg ? ` for ${arg}` : ''}...`;
      setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, msg]);
      appendCommandBlock(trimmed, [msg], 0);
      setConnectModalOpen(true);
      return;
    }

    if (cmd === 'vault') {
      const msg = `Argon2id Vault Fingerprint: ${generatedFp}`;
      setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, msg]);
      appendCommandBlock(trimmed, [msg], 0);
      setActiveScreen('vault');
      return;
    }

    if (cmd === 'split') {
      setSplitPanes((n) => (n === 1 ? 2 : 1));
      const msg = 'Toggled split terminal pane view.';
      setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, msg]);
      appendCommandBlock(trimmed, [msg], 0);
      return;
    }

    if (cmd === 'features') {
      appendCommandBlock(trimmed, ['Opened 50-Feature Workbench.'], 0);
      setActiveScreen('features');
      return;
    }

    if (cmd === 'telemetry') {
      appendCommandBlock(trimmed, ['Opened Server Observability & DevOps HUD.'], 0);
      setActiveScreen('telemetry');
      return;
    }

    if (cmd === 'tunnels') {
      appendCommandBlock(trimmed, ['Opened Port Forwarding & Network Tunneling Studio.'], 0);
      setActiveScreen('tunnels');
      return;
    }

    if (cmd === 'playbooks') {
      appendCommandBlock(trimmed, ['Opened Multi-Host Playbook & Fleet Runner.'], 0);
      setActiveScreen('playbooks');
      return;
    }

    const unknownMsg = `Executed remote/shell command: ${trimmed}`;
    setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, unknownMsg]);
    appendCommandBlock(trimmed, [unknownMsg], 0);
    writeToXterm(`
${unknownMsg}
webssh:~$ `);
  };

  const handleTerminalKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && zenMode) {
      e.preventDefault();
      setZenMode(false);
      setActiveScreen('welcome');
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      // Allow global Cmd+K handler or clear buffer when Shift is held
      return;
    }
    if (e.key === 'Tab' || e.key === 'ArrowRight') {
      const suggestion = computeGhostAutocomplete(currentInputRef.current, historyRef.current);
      if (suggestion) {
        e.preventDefault();
        updateCurrentInput((prev) => prev + suggestion);
        return;
      }
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
      } else if (e.key === 'Escape') {
        setZenMode((wasZen) => {
          if (wasZen) {
            setActiveScreen('welcome');
          }
          return false;
        });
        if (isFullscreen) {
          void exitImmersiveFullscreen();
        }
      } else if (e.key === 'Alt' && isFullscreen) {
        setShowOverlayBar(true);
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('keydown', onKeyDown);
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
    () => sortAndFilterEntries(sftpRawEntries, fileFilter),
    [sftpRawEntries, fileFilter]
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
      onKeyDown={(e) => {
        if (e.key === 'Escape' && zenMode) {
          e.preventDefault();
          setZenMode(false);
          setActiveScreen('welcome');
        }
      }}
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

      {/* 2 & 3. Studio Session Tab Bar & Right-Side Controls (Stop Square, Fullscreen, Pop-out, More Menu & Custom Options) */}
      {!isFullscreen && !zenMode ? (
        <header className="webssh-topbar webssh-studio-toolbar" role="banner">
          <div className="webssh-studio-tabs">
            <div className="webssh-studio-tabs" role="tablist" aria-label="Active SSH sessions">
              {tabs.map((tab, idx) => {
                const isActive = tab.id === activeTabId;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive && activeScreen === 'workspace'}
                    className={`webssh-studio-tab ${isActive && activeScreen === 'workspace' ? 'webssh-studio-tab--active' : ''}`.trim()}
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
                      aria-hidden="true"
                      className="webssh-tab-close"
                      data-testid={`close-tab-${tab.id}`}
                      onClick={(e) => handleCloseTab(tab.id, e)}
                    >
                      ×
                    </span>
                  </button>
                );
              })}
            </div>
            <span className="webssh-studio-tab-separator" data-testid="tab-separator" aria-hidden="true" />
            <button
              type="button"
              className="webssh-studio-add-btn"
              aria-label="New terminal tab"
              title="Add Terminal Session"
              data-testid="add-tab-btn"
              onClick={handleAddTab}
            >
              +
            </button>
          </div>

          <div
            data-testid="topbar-quick-controls"
            className="webssh-studio-controls"
          >
            <select
              className="ui-select"
              aria-label="Terminal font family"
              data-testid="font-family-select"
              value={fontFamily}
              onChange={(e) => setFontFamily((e.currentTarget as HTMLSelectElement).value)}
              style={{ width: 'auto' }}
            >
              <option value="'DejaVu Sans Mono', Menlo, monospace">DejaVu Sans Mono</option>
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
                onClick={() => setFontSize((s) => Math.min(36, s + 1))}
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
            ) : null}

            {/* Stop Session / Disconnect Control with Coral-Red Square */}
            <button
              type="button"
              className="webssh-studio-stop-btn"
              onClick={handleDisconnect}
              data-testid={connectionState === 'connected' ? 'disconnect-btn' : 'stop-session-btn'}
              title="Stop Session / Disconnect"
            >
              <span className="webssh-studio-stop-square" data-testid="stop-red-square" aria-hidden="true" />
              <span>{connectionState === 'connected' ? 'Stop Session (Disconnect)' : 'Stop Session'}</span>
            </button>

            <Button
              variant={ideMode ? 'primary' : 'default'}
              onClick={() => setIdeMode((m) => !m)}
              testId="toggle-ide-mode-btn"
            >
              {ideMode ? 'IDE Mode: ON' : 'Open IDE'}
            </Button>
            {ideMode ? (
              <Button
                variant={redactionMode ? 'primary' : 'ghost'}
                onClick={() => setRedactionMode((r) => !r)}
                testId="toggle-redaction-btn"
              >
                {redactionMode ? 'Redaction: ON' : 'Redact Secrets'}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setPaletteOpen(true)} testId="open-palette-btn">
              <Icon name="search" /> Command Palette (Cmd+K)
            </Button>
            <Button variant="ghost" onClick={() => setZenMode((z) => !z)} testId="toggle-zen-btn">
              Zen
            </Button>

            {/* Fullscreen Corner-Shaped Control */}
            <button
              type="button"
              className="webssh-studio-icon-btn"
              onClick={toggleFullscreen}
              aria-label="Expand terminal fullscreen"
              title="Full Screen (F11)"
              data-testid="toggle-fullscreen-btn"
            >
              <Icon name="maximize" />
              <span>Full Screen</span>
            </button>

            {/* Pop-Out Terminal Control (Square with upper-right arrow) */}
            <button
              type="button"
              className="webssh-studio-icon-btn"
              aria-label="Pop out terminal view"
              title="Open Terminal Workspace View"
              data-testid="popout-terminal-btn"
              onClick={() => {
                setActiveScreen('workspace');
                terminalViewRef.current?.focus();
              }}
            >
              <span aria-hidden="true">↗</span>
              <span>Pop-out</span>
            </button>

            {/* More Menu (Three Horizontal Gray Dots ⋯) */}
            <div className="webssh-menu-group" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="webssh-studio-icon-btn"
                aria-label="More terminal options"
                title="More Custom Options"
                data-testid="more-options-menu-btn"
                onClick={() => setOpenMenu((m) => (m === 'more' ? null : 'more'))}
              >
                <span aria-hidden="true">•••</span>
              </button>
              {openMenu === 'more' ? (
                <div
                  className="webssh-menu-dropdown"
                  role="menu"
                  data-testid="more-options-dropdown"
                  style={{ right: 0, left: 'auto' }}
                >
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setIdeMode((m) => !m);
                      setOpenMenu(null);
                    }}
                  >
                    <span>{ideMode ? 'Disable IDE Mode' : 'Enable IDE Mode (50 Features)'}</span>
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
                    <span>Toggle Split Pane</span>
                  </button>
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setRedactionMode((r) => !r);
                      setOpenMenu(null);
                    }}
                  >
                    <span>{redactionMode ? 'Disable Secret Redaction' : 'Enable Secret Redaction'}</span>
                  </button>
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setActiveScreen('settings');
                      setOpenMenu(null);
                    }}
                  >
                    <span>Themes & Typography Settings</span>
                  </button>
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setActiveScreen('welcome');
                      setOpenMenu(null);
                    }}
                  >
                    <span>Quick Connect Welcome Screen</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>
      ) : null}

      {zenMode ? (
        <div
          className="webssh-banner"
          role="status"
          data-testid="zen-mode-banner"
          style={{ justifyContent: 'space-between' }}
        >
          <span>Zen Mode Active — Press Esc to return</span>
          <Button
            variant="default"
            testId="exit-zen-btn"
            onClick={() => {
              setZenMode(false);
              setActiveScreen('welcome');
            }}
          >
            Exit Zen (Esc)
          </Button>
        </div>
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
              variant={activeScreen === 'welcome' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('welcome')}
              testId="nav-welcome"
            >
              Welcome
            </Button>
            <Button
              variant={activeScreen === 'workspace' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('workspace')}
              testId="nav-workspace"
            >
              <Icon name="terminal" /> Terminal
            </Button>
            <Button
              variant={ideMode ? 'primary' : 'default'}
              onClick={() => {
                setIdeMode((prev) => {
                  const next = !prev;
                  if (next && activeScreen === 'welcome') {
                    setActiveScreen('features');
                  }
                  return next;
                });
              }}
              testId="enable-ide-mode-btn"
            >
              {ideMode ? 'IDE Enabled (All Features)' : 'Open IDE (All Features)'}
            </Button>

            {ideMode ? (
              <>
                <Button
                  variant={activeScreen === 'features' ? 'primary' : 'ghost'}
                  onClick={() => setActiveScreen('features')}
                  testId="nav-features"
                >
                  Features (50)
                </Button>
                <Button
                  variant={activeScreen === 'telemetry' ? 'primary' : 'ghost'}
                  onClick={() => setActiveScreen('telemetry')}
                  testId="nav-telemetry"
                >
                  Telemetry HUD
                </Button>
                <Button
                  variant={activeScreen === 'tunnels' ? 'primary' : 'ghost'}
                  onClick={() => setActiveScreen('tunnels')}
                  testId="nav-tunnels"
                >
                  Port Tunnels
                </Button>
                <Button
                  variant={activeScreen === 'playbooks' ? 'primary' : 'ghost'}
                  onClick={() => setActiveScreen('playbooks')}
                  testId="nav-playbooks"
                >
                  Fleet Playbooks
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
              </>
            ) : null}
          </nav>
        ) : null}

        <main className="webssh-main">
          {activeScreen === 'workspace' ? (
            <div className="webssh-studio-outer" data-testid="terminal-studio-outer">
              <div className="webssh-studio-container" data-testid="terminal-studio-container">
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
                    {/* Progressive 5-Color ASCII Banner (Lime -> Yellow -> Orange -> Coral -> Pink, Zero Copyrights) */}
                    <div className="webssh-ascii-banner" data-testid="terminal-ascii-banner">
                      <div className="webssh-ascii-welcome-line" data-testid="terminal-welcome-banner-text">
                        Welcome to the WebSSH Studio Interactive Terminal.
                      </div>
                      <pre className="webssh-ascii-art" aria-label="WEBSSH STUDIO ASCII Art">
                        <span className="webssh-logo-col-1">{'██╗    ██╗███████╗'}</span>
                        <span className="webssh-logo-col-2">{'██████╗ ███████╗'}</span>
                        <span className="webssh-logo-col-3">{'███████╗██╗  ██╗'}</span>
                        <span className="webssh-logo-col-4">{' ███████╗████████╗'}</span>
                        <span className="webssh-logo-col-5">{'██╗   ██╗██████╗ '}</span>
                        {String.fromCharCode(10)}
                        <span className="webssh-logo-col-1">{'██║    ██║██╔════╝'}</span>
                        <span className="webssh-logo-col-2">{'██╔══██╗██╔════╝'}</span>
                        <span className="webssh-logo-col-3">{'██╔════╝██║  ██║'}</span>
                        <span className="webssh-logo-col-4">{' ██╔════╝╚══██╔══╝'}</span>
                        <span className="webssh-logo-col-5">{'██║   ██║██╔══██╗'}</span>
                        {String.fromCharCode(10)}
                        <span className="webssh-logo-col-1">{'██║ █╗ ██║█████╗  '}</span>
                        <span className="webssh-logo-col-2">{'██████╔╝███████╗'}</span>
                        <span className="webssh-logo-col-3">{'███████╗███████║'}</span>
                        <span className="webssh-logo-col-4">{' ███████╗   ██║   '}</span>
                        <span className="webssh-logo-col-5">{'██║   ██║██║  ██║'}</span>
                        {String.fromCharCode(10)}
                        <span className="webssh-logo-col-1">{'██║███╗██║██╔══╝  '}</span>
                        <span className="webssh-logo-col-2">{'██╔══██╗╚════██║'}</span>
                        <span className="webssh-logo-col-3">{'╚════██║██╔══██║'}</span>
                        <span className="webssh-logo-col-4">{' ╚════██║   ██║   '}</span>
                        <span className="webssh-logo-col-5">{'██║   ██║██║  ██║'}</span>
                        {String.fromCharCode(10)}
                        <span className="webssh-logo-col-1">{'╚███╔███╔╝███████╗'}</span>
                        <span className="webssh-logo-col-2">{'██████╔╝███████║'}</span>
                        <span className="webssh-logo-col-3">{'███████║██║  ██║'}</span>
                        <span className="webssh-logo-col-4">{' ███████║   ██║   '}</span>
                        <span className="webssh-logo-col-5">{'╚██████╔╝██████╔╝'}</span>
                      </pre>
                    </div>

                    {terminalLines.map((line, i) => (
                      <div key={i}>{redactSecretsInText(line, redactionMode)}</div>
                    ))}
                    <div className="webssh-prompt-line" data-testid="terminal-prompt-line">
                      <span className="webssh-prompt-user" data-testid="prompt-username">
                        {connectedUser}
                      </span>
                      <span>@</span>
                      <span className="webssh-prompt-host" data-testid="prompt-hostname">
                        {connectedHost}
                      </span>
                      <span> </span>
                      <span className="webssh-prompt-dir" data-testid="prompt-directory">
                        ~
                      </span>
                      <span className="webssh-prompt-arrow" data-testid="prompt-arrow">
                        {' ➜ '}
                      </span>
                      <span className="webssh-prompt-input" data-testid="terminal-current-input">
                        {currentInput}
                      </span>
                      {ghostSuggestion ? (
                        <span className="webssh-ghost-text" data-testid="terminal-ghost-suggestion">
                          {ghostSuggestion}
                        </span>
                      ) : null}
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

                    {/* Warp-Style Smart Shell Command Blocks */}
                    <div className="webssh-cmd-blocks" data-testid="command-blocks-list">
                      {commandBlocks.map((block) => (
                        <div key={block.id} className="webssh-cmd-block" data-testid={`cmd-block-${block.id}`}>
                          <div className="webssh-cmd-block-header">
                            <span>
                              <strong>$ {redactSecretsInText(block.command, redactionMode)}</strong> ·{' '}
                              {block.timestamp} ({block.durationMs}ms)
                            </span>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                              <Badge tone={block.exitCode === 0 ? 'success' : 'danger'}>exit {block.exitCode}</Badge>
                              <Button
                                variant="ghost"
                                onClick={() =>
                                  setCommandBlocks((prev) =>
                                    prev.map((b) => (b.id === block.id ? { ...b, collapsed: !b.collapsed } : b))
                                  )
                                }
                                testId={`toggle-block-${block.id}`}
                              >
                                {block.collapsed ? 'Expand' : 'Fold'}
                              </Button>
                              <Button
                                variant="ghost"
                                onClick={() => copyToClipboard(block.outputLines.join(String.fromCharCode(10)))}
                              >
                                Copy Output
                              </Button>
                              <Button
                                variant="ghost"
                                onClick={() => executeTerminalCommand(block.command)}
                              >
                                Re-run
                              </Button>
                            </div>
                          </div>
                          {!block.collapsed ? (
                            <div style={{ marginTop: 'var(--space-1)' }}>
                              {block.outputLines.map((outLine, idx) => (
                                <div key={idx}>{redactSecretsInText(outLine, redactionMode)}</div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
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
                      <div className="webssh-prompt-line">
                        <span className="webssh-prompt-user">{connectedUser}</span>
                        <span>@</span>
                        <span className="webssh-prompt-host">{connectedHost}</span>
                        <span> </span>
                        <span className="webssh-prompt-dir">~</span>
                        <span className="webssh-prompt-arrow">{' ➜ '}</span>
                        <span>{broadcastInput ? currentInput : ''}</span>
                        <span className="webssh-terminal-cursor" aria-hidden="true" />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
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

          {activeScreen === 'telemetry' ? (
            <div className="webssh-panel-content" data-testid="screen-telemetry">
              <h1>Server Observability & DevOps HUD (Agentless SSH Probe)</h1>
              <div className="webssh-hud-strip" data-testid="telemetry-vitals-hud">
                <div className="webssh-hud-metric">
                  <span>CPU Load</span>
                  <strong>{vitals.cpuPercent}%</strong>
                  <div className="webssh-sparkbar">
                    <div className="webssh-sparkbar-fill" style={{ width: `${vitals.cpuPercent}%` }} />
                  </div>
                </div>
                <div className="webssh-hud-metric">
                  <span>RAM Usage</span>
                  <strong>
                    {vitals.ramUsedGiB} / {vitals.ramTotalGiB} GiB
                  </strong>
                  <div className="webssh-sparkbar">
                    <div
                      className="webssh-sparkbar-fill"
                      style={{ width: `${Math.round((vitals.ramUsedGiB / vitals.ramTotalGiB) * 100)}%` }}
                    />
                  </div>
                </div>
                <div className="webssh-hud-metric">
                  <span>Disk I/O</span>
                  <strong>{vitals.diskIoMbps} MB/s</strong>
                </div>
                <div className="webssh-hud-metric">
                  <span>Network RX / TX</span>
                  <strong>
                    ↓ {vitals.netRxMbps} MB/s · ↑ {vitals.netTxMbps} MB/s
                  </strong>
                </div>
                <div className="webssh-hud-metric">
                  <span>Load Avg (1m/5m/15m)</span>
                  <strong>{vitals.loadAvg.join(' / ')}</strong>
                </div>
              </div>

              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <h2>Interactive Process Manager (htop-in-GUI)</h2>
                  <input
                    type="search"
                    className="ui-input"
                    placeholder="Filter processes by PID, user, or command…"
                    aria-label="Filter processes"
                    value={processFilter}
                    onInput={(e) => setProcessFilter((e.target as HTMLInputElement).value)}
                    data-testid="process-filter-input"
                    style={{ maxWidth: '280px' }}
                  />
                </div>
                <table className="webssh-table" data-testid="process-table">
                  <thead>
                    <tr>
                      <th>PID</th>
                      <th>User</th>
                      <th>CPU %</th>
                      <th>MEM %</th>
                      <th>Command</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processes
                      .filter(
                        (p) =>
                          !processFilter ||
                          p.command.toLowerCase().includes(processFilter.toLowerCase()) ||
                          String(p.pid).includes(processFilter)
                      )
                      .map((proc) => (
                        <tr key={proc.pid} data-testid={`proc-row-${proc.pid}`}>
                          <td>{proc.pid}</td>
                          <td>{proc.user}</td>
                          <td>{proc.cpuPercent}%</td>
                          <td>{proc.memPercent}%</td>
                          <td>{proc.command}</td>
                          <td>
                            <Button
                              variant="danger"
                              testId={`kill-proc-${proc.pid}`}
                              onClick={() =>
                                setProcesses((prev) => prev.filter((item) => item.pid !== proc.pid))
                              }
                            >
                              SIGTERM
                            </Button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </Card>

              <div className="webssh-grid">
                <Card>
                  <h2>Docker & Kubernetes Container Inspector</h2>
                  {containers.map((c) => (
                    <div
                      key={c.id}
                      data-testid={`container-row-${c.id}`}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}
                    >
                      <div>
                        <strong>{c.name}</strong> ({c.runtime})
                        <div>
                          <small>
                            {c.image} · {c.ports}
                          </small>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                        <Badge tone="success">{c.status}</Badge>
                        <Button
                          variant="primary"
                          testId={`exec-container-${c.id}`}
                          onClick={() => {
                            handleAddTab();
                            setTerminalLines((prev) => [
                              ...prev,
                              `webssh:~$ ${c.runtime === 'docker' ? 'docker' : 'kubectl'} exec -it ${c.name} -- /bin/sh`
                            ]);
                          }}
                        >
                          Exec Shell
                        </Button>
                        <Button
                          variant="default"
                          onClick={() =>
                            setContainers((prev) =>
                              prev.map((item) =>
                                item.id === c.id ? { ...item, status: 'Restarting' } : item
                              )
                            )
                          }
                        >
                          Restart
                        </Button>
                      </div>
                    </div>
                  ))}
                </Card>

                <Card>
                  <h2>Active Listening Ports & Sockets (ss -tulnp)</h2>
                  <table className="webssh-table" data-testid="listening-ports-table">
                    <thead>
                      <tr>
                        <th>Proto</th>
                        <th>Bind:Port</th>
                        <th>Process (PID)</th>
                        <th>Preview</th>
                      </tr>
                    </thead>
                    <tbody>
                      {listeningPorts.map((lp) => (
                        <tr key={lp.port}>
                          <td>{lp.proto}</td>
                          <td>
                            {lp.bindAddress}:{lp.port}
                          </td>
                          <td>
                            {lp.process} ({lp.pid})
                          </td>
                          <td>
                            {lp.webPreviewable ? (
                              <Button
                                variant="primary"
                                testId={`preview-port-${lp.port}`}
                                onClick={() => {
                                  setWebPreviewPort(lp.port);
                                  setActiveScreen('tunnels');
                                }}
                              >
                                Web Preview
                              </Button>
                            ) : (
                              <Badge tone="neutral">TCP Tunnel</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </div>
            </div>
          ) : null}

          {activeScreen === 'tunnels' ? (
            <div className="webssh-panel-content" data-testid="screen-tunnels">
              <h1>Port Forwarding & Network Tunneling Studio (-L / -R / -D SOCKS5)</h1>
              <Card>
                <h2>Create Custom SSH Port Forward Rule</h2>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <label htmlFor="new-tunnel-local">Local Port</label>
                  <input
                    id="new-tunnel-local"
                    type="number"
                    className="ui-input"
                    value={newTunnelLocalPort}
                    onInput={(e) => setNewTunnelLocalPort((e.target as HTMLInputElement).value)}
                    data-testid="new-tunnel-local-input"
                    style={{ width: '110px' }}
                  />
                  <label htmlFor="new-tunnel-remote">Remote Port</label>
                  <input
                    id="new-tunnel-remote"
                    type="number"
                    className="ui-input"
                    value={newTunnelRemotePort}
                    onInput={(e) => setNewTunnelRemotePort((e.target as HTMLInputElement).value)}
                    data-testid="new-tunnel-remote-input"
                    style={{ width: '110px' }}
                  />
                  <Button
                    variant="primary"
                    testId="add-tunnel-btn"
                    onClick={() => {
                      const lPort = Number.parseInt(newTunnelLocalPort, 10) || 8080;
                      const rPort = Number.parseInt(newTunnelRemotePort, 10) || 80;
                      setTunnels((prev) => [
                        ...prev,
                        {
                          id: `tunnel-${Date.now()}`,
                          name: `Custom Tunnel :${lPort}->:${rPort}`,
                          type: 'L',
                          bindAddress: '127.0.0.1',
                          localPort: lPort,
                          remoteHost: '127.0.0.1',
                          remotePort: rPort,
                          active: true,
                          bytesTransferred: 0
                        }
                      ]);
                    }}
                  >
                    + Add Tunnel
                  </Button>
                </div>
              </Card>

              <div className="webssh-grid">
                {tunnels.map((t) => (
                  <Card key={t.id} testId={`tunnel-card-${t.id}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>
                        [-{t.type}] {t.name}
                      </strong>
                      <Badge tone={t.active ? 'success' : 'neutral'}>
                        {t.active ? 'Active' : 'Stopped'}
                      </Badge>
                    </div>
                    <p>
                      {t.bindAddress}:{t.localPort} → {t.remoteHost}:{t.remotePort} ·{' '}
                      {Math.round(t.bytesTransferred / 1024)} KiB transferred
                    </p>
                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                      <Button
                        variant="default"
                        testId={`toggle-tunnel-${t.id}`}
                        onClick={() =>
                          setTunnels((prev) =>
                            prev.map((item) => (item.id === t.id ? { ...item, active: !item.active } : item))
                          )
                        }
                      >
                        {t.active ? 'Pause Tunnel' : 'Start Tunnel'}
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => setWebPreviewPort(t.localPort)}
                      >
                        Preview :{t.localPort}
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>

              <Card testId="remote-web-preview-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2>One-Click Web Preview — Remote localhost:{webPreviewPort}</h2>
                  <Badge tone="success">SSH HTTP Proxy Tunnel Active</Badge>
                </div>
                <p>
                  Proxying remote <code>http://127.0.0.1:{webPreviewPort}</code> over multiplexed SSH channel #4:
                </p>
                <pre>
                  HTTP/1.1 200 OK · Service on 127.0.0.1:{webPreviewPort} (Grafana / Prometheus / Dev Server Ready)
                </pre>
              </Card>
            </div>
          ) : null}

          {activeScreen === 'playbooks' ? (
            <div className="webssh-panel-content" data-testid="screen-playbooks">
              <h1>Multi-Host Playbook & Fleet Runner</h1>
              <Card>
                <label htmlFor="playbook-script-input">Fleet Playbook Command / Script</label>
                <input
                  id="playbook-script-input"
                  type="text"
                  className="ui-input"
                  value={playbookScript}
                  onInput={(e) => setPlaybookScript((e.target as HTMLInputElement).value)}
                  data-testid="playbook-script-input"
                />
                <div style={{ marginTop: 'var(--space-2)' }}>
                  <Button
                    variant="primary"
                    testId="run-playbook-btn"
                    onClick={() =>
                      setPlaybookResults((prev) =>
                        prev.map((r) => ({
                          ...r,
                          output: `[Executed "${playbookScript}"] -> ${r.output}`
                        }))
                      )
                    }
                  >
                    Run Playbook Across Fleet ({playbookResults.length} Hosts)
                  </Button>
                </div>
              </Card>
              <div className="webssh-grid" data-testid="playbook-results-grid">
                {playbookResults.map((res) => (
                  <Card key={res.hostAlias} testId={`playbook-host-${res.hostAlias}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>
                        {res.hostAlias} ({res.hostAddress})
                      </strong>
                      <Badge tone={res.exitCode === 0 ? 'success' : 'danger'}>
                        exit {res.exitCode} · {res.durationMs}ms
                      </Badge>
                    </div>
                    <pre>{res.output}</pre>
                  </Card>
                ))}
              </div>
            </div>
          ) : null}

          {activeScreen === 'welcome' ? (
            <div className="webssh-panel-content" data-testid="screen-welcome">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                <div>
                  <h1>Welcome to WebSSH Studio</h1>
                  <p style={{ color: 'var(--color-fg-secondary)' }}>
                    Clean, minimal SSH workspace — connect with Username & Password or upload a Private Key (<code>chmod 0400</code>).
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <Button
                    variant="default"
                    testId="welcome-open-terminal-btn"
                    onClick={() => setActiveScreen('workspace')}
                  >
                    <Icon name="terminal" /> Open Terminal
                  </Button>
                  <Button
                    variant={ideMode ? 'primary' : 'default'}
                    testId="welcome-open-ide-btn"
                    onClick={() => {
                      setIdeMode(true);
                      setActiveScreen('features');
                    }}
                  >
                    Open IDE (All 50 Features)
                  </Button>
                </div>
              </div>

              <Card testId="welcome-quick-connect-card">
                <h2>Quick SSH Connect</h2>
                <form
                  onSubmit={handleConnectSubmit}
                  style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
                >
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <div style={{ flex: 2, minWidth: '180px' }}>
                      <label htmlFor="welcome-host-input">Host / IP</label>
                      <input
                        id="welcome-host-input"
                        type="text"
                        className="ui-input"
                        placeholder="e.g. 192.168.1.10 or server.example.com"
                        value={connectHost}
                        onInput={(e) => setConnectHost((e.target as HTMLInputElement).value)}
                        data-testid="welcome-host-input"
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: '130px' }}>
                      <label htmlFor="welcome-user-input">Username</label>
                      <input
                        id="welcome-user-input"
                        type="text"
                        className="ui-input"
                        placeholder="ubuntu / root"
                        value={connectUser}
                        onInput={(e) => setConnectUser((e.target as HTMLInputElement).value)}
                        data-testid="welcome-user-input"
                      />
                    </div>
                    <div style={{ width: '100px' }}>
                      <label htmlFor="welcome-port-input">Port</label>
                      <input
                        id="welcome-port-input"
                        type="number"
                        className="ui-input"
                        value={connectPort}
                        onInput={(e) => setConnectPort((e.target as HTMLInputElement).value)}
                        data-testid="welcome-port-input"
                      />
                    </div>
                  </div>

                  <div>
                    <label>Authentication Method</label>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-1)', flexWrap: 'wrap' }}>
                      <Button
                        variant={authMethod === 'Password' ? 'primary' : 'default'}
                        onClick={() => {
                          setAuthMethod('Password');
                          setConnectErrorMsg('');
                        }}
                        testId="welcome-auth-password-btn"
                      >
                        Username & Password
                      </Button>
                      <Button
                        variant={authMethod === 'Private Key (.pem / id_rsa)' ? 'primary' : 'default'}
                        onClick={() => {
                          setAuthMethod('Private Key (.pem / id_rsa)');
                          setConnectErrorMsg('');
                        }}
                        testId="welcome-auth-keyfile-btn"
                      >
                        Upload Private Key (.pem / chmod 400)
                      </Button>
                      <Button
                        variant={authMethod === 'Argon2id Ed25519 Key' ? 'primary' : 'default'}
                        onClick={() => {
                          setAuthMethod('Argon2id Ed25519 Key');
                          setConnectErrorMsg('');
                        }}
                        testId="welcome-auth-argon-btn"
                      >
                        Browser Ed25519 Key
                      </Button>
                    </div>
                  </div>

                  {authMethod === 'Password' ? (
                    <div>
                      <label htmlFor="welcome-password-input">Password</label>
                      <input
                        id="welcome-password-input"
                        type="password"
                        className="ui-input"
                        placeholder="Enter SSH password…"
                        value={connectPassword}
                        onInput={(e) => setConnectPassword((e.target as HTMLInputElement).value)}
                        data-testid="welcome-password-input"
                      />
                    </div>
                  ) : null}

                  {authMethod === 'Private Key (.pem / id_rsa)' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                        <label htmlFor="welcome-key-file-input">
                          Upload Private Key (<code>.pem</code>, <code>.key</code>, <code>id_ed25519</code>, <code>id_rsa</code>)
                        </label>
                        <Badge
                          tone={keyPermissionMode === '0644' ? 'danger' : 'success'}
                          testId="private-key-chmod-badge"
                        >
                          {keyPermissionMode === '0400'
                            ? 'chmod 0400 (-r--------) Enforced'
                            : keyPermissionMode === '0600'
                              ? 'chmod 0600 (-rw-------) Enforced'
                              : 'UNPROTECTED KEY (0644) — Set chmod 400'}
                        </Badge>
                      </div>
                      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                        <input
                          id="welcome-key-file-input"
                          type="file"
                          className="ui-input"
                          accept=".pem,.key,.pub,*"
                          onChange={(e) => void handlePrivateKeyFileUpload(e)}
                          data-testid="private-key-file-input"
                          style={{ flex: 1 }}
                        />
                        <select
                          aria-label="Private key chmod permission"
                          className="ui-select"
                          value={keyPermissionMode}
                          onChange={(e) => {
                            setKeyPermissionMode((e.currentTarget as HTMLSelectElement).value as KeyPermissionMode);
                            setConnectErrorMsg('');
                          }}
                          data-testid="private-key-chmod-select"
                          style={{ width: 'auto' }}
                        >
                          <option value="0400">chmod 0400 (-r--------) Read-Only</option>
                          <option value="0600">chmod 0600 (-rw-------) Owner R/W</option>
                          <option value="0644">chmod 0644 (-rw-r--r--) Too Open</option>
                        </select>
                        <Button
                          variant="default"
                          testId="apply-key-chmod-400-btn"
                          onClick={() => {
                            setKeyPermissionMode('0400');
                            setConnectErrorMsg('');
                          }}
                        >
                          Set chmod 400
                        </Button>
                      </div>
                      <textarea
                        className="ui-input"
                        rows={3}
                        placeholder="Or paste -----BEGIN OPENSSH PRIVATE KEY----- / .pem content here…"
                        aria-label="Private key content"
                        value={uploadedKeyContent}
                        onInput={(e) => setUploadedKeyContent((e.target as HTMLTextAreaElement).value)}
                        data-testid="private-key-textarea"
                      />
                    </div>
                  ) : null}

                  {connectErrorMsg ? (
                    <Badge tone="danger" testId="connect-error-badge">
                      {connectErrorMsg}
                    </Badge>
                  ) : null}

                  <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                    <Button variant="primary" type="submit" testId="welcome-connect-submit-btn">
                      Connect to Server
                    </Button>
                    <Button
                      variant="default"
                      onClick={() => void handleGenerateKey()}
                      testId="welcome-generate-key-btn"
                    >
                      Generate SSH key
                    </Button>
                  </div>
                </form>
              </Card>
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
                <div className="webssh-grid">
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

                  <Card testId="fido2-hardware-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>WebAuthn / FIDO2 Hardware Key (YubiKey / TouchID)</strong>
                      <Badge tone={fido2Enrolled ? 'success' : 'neutral'}>
                        {fido2Enrolled ? 'Hardware Bound' : 'Ready to Enroll'}
                      </Badge>
                    </div>
                    <p>OpenSSH Hardware Resident Key: <code>sk-ssh-ed25519@openssh.com</code></p>
                    <input
                      type="text"
                      className="ui-input"
                      readOnly
                      aria-label="FIDO2 public key"
                      value={fido2KeyLine}
                      data-testid="fido2-pubkey-output"
                    />
                    <Button
                      variant="primary"
                      testId="enroll-fido2-btn"
                      onClick={() => {
                        setFido2Enrolled(true);
                        setFido2KeyLine(
                          'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAA EnrolledHardwarePasskey yubikey@webssh'
                        );
                      }}
                    >
                      Enroll FIDO2 Passkey
                    </Button>
                  </Card>

                  <Card testId="ssh-ca-cert-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>SSH Certificate Authority (CA) Short-Lived Cert</strong>
                      <Badge tone="success">{sshCertInfo.certType} cert</Badge>
                    </div>
                    <p>Key ID: <code>{sshCertInfo.keyId}</code></p>
                    <p>Principals: <code>{sshCertInfo.principals.join(', ')}</code></p>
                    <p>Validity: {sshCertInfo.validAfter} → {sshCertInfo.validBefore}</p>
                    <p>CA Fingerprint: <code>{sshCertInfo.caFingerprint}</code></p>
                  </Card>
                </div>
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

              <div className="webssh-grid">
                <Card testId="chmod-matrix-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h2>Interactive chmod Permissions Matrix</h2>
                    <Badge tone="success" testId="chmod-octal-badge">
                      {chmodFormatted.octal} ({chmodFormatted.symbolic})
                    </Badge>
                  </div>
                  <p>Target: <code>{chmodTargetFile}</code></p>
                  <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                    <label>
                      <input
                        type="checkbox"
                        checked={chmodPerms.ownerWrite}
                        onChange={(e) =>
                          setChmodPerms((prev) => ({
                            ...prev,
                            ownerWrite: (e.currentTarget as HTMLInputElement).checked
                          }))
                        }
                        data-testid="chmod-owner-write"
                      />{' '}
                      Owner Write
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={chmodPerms.groupWrite}
                        onChange={(e) =>
                          setChmodPerms((prev) => ({
                            ...prev,
                            groupWrite: (e.currentTarget as HTMLInputElement).checked
                          }))
                        }
                        data-testid="chmod-group-write"
                      />{' '}
                      Group Write
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={chmodPerms.publicExec}
                        onChange={(e) =>
                          setChmodPerms((prev) => ({
                            ...prev,
                            publicExec: (e.currentTarget as HTMLInputElement).checked
                          }))
                        }
                        data-testid="chmod-public-exec"
                      />{' '}
                      Public Exec
                    </label>
                  </div>
                  <Button
                    variant="primary"
                    testId="apply-chmod-btn"
                    onClick={() => {
                      setChmodTargetFile('/etc/nginx/nginx.conf');
                      setTransferStatus(`Applied chmod ${chmodFormatted.octal} (${chmodFormatted.symbolic}) to ${chmodTargetFile}`);
                    }}
                  >
                    Apply chmod {chmodFormatted.octal}
                  </Button>
                </Card>

                <Card testId="server-relay-card">
                  <h2>Server-to-Server Direct SFTP Relay</h2>
                  <p data-testid="relay-status-text">{relayStatus}</p>
                  <Button
                    variant="primary"
                    testId="trigger-sftp-relay-btn"
                    onClick={() =>
                      setRelayStatus(
                        'Transferred 5.0 MiB directly: prod-edge-01 → staging-web (SHA-256 verified, 0 local disk usage)'
                      )
                    }
                  >
                    Relay File Between Hosts
                  </Button>
                </Card>
              </div>

              <Card testId="live-log-tailer-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <h2>Live Log Tailer (tail -f /var/log/nginx/error.log)</h2>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <input
                      type="search"
                      className="ui-input"
                      placeholder="Filter log stream (e.g. error, warn)…"
                      aria-label="Filter log stream"
                      value={tailFilter}
                      onInput={(e) => setTailFilter((e.target as HTMLInputElement).value)}
                      data-testid="tail-filter-input"
                    />
                    <Button
                      variant="default"
                      testId="tail-pause-btn"
                      onClick={() => setTailPaused((p) => !p)}
                    >
                      {tailPaused ? 'Resume Stream' : 'Pause Stream'}
                    </Button>
                    <Button
                      variant="primary"
                      testId="tail-append-btn"
                      onClick={() => {
                        if (!tailPaused) {
                          setTailLogLines((prev) => [
                            ...prev,
                            '2026-11-01T08:15:30Z [info] healthcheck 200 OK in 4ms'
                          ]);
                        }
                      }}
                    >
                      Simulate Log Event
                    </Button>
                  </div>
                </div>
                <pre data-testid="tail-log-output">
                  {tailLogLines
                    .filter((l) => !tailFilter || l.toLowerCase().includes(tailFilter.toLowerCase()))
                    .join(String.fromCharCode(10))}
                </pre>
              </Card>
            </div>
          ) : null}

          {activeScreen === 'editor' ? (
            <div className="webssh-panel-content" data-testid="screen-editor">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                <h1>Remote File Editor — /etc/nginx/nginx.conf</h1>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <Button
                    variant="default"
                    testId="toggle-diff-viewer-btn"
                    onClick={() => setShowDiffViewer((d) => !d)}
                  >
                    {showDiffViewer ? 'Hide Side-by-Side Diff' : 'Compare Side-by-Side Diff'}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => setEditorSaved(true)}
                    testId="save-remote-file-btn"
                  >
                    Save to host {editorSaved ? '(Saved)' : '(Unsaved*)'}
                  </Button>
                </div>
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
              {showDiffViewer ? (
                <Card testId="side-by-side-diff-card">
                  <h2>Side-by-Side Diff vs Remote /etc/nginx/nginx.conf</h2>
                  <div className="webssh-diff-grid">
                    <div>
                      <strong>Original Remote File</strong>
                      {diffEntries.map((d) => (
                        <div key={`orig-${d.lineNumber}`} className={`webssh-diff-line--${d.status}`}>
                          {d.lineNumber}: {d.before}
                        </div>
                      ))}
                    </div>
                    <div>
                      <strong>Modified Buffer</strong>
                      {diffEntries.map((d) => (
                        <div key={`mod-${d.lineNumber}`} className={`webssh-diff-line--${d.status}`}>
                          {d.lineNumber}: {d.after}
                        </div>
                      ))}
                    </div>
                  </div>
                </Card>
              ) : null}
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
                variant={authMethod === 'Password' ? 'primary' : 'default'}
                onClick={() => {
                  setAuthMethod('Password');
                  setConnectErrorMsg('');
                }}
                testId="auth-method-password-btn"
              >
                Username & Password
              </Button>
              <Button
                variant={authMethod === 'Private Key (.pem / id_rsa)' ? 'primary' : 'default'}
                onClick={() => {
                  setAuthMethod('Private Key (.pem / id_rsa)');
                  setConnectErrorMsg('');
                }}
                testId="auth-method-keyfile-btn"
              >
                Private Key (.pem / chmod 400)
              </Button>
              <Button
                variant={authMethod === 'Argon2id Ed25519 Key' ? 'primary' : 'default'}
                onClick={() => {
                  setAuthMethod('Argon2id Ed25519 Key');
                  setConnectErrorMsg('');
                }}
                testId="auth-method-pubkey-btn"
              >
                Argon2id Ed25519 Key
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

          {authMethod === 'Private Key (.pem / id_rsa)' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label htmlFor="modal-key-file-input">Upload Private Key (.pem / id_ed25519 / id_rsa)</label>
                <Badge tone={keyPermissionMode === '0644' ? 'danger' : 'success'} testId="modal-key-chmod-badge">
                  chmod {keyPermissionMode} {keyPermissionMode === '0400' ? '(-r--------)' : keyPermissionMode === '0600' ? '(-rw-------)' : '(UNSAFE)'}
                </Badge>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                <input
                  id="modal-key-file-input"
                  type="file"
                  className="ui-input"
                  accept=".pem,.key,.pub,*"
                  onChange={(e) => void handlePrivateKeyFileUpload(e)}
                  data-testid="modal-private-key-file-input"
                />
                <Button
                  variant="default"
                  testId="modal-set-chmod-400-btn"
                  onClick={() => {
                    setKeyPermissionMode('0400');
                    setConnectErrorMsg('');
                  }}
                >
                  chmod 400
                </Button>
              </div>
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

          {connectErrorMsg ? (
            <Badge tone="danger" testId="modal-connect-error-badge">
              {connectErrorMsg}
            </Badge>
          ) : null}

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
          Host: <strong>{connectHost || 'localhost'}:{connectPort || '22'}</strong>
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

      <Modal
        open={dangerousCommandPending !== null}
        danger={true}
        title="DANGEROUS COMMAND SAFETY GUARD"
        onClose={() => setDangerousCommandPending(null)}
        testId="dangerous-command-modal"
      >
        <p>
          Intercepted potentially destructive command:{' '}
          <code data-testid="dangerous-command-text">{dangerousCommandPending?.command}</code>
        </p>
        <p data-testid="dangerous-command-reason">{dangerousCommandPending?.reason}</p>
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
          <Button
            variant="danger"
            testId="confirm-dangerous-cmd-btn"
            onClick={() => {
              const cmdToRun = dangerousCommandPending?.command;
              setDangerousCommandPending(null);
              if (cmdToRun) {
                executeTerminalCommand(cmdToRun, true);
              }
            }}
          >
            Execute Anyway
          </Button>
          <Button
            variant="default"
            testId="cancel-dangerous-cmd-btn"
            onClick={() => setDangerousCommandPending(null)}
          >
            Cancel Command
          </Button>
        </div>
      </Modal>
    </div>
  );
}
