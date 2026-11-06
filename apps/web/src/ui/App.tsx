import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Modal,
  THEME_IDS,
  THEMES,
  applyThemeToDocument,
  type ThemeId
} from '@webssh/ui-kit';
import {
  KeyVault,
  KnownHostsStore,
  base64ToBytes,
  bytesToBase64,
  validateAndInspectPrivateKeyPem
} from '../vault';
import { HostRegistry, type HostProfile } from '../hosts';
import { PreferencesStore, type CursorShape, type LayoutPreset, type WorkspacePreset } from '../prefs';
import { XtermPaneAdapter, type TerminalRendererMode } from '../terminal/xterm-adapter';
import { TerminalPane, type PaneTransport } from '../terminal/TerminalPane';
import { ChannelOutputBuffer } from '../terminal/channel-output-buffer';
import { ConnectionRegistry, nextConnectionId } from '../session/connection-registry';
import { lazy, Suspense } from 'preact/compat';
import { AppHeader, type MenuId } from './shell/AppHeader';
import { AppRail } from './shell/AppRail';
import { SettingsScreen, type SettingsSection } from './shell/SettingsScreen';
import { WelcomeScreen } from './shell/WelcomeScreen';
import {
  BrowserSshRelaySessionClient,
  LiveGatewaySessionClient,
  deriveGatewayHealthUrl,
  loginToCloudflareRelay,
  requestConnectionTicket,
  resolveGatewayWsUrl,
  resolveTransportBackendMode,
  validateGatewayWsUrl,
  type TransportBackendMode
} from '../transport';
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
import { readRemoteFile, writeRemoteFile, REMOTE_INLINE_WRITE_BYTES, type SftpOp } from '../files/remote-file-io';
import {
  computeGhostAutocomplete,
  computeSideBySideDiff,
  detectDangerousCommand,
  formatChmodOctal,
  redactSecretsInText,
  type ChmodPermissions,
  type CommandBlockEntry,
  type SshCertificateInfo,
  type SshTunnelRule
} from './advanced-features';
import type { ModuleContext } from './ServerModules';
import { createRemoteSession, decodeUtf8Text, type WorkspaceRemoteSession } from '../session/adapters';
// Workspace screens are split out of the initial bundle: the IDE and the
// server modules (Docker/Kubernetes/git) are only loaded when opened, so the
// terminal is interactive without parsing them.
const LightIde = lazy(() => import('./LightIde').then((m) => ({ default: m.LightIde })));
const CapabilityMatrixPanel = lazy(() =>
  import('./CapabilityMatrixPanel').then((m) => ({ default: m.CapabilityMatrixPanel }))
);
const OverviewPanel = lazy(() => import('./ServerModules').then((m) => ({ default: m.OverviewPanel })));
const SoftwarePanel = lazy(() => import('./ServerModules').then((m) => ({ default: m.SoftwarePanel })));
const ContainersPanel = lazy(() =>
  import('./ServerModules').then((m) => ({ default: m.ContainersPanel }))
);
const KubernetesPanel = lazy(() =>
  import('./ServerModules').then((m) => ({ default: m.KubernetesPanel }))
);
const DeploymentsPanel = lazy(() =>
  import('./ServerModules').then((m) => ({ default: m.DeploymentsPanel }))
);
const AutomationsPanel = lazy(() =>
  import('./ServerModules').then((m) => ({ default: m.AutomationsPanel }))
);
const ActivityPanel = lazy(() => import('./ServerModules').then((m) => ({ default: m.ActivityPanel })));
import {
  MAX_RECONNECT_ATTEMPTS,
  connectionHealthRows,
  describeReconnectAttempt,
  formatRtt,
  formatUptime,
  reconnectDelayMs,
  reconnectOutcomeMessage
} from './session-health';
import type { ServerCapabilities } from '../discovery/capabilities';

export type ScreenId =
  | 'workspace'
  | 'features'
  | 'tunnels'
  | 'welcome'
  | 'vault'
  | 'hosts'
  | 'files'
  | 'editor'
  | 'ide'
  | 'snippets'
  | 'settings'
  | 'overview'
  | 'software'
  | 'containers'
  | 'kubernetes'
  | 'automations'
  | 'deployments'
  | 'activity'
  | 'server-tools';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'resumed'
  | 'failed';

export type AuthMethod = 'Password' | 'Private Key (.pem / id_rsa)' | 'Argon2id Ed25519 Key';

export type KeyPermissionMode = '0400' | '0600' | '0644';

export type LocalEntry = {
  name: string;
  kind: 'file' | 'directory';
  size: number;
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
};

export interface SessionTabItem {
  id: string;
  title: string;
  connected: boolean;
  channelId?: number;
  /** The transport this pane belongs to. */
  connectionId?: string;
  /** A pane is ready only after the server acknowledged the PTY channel. */
  status?: 'idle' | 'opening' | 'ready' | 'error';
  errorMessage?: string;
}

/** ProxyJump hops from a saved host, and the host/port they belong to. */
export interface PendingJump {
  targetHost: string;
  targetPort: number;
  hops: { host: string; port: number; user: string }[];
}

/**
 * The site key is public. It comes from the build environment, with a runtime
 * global as a fallback (the same pattern as the gateway URL override).
 */
function resolveTurnstileSiteKey(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const configured =
      env?.VITE_TURNSTILE_SITE_KEY ??
      (globalThis as unknown as { __WEBSSH_TURNSTILE_SITE_KEY__?: string })
        .__WEBSSH_TURNSTILE_SITE_KEY__ ??
      '';
    return configured.trim();
  } catch {
    return '';
  }
}

export function App(): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const terminalViewRef = useRef<HTMLDivElement | null>(null);
  // One adapter per pane; incoming PTY bytes are routed by channel, never to a
  // single shared terminal.
  const paneAdaptersRef = useRef<Map<string, XtermPaneAdapter>>(new Map());
  // Output that arrives before its pane can render. Without this a PTY's first
  // banner and prompt are dropped and the terminal looks blank.
  const channelOutputRef = useRef(new ChannelOutputBuffer());

  const turnstileSiteKey = resolveTurnstileSiteKey();
  const prefsStore = useMemo(() => new PreferencesStore(), []);
  const hostRegistry = useMemo(() => new HostRegistry(), []);

  const vault = useMemo(() => new KeyVault(), []);
  const knownHosts = useMemo(() => new KnownHostsStore(), []);
  const liveSessionRef = useRef<LiveGatewaySessionClient | BrowserSshRelaySessionClient | null>(null);
  const hostImportInputRef = useRef<HTMLInputElement | null>(null);
  const paletteInputRef = useRef<HTMLInputElement | null>(null);
  const termSearchInputRef = useRef<HTMLInputElement | null>(null);
  // Every live transport, so opening a second server never closes the first.
  const connectionRegistryRef = useRef(
    new ConnectionRegistry<LiveGatewaySessionClient | BrowserSshRelaySessionClient>()
  );
  // A guest ticket is bound to one host/port and expires quickly, so it is
  // cached here instead of in the administrator token state.
  const guestTicketRef = useRef<{
    token: string;
    host: string;
    port: number;
    expiresAt: number;
  } | null>(null);
  const connectInFlightRef = useRef<boolean>(false);
  const hostKeyDecisionResolverRef = useRef<((trusted: boolean) => void) | null>(null);
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
  // Session recording taps the active pane's bytes, not a demo: the raw
  // asciicast text is kept so Download writes exactly what was captured.
  const [recording, setRecording] = useState(false);
  const [recordedCastText, setRecordedCastText] = useState<string | null>(null);
  const [recordScrubber, setRecordScrubber] = useState(0);
  const [recordNotice, setRecordNotice] = useState<string>('');
  const recorderRef = useRef<AsciicastRecorder | null>(null);
  // A recording belongs to the tab it started on: following the active tab
  // would mix two servers' output under one title.
  const recordTabIdRef = useRef<string | null>(null);
  // The split pane is a second shell on the same connection; it belongs to
  // the recording when the recorded tab owns that connection.
  const recordConnectionRef = useRef<string | null>(null);
  // PTY chunks can split a multi-byte character; decode as a stream so the
  // cast matches what the terminal rendered.
  const recordDecoderRef = useRef<TextDecoder | null>(null);
  const recordedCast = useMemo(
    () => (recordedCastText ? parseAsciicastV2(recordedCastText) : null),
    [recordedCastText]
  );
  const [termSearchOpen, setTermSearchOpen] = useState(false);
  const [termSearchQuery, setTermSearchQuery] = useState<string>(() => {
    try {
      return localStorage?.getItem('webssh.termSearch.lastQuery') ?? '';
    } catch {
      return '';
    }
  });
  const [termSearchStatus, setTermSearchStatus] = useState('');

  /** Search the active pane's scrollback through xterm's search addon. */
  const runTerminalSearch = (direction: 1 | -1): void => {
    const term = termSearchQuery.trim();
    if (term.length === 0) {
      setTermSearchStatus('');
      return;
    }
    const adapter = paneAdaptersRef.current.get(activeTabIdRef.current);
    if (!adapter || connectionState !== 'connected') {
      setTermSearchStatus('No terminal to search — connect first.');
      return;
    }
    const found = direction === 1 ? adapter.findNext(term) : adapter.findPrevious(term);
    setTermSearchStatus(found ? '' : 'No match');
  };

  const openTerminalSearch = (): void => {
    setTermSearchOpen(true);
    setTermSearchStatus('');
  };

  const closeTerminalSearch = (): void => {
    setTermSearchOpen(false);
    setTermSearchStatus('');
    const adapter = paneAdaptersRef.current.get(activeTabIdRef.current);
    if (adapter) {
      adapter.focus();
    } else {
      terminalViewRef.current?.focus();
    }
  };

  const [splitPaneChannel, setSplitPaneChannel] = useState<number | null>(null);
  const [showCommandInspector, setShowCommandInspector] = useState<boolean>(false);
  const [rendererNotice, setRendererNotice] = useState<string>('');
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const splitChannelRef = useRef<number | null>(null);
  splitChannelRef.current = splitPaneChannel;
  const splitOwnerRef = useRef<string | undefined>(undefined);

  // Default to clean Welcome screen & Minimal Mode (IDE mode disabled until requested)
  const [activeScreen, setActiveScreen] = useState<ScreenId>('welcome');
  const [ideMode, setIdeMode] = useState<boolean>(false);
  const [activeTheme, setActiveTheme] = useState<ThemeId>(() => {
    const stored = prefsStore.get().activeThemeId;
    return (THEME_IDS as readonly string[]).includes(stored) ? (stored as ThemeId) : 'dark';
  });
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() => {
    const stored = prefsStore.get().density;
    return stored === 'compact' ? 'compact' : 'comfortable';
  });
  const [layoutPreset, setLayoutPreset] = useState<LayoutPreset>(() => prefsStore.get().layoutPreset);
  const [workspacePreset, setWorkspacePreset] = useState<WorkspacePreset>(
    () => prefsStore.get().workspacePreset
  );
  const [railWidth, setRailWidth] = useState<number>(() => prefsStore.get().railWidthPx);
  const [railOpen, setRailOpen] = useState<boolean>(false);
  const [cursorShape, setCursorShape] = useState<CursorShape>(() => prefsStore.get().surface.cursorShape);
  const [zenMode, setZenMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
  const [showOverlayBar, setShowOverlayBar] = useState(false);
  const [showFullscreenToast, setShowFullscreenToast] = useState(false);

  // 3. Fresh Default State (Zero Pre-Populated Mock Data)
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [rttMs, setRttMs] = useState(0);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);
  const [reconnectNotice, setReconnectNotice] = useState<string | null>(null);
  const [reconnectMessage, setReconnectMessage] = useState<string | null>(null);
  const [reconnectCountdown, setReconnectCountdown] = useState<number | null>(null);
  const [connectionPanelOpen, setConnectionPanelOpen] = useState(false);
  // Jump hops belong to the saved host they came from. They are only sent when
  // the form still targets that host, so editing the host cannot silently
  // route a new connection through an unrelated bastion.
  const [pendingJump, setPendingJump] = useState<PendingJump | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  // Connections the user closed explicitly must never be resurrected by the
  // auto-reconnect loop; this is per connection, not global.
  const suppressedReconnectRef = useRef<Set<string>>(new Set());
  // Per-tab PTY channel ids captured before a drop. A gateway resume has to
  // put every pane back on its own channel, not on the session's first one.
  const channelSnapshotRef = useRef<Map<string, number>>(new Map());
  const [, setUptimeTick] = useState(0);

  // Uptime only needs a heartbeat render while a session is actually up.
  useEffect(() => {
    if (connectionState !== 'connected' || connectedAt === null) return;
    const timer = setInterval(() => setUptimeTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [connectionState, connectedAt]);

  useEffect(() => () => clearReconnectTimer(), []);

  useEffect(() => {
    try {
      localStorage?.setItem('webssh.termSearch.lastQuery', termSearchQuery);
    } catch {
      // Storage unavailable — search query won't persist across reloads.
    }
  }, [termSearchQuery]);
  const [sessionTabLabel, setSessionTabLabel] = useState<string>('Terminal 1');
  const [connectedUser, setConnectedUser] = useState<string>('');
  const [environmentLabel, setEnvironmentLabel] = useState<string>('');

  /** Derive an environment label from the host name for quick context. */
  function deriveEnvironmentLabel(host: string): string {
    const lower = host.toLowerCase();
    if (lower.includes('prod') || lower.includes('production')) return 'Production';
    if (lower.includes('stag') || lower.includes('staging')) return 'Staging';
    if (lower.includes('dev') || lower.includes('development') || lower === 'localhost' || lower === '127.0.0.1') return 'Development';
    if (lower.includes('test') || lower.includes('testing')) return 'Test';
    return '';
  }

  const startRecording = (): void => {
    // Only a live session has bytes worth recording; starting on a
    // disconnected pane would produce an empty file that looks like a bug.
    if (connectionState !== 'connected') {
      setRecordedCastText(null);
      return;
    }
    recorderRef.current = new AsciicastRecorder(cols, rows, sessionTabLabel);
    recordTabIdRef.current = activeTabIdRef.current;
    recordConnectionRef.current =
      tabsRef.current.find((t) => t.id === activeTabIdRef.current)?.connectionId ?? null;
    recordDecoderRef.current = new TextDecoder('utf-8');
    setRecordNotice('');
    setRecording(true);
  };

  const stopRecording = (): number => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    const tail = recordDecoderRef.current?.decode() ?? '';
    recordDecoderRef.current = null;
    recordTabIdRef.current = null;
    recordConnectionRef.current = null;
    if (!rec) return 0;
    if (tail) rec.recordOutput(tail);
    if (rec.isCapped()) {
      setRecordNotice(`Recording stopped at its size cap; later output from this session was not captured.`);
    }
    const cast = rec.exportCast();
    const parsed = parseAsciicastV2(cast);
    setRecordedCastText(cast);
    setRecordScrubber(parsed.events.length > 0 ? parsed.events[parsed.events.length - 1]![0] : 0);
    return parsed.events.length;
  };

  const downloadRecording = (): void => {
    if (!recordedCastText) return;
    const blob = new Blob([recordedCastText], { type: 'application/x-asciicast' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webssh-session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.cast`;
    a.click();
    // Firefox cancels the download when the URL is revoked in the same task.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  // A dropped session cannot keep recording; stop and keep what was captured.
  useEffect(() => {
    if (connectionState !== 'connected' && recorderRef.current) {
      stopRecording();
    }
    // stopRecording closes over nothing mutable beyond refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState]);

  // Switching tabs stops the recording instead of silently mixing servers.
  useEffect(() => {
    if (recorderRef.current && recordTabIdRef.current !== activeTabIdRef.current) {
      const events = stopRecording();
      setRecordNotice(`Recording stopped when you switched tabs; ${events} events were kept.`);
    }
    // stopRecording closes over nothing mutable beyond refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);
  const [connectedHost, setConnectedHost] = useState<string>('');
  const [remoteSession, setRemoteSession] = useState<WorkspaceRemoteSession | null>(null);
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  const discoverForSession = async (
    session: WorkspaceRemoteSession | null
  ): Promise<ServerCapabilities | null> => {
    if (!session) return null;
    setDiscoveryBusy(true);
    setDiscoveryError(null);
    try {
      const { runDiscovery } = await import('./ServerModules');
      const result = await runDiscovery(session);
      setCapabilities(result);
      return result;
    } catch (err) {
      setDiscoveryError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setDiscoveryBusy(false);
    }
  };

  const moduleContext: ModuleContext = {
    session: remoteSession,
    capabilities,
    onDiscover: () => discoverForSession(remoteSession),
    discoveryBusy,
    discoveryError
  };
  const [pendingInputBytes, setPendingInputBytes] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [hostKeyModal, setHostKeyModal] = useState<'none' | 'tofu' | 'mismatch'>('none');
  const [hosts, setHosts] = useState<HostProfile[]>(() => hostRegistry.list());
  const [cacheRepairStatus, setCacheRepairStatus] = useState<string>('');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
  const [hostSearch, setHostSearch] = useState('');
  const [hostTransferStatus, setHostTransferStatus] = useState('');
  const [sshConfigInput, setSshConfigInput] = useState('');
  const [generatedPubKey, setGeneratedPubKey] = useState(
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWebSSHStudioBrowserNonExtractableKey webssh@browser'
  );
  const [generatedFp, setGeneratedFp] = useState('');
  const [vaultLocked, setVaultLocked] = useState(false);
  const [fileFilter, setFileFilter] = useState('');
  const [transferStatus, setTransferStatus] = useState<string>('Disconnected — Connect to an SSH host to browse SFTP files');
  const [sftpRawEntries, setSftpRawEntries] = useState<
    { name: string; path: string; size: number; mode: string; modTime: number; isDir: boolean }[]
  >([]);
  const [sftpCurrentPath, setSftpCurrentPath] = useState<string>('~');
  // Local pane. Chromium exposes the File System Access API; anywhere else we
  // say so instead of rendering a fake directory listing.
  const [localDirHandle, setLocalDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [localDirName, setLocalDirName] = useState<string>('');
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const [localStatus, setLocalStatus] = useState<string>(
    'No local folder selected. Upload and download still work without one.'
  );
  const [editorFilePath, setEditorFilePath] = useState<string>('README.md');
  const [editorOriginalContent, setEditorOriginalContent] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [editorSaved, setEditorSaved] = useState(true);
  const [editorLoadedPath, setEditorLoadedPath] = useState<string | null>(null);
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorConflict, setEditorConflict] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [renameTarget, setRenameTarget] = useState<{ path: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; name: string } | null>(null);
  const [transportMode, setTransportMode] = useState<TransportBackendMode>(() =>
    resolveTransportBackendMode()
  );
  const [gatewayUrl, setGatewayUrl] = useState<string>(() => resolveGatewayWsUrl());
  const [gatewayAuthToken, setGatewayAuthToken] = useState<string>(() => {
    try {
      return globalThis.sessionStorage?.getItem('webssh.gateway.authToken') ?? '';
    } catch {
      return '';
    }
  });
  const [gatewayProbeStatus, setGatewayProbeStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [relayLoginUser, setRelayLoginUser] = useState<string>('');
  const [relayLoginPass, setRelayLoginPass] = useState<string>('');
  const [turnstileToken, setTurnstileToken] = useState<string>('');
  const [turnstileResetNonce, setTurnstileResetNonce] = useState<number>(0);
  const [relaySessionUser, setRelaySessionUser] = useState<string>(() => {
    try {
      const raw = globalThis.sessionStorage?.getItem('webssh.relay.session');
      if (!raw) return '';
      const parsed = JSON.parse(raw) as { userId?: unknown };
      return typeof parsed.userId === 'string' ? parsed.userId : '';
    } catch {
      return '';
    }
  });

  /**
   * Product sign-in. The relay session token is obtained from the configured
   * endpoint and kept in session storage; the user never sees or enters it.
   */
  const handleRelayLogin = async (): Promise<void> => {
    if (!relayLoginUser.trim() || !relayLoginPass) {
      setGatewayProbeStatus({ ok: false, message: 'Enter your username and password to sign in.' });
      return;
    }
    try {
      const res = await loginToCloudflareRelay(gatewayUrl, relayLoginUser, relayLoginPass);
      setGatewayAuthToken(res.token);
      setRelaySessionUser(res.userId);
      setRelayLoginPass('');
      try {
        globalThis.sessionStorage?.setItem(
          'webssh.relay.session',
          JSON.stringify({ userId: res.userId, token: res.token })
        );
        globalThis.sessionStorage?.setItem('webssh.gateway.authToken', res.token);
      } catch {
        // Session storage may be unavailable; the token stays in memory.
      }
      setGatewayProbeStatus({
        ok: true,
        message: `Signed in as ${res.userId} · session expires in ${Math.round(res.expiresIn / 60)}m`
      });
    } catch (err) {
      setGatewayProbeStatus({
        ok: false,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const handleRelaySignOut = (): void => {
    setRelaySessionUser('');
    setGatewayAuthToken('');
    setGatewayProbeStatus(null);
    try {
      globalThis.sessionStorage?.removeItem('webssh.relay.session');
      globalThis.sessionStorage?.removeItem('webssh.gateway.authToken');
    } catch {
      // ignore
    }
  };
  const [negotiatedCipher, setNegotiatedCipher] = useState<string>('');
  const [negotiatedServerVersion, setNegotiatedServerVersion] = useState<string>('');
  const [pendingHostKeyPrompt, setPendingHostKeyPrompt] = useState<{
    host: string;
    port: number;
    algorithm: string;
    fingerprint: string;
    publicKeyBase64: string;
    expectedFingerprint?: string;
  } | null>(null);
  const [tunnelPreviewOutput, setTunnelPreviewOutput] = useState<string>(
    'Connect to an SSH host and click Probe HTTP Preview to inspect remote localhost HTTP responses.'
  );
  const [scrubberSec, setScrubberSec] = useState(2.5);
  const [snippetVarService, setSnippetVarService] = useState('sshd');
  const [snippetVarLines, setSnippetVarLines] = useState('50');

  // Step 12 Advanced Feature Suite State (Clean / Empty until connected or invoked)
  const [redactionMode, setRedactionMode] = useState<boolean>(false);
  const [dangerousCommandPending, setDangerousCommandPending] = useState<{ command: string; reason: string } | null>(null);
  const [commandBlocks, setCommandBlocks] = useState<CommandBlockEntry[]>([]);

  const [processFilter, setProcessFilter] = useState<string>('');

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
  const [tailFilePath, setTailFilePath] = useState<string>('/var/log/nginx/error.log');
  const [relayStatus, setRelayStatus] = useState<string>('Ready to relay files between two connected SSH hosts');

  const [sshCertInfo] = useState<SshCertificateInfo>({
    keyId: 'none',
    certType: 'user',
    principals: [],
    validAfter: '—',
    validBefore: '—',
    caFingerprint: '—',
    extensions: ['permit-pty', 'permit-port-forwarding']
  });


  // 50-Feature Explorer & Workbench State

  const [terminalLines, setTerminalLines] = useState<string[]>([
    'WebSSH Studio v1.0.0',
    "Type 'help' for local commands or click 'New Connection' to authenticate."
  ]);

  // 4. Interactive Terminal Input & Command Execution State
  const [currentInput, setCurrentInput] = useState<string>('');
  const currentInputRef = useRef<string>('');
  const [history, setHistory] = useState<string[]>([]);
  const historyRef = useRef<string[]>([]);
  const [, setHistoryIndex] = useState<number>(-1);
  const historyIndexRef = useRef<number>(-1);
  const [copiedSnippet, setCopiedSnippet] = useState<boolean>(false);

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
  // A chain outlives a failed attempt so Retry keeps the bastion, but it must
  // not leak into the next connection the user opens.
  useEffect(() => {
    if (!connectModalOpen) setPendingJump(null);
  }, [connectModalOpen]);
  // Hops from a saved host apply only while the form still targets that host.
  const activeJumpHops = useMemo(() => {
    const portNum = Number.parseInt(connectPort, 10);
    return pendingJump &&
      pendingJump.targetHost === connectHost.trim() &&
      pendingJump.targetPort === portNum &&
      pendingJump.hops.length > 0
      ? pendingJump.hops
      : undefined;
  }, [pendingJump, connectHost, connectPort]);
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

  const terminalPalette = THEMES[activeTheme] ?? THEMES.dark;
  const recentHosts = [...hosts]
    .filter((h) => typeof h.lastConnectedAt === 'number')
    .sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0))
    .slice(0, 5);
  const activeConnection = connectionRegistryRef.current.get(
    tabs.find((t) => t.id === activeTabId)?.connectionId
  );
  const splitPaneTransport = (activeConnection?.client as unknown as PaneTransport) ?? null;

  const activeSessionTitle = useMemo(() => {
    const found = tabs.find((t) => t.id === activeTabId);
    return found ? found.title : sessionTabLabel;
  }, [tabs, activeTabId, sessionTabLabel]);

  const writeToXterm = (text: string): void => {
    try {
      paneAdaptersRef.current.get(activeTabIdRef.current)?.writeText(text);
    } catch {
      // Ignore in headless environments without canvas
    }
  };

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

  const handleRendererChange = (_paneId: string, mode: TerminalRendererMode): void => {
    setRendererNotice((prev) => (prev === mode ? prev : mode));
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

  const refreshSftpDirectory = async (
    targetPath = sftpCurrentPath,
    sessionClient = liveSessionRef.current,
    preserveStatus = false
  ): Promise<void> => {
    if (!sessionClient || !sessionClient.isConnected) {
      if (!preserveStatus) {
        setTransferStatus('Disconnected — Connect to an SSH host to browse SFTP files');
      }
      return;
    }
    try {
      const res = await sessionClient.sftpOp({ op: 'list', path: targetPath });
      if (res.ok && res.entries) {
        setSftpCurrentPath(targetPath);
        setSftpRawEntries(res.entries);
        if (!preserveStatus) {
          setTransferStatus(`Listed ${res.entries.length} remote items in ${targetPath}`);
        }
      } else if (!preserveStatus) {
        setTransferStatus(`SFTP list error: ${res.error ?? 'Unknown error'}`);
      }
    } catch (err) {
      if (!preserveStatus) {
        setTransferStatus(`SFTP list failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const readRemoteFileComplete = async (
    remotePath: string,
    sessionClient: LiveGatewaySessionClient | BrowserSshRelaySessionClient
  ): Promise<{ bytes: Uint8Array } | { error: string }> =>
    sessionClient.sftpOp
      ? readRemoteFile(sessionClient.sftpOp.bind(sessionClient) as unknown as SftpOp, remotePath)
      : { error: 'This transport has no SFTP support.' };

  const writeRemoteFileBytes = async (
    remotePath: string,
    bytes: Uint8Array,
    sessionClient: LiveGatewaySessionClient | BrowserSshRelaySessionClient
  ): Promise<string | null> =>
    sessionClient.sftpOp
      ? writeRemoteFile(sessionClient.sftpOp.bind(sessionClient) as unknown as SftpOp, remotePath, bytes)
      : 'This transport has no SFTP support.';

  const loadRemoteFileIntoEditor = async (
    remotePath = editorFilePath,
    sessionClient = liveSessionRef.current
  ): Promise<void> => {
    if (!sessionClient || !sessionClient.isConnected) {
      return;
    }
    setEditorError(null);
    setEditorConflict(null);
    try {
      const read = await readRemoteFileComplete(remotePath, sessionClient);
      if ('error' in read) {
        setEditorError(read.error);
        return;
      }
      const text = decodeUtf8Text(read.bytes, remotePath);
      setEditorLoadedPath(remotePath);
      setEditorFilePath(remotePath);
      setEditorOriginalContent(text);
      setEditorContent(text);
      setEditorSaved(true);
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : String(err));
    }
  };

  const validEntryName = (name: string): boolean =>
    name.trim().length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !/[\u0000-\u001f]/.test(name);

  const sftpPathFor = (name: string): string =>
    `${sftpCurrentPath.replace(/\/$/, '')}/${name.trim()}`;

  const runSftpAction = async (
    label: string,
    request: () => Promise<{ ok: boolean; error?: string }>
  ): Promise<void> => {
    const activeClient = liveSessionRef.current;
    if (!activeClient || !activeClient.isConnected) {
      setTransferStatus(`${label} not applied: the SSH session is disconnected.`);
      return;
    }
    try {
      const res = await request();
      if (!res.ok) {
        setTransferStatus(`${label} failed: ${res.error ?? 'Unknown error'}`);
        return;
      }
      setTransferStatus(`${label} succeeded.`);
      void refreshSftpDirectory(sftpCurrentPath, activeClient, true);
    } catch (err) {
      setTransferStatus(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const createFolder = async (): Promise<void> => {
    const activeClient = liveSessionRef.current;
    if (!validEntryName(newFolderName)) {
      setTransferStatus('Folder name must be a single path segment without control characters.');
      return;
    }
    if (!activeClient) return;
    await runSftpAction(`Create folder ${newFolderName.trim()}`, () =>
      activeClient.sftpOp({ op: 'mkdir', path: sftpPathFor(newFolderName) })
    );
    setNewFolderName('');
  };

  const renameEntry = async (): Promise<void> => {
    const activeClient = liveSessionRef.current;
    if (!renameTarget || !validEntryName(renameTarget.name)) {
      setTransferStatus('New name must be a single path segment without control characters.');
      return;
    }
    if (!activeClient) return;
    await runSftpAction(`Rename ${renameTarget.path}`, () =>
      activeClient.sftpOp({
        op: 'rename',
        path: renameTarget.path,
        targetPath: sftpPathFor(renameTarget.name)
      })
    );
    setRenameTarget(null);
  };

  const deleteEntry = async (): Promise<void> => {
    const activeClient = liveSessionRef.current;
    if (!deleteTarget || !activeClient) return;
    await runSftpAction(`Delete ${deleteTarget.path}`, () =>
      activeClient.sftpOp({ op: 'remove', path: deleteTarget.path })
    );
    setDeleteTarget(null);
  };

  const uploadLocalFile = async (file: File): Promise<void> => {
    const activeClient = liveSessionRef.current;
    if (!activeClient || !activeClient.isConnected) {
      setTransferStatus('Upload not started: the SSH session is disconnected.');
      return;
    }
    if (file.size > 64 * 1024 * 1024) {
      setTransferStatus('Upload refused: files over 64 MiB are not uploaded from this panel.');
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.byteLength; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const target = `${sftpCurrentPath.replace(/\/$/, '')}/${file.name}`;
      setTransferStatus(`Uploading ${file.name} (${bytes.byteLength} bytes)…`);
      // A single write_file frame carries base64 plus JSON; above ~3 MiB it
      // exceeds the gateway's 4 MiB frame ceiling and kills the session. Use
      // the chunked ops the same way the IDE does.
      if (bytes.byteLength > REMOTE_INLINE_WRITE_BYTES) {
        await activeClient.sftpOp({ op: 'remove', path: `${target}.part` }).catch(() => undefined);
        await activeClient.sftpOp({ op: 'remove', path: `${target}.webssh-part` }).catch(() => undefined);
        const init = await activeClient.sftpOp({ op: 'upload_init', path: target });
        if (!init.ok) {
          setTransferStatus(`Upload failed: ${init.error ?? 'Could not start the upload'}`);
          return;
        }
        let offset = typeof init.offset === 'number' ? init.offset : 0;
        if (offset !== 0) {
          setTransferStatus(
            `Upload failed: ${target} already has a ${offset}-byte part file; refusing to write a corrupt file.`
          );
          return;
        }
        while (offset < bytes.byteLength) {
          const slice = bytes.subarray(offset, Math.min(offset + 256 * 1024, bytes.byteLength));
          const chunk = await activeClient.sftpOp({
            op: 'upload_chunk',
            path: target,
            offset,
            size: slice.byteLength,
            dataBase64: bytesToBase64(slice)
          });
          if (!chunk.ok) {
            setTransferStatus(`Upload failed: ${chunk.error ?? 'Chunk rejected'}`);
            return;
          }
          offset =
            typeof chunk.offset === 'number' && chunk.offset > offset
              ? chunk.offset
              : offset + slice.byteLength;
        }
        const commit = await activeClient.sftpOp({ op: 'upload_commit', path: target });
        if (!commit.ok) {
          setTransferStatus(`Upload failed: ${commit.error ?? 'Could not finish the upload'}`);
          return;
        }
      } else {
        const res = await activeClient.sftpOp({
          op: 'write_file',
          path: target,
          dataBase64: btoa(binary)
        });
        if (!res.ok) {
          setTransferStatus(`Upload failed: ${res.error ?? 'Unknown error'}`);
          return;
        }
      }
      setTransferStatus(`Uploaded ${file.name} to ${target} (${bytes.byteLength} bytes)`);
      void refreshSftpDirectory(sftpCurrentPath, activeClient, true);
    } catch (err) {
      setTransferStatus(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const readRemoteFileBytes = async (remotePath: string): Promise<Uint8Array | null> => {
    const activeClient = liveSessionRef.current;
    if (!activeClient || !activeClient.isConnected) {
      setTransferStatus('Download not started: the SSH session is disconnected.');
      return null;
    }
    try {
      const read = await readRemoteFileComplete(remotePath, activeClient);
      if ('error' in read) {
        setTransferStatus(`Download failed: ${read.error}`);
        return null;
      }
      return read.bytes;
    } catch (err) {
      setTransferStatus(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  const downloadRemoteFile = async (remotePath: string): Promise<void> => {
    const bytes = await readRemoteFileBytes(remotePath);
    if (!bytes) return;
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = remotePath.split('/').pop() || 'download.bin';
    a.click();
    // Firefox cancels the download if the object URL is revoked in the same
    // task as the click; let the browser start reading first.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setTransferStatus(`Downloaded ${remotePath} (${bytes.byteLength} bytes)`);
  };

  const localFsAccessSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  const refreshLocalDirectory = async (dir: FileSystemDirectoryHandle): Promise<void> => {
    const entries: LocalEntry[] = [];
    try {
      const handles = (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
      for await (const handle of handles) {
        let size = 0;
        if (handle.kind === 'file') {
          try {
            size = (await (handle as FileSystemFileHandle).getFile()).size;
          } catch {
            size = 0;
          }
        }
        entries.push({
          name: handle.name,
          kind: handle.kind,
          size,
          handle: handle as FileSystemFileHandle | FileSystemDirectoryHandle
        });
      }
    } catch (err) {
      setLocalStatus(`Could not list the local folder: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1
    );
    setLocalEntries(entries);
    setLocalStatus(`${entries.length} local entr${entries.length === 1 ? 'y' : 'ies'} in ${dir.name}`);
  };

  const pickLocalDirectory = async (): Promise<void> => {
    if (!localFsAccessSupported) {
      setLocalStatus('This browser has no File System Access API (Firefox, Safari). Use Upload and Download instead.');
      return;
    }
    try {
      const dir = await (
        window as unknown as { showDirectoryPicker: (o?: { mode?: string }) => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker({ mode: 'readwrite' });
      setLocalDirHandle(dir);
      setLocalDirName(dir.name);
      await refreshLocalDirectory(dir);
    } catch (err) {
      // A cancelled picker is not an error worth shouting about.
      if (err instanceof Error && err.name === 'AbortError') return;
      setLocalStatus(`Could not open the local folder: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const uploadLocalEntry = async (entry: LocalEntry): Promise<void> => {
    if (entry.kind !== 'file') {
      setTransferStatus(`${entry.name} is a folder; only files are uploaded from the local pane.`);
      return;
    }
    try {
      const file = await (entry.handle as FileSystemFileHandle).getFile();
      await uploadLocalFile(file);
      if (localDirHandle) void refreshLocalDirectory(localDirHandle);
    } catch (err) {
      setTransferStatus(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const downloadToLocalDirectory = async (remotePath: string): Promise<void> => {
    if (!localDirHandle) {
      setLocalStatus('Choose a local folder before downloading into it.');
      return;
    }
    const bytes = await readRemoteFileBytes(remotePath);
    if (!bytes) return;
    const name = remotePath.split('/').pop() || 'download.bin';
    try {
      const existing = await localDirHandle.getFileHandle(name).catch(() => null);
      if (existing && !window.confirm(`${localDirName}/${name} already exists. Overwrite it?`)) {
        setTransferStatus(`Download cancelled: ${localDirName}/${name} was left unchanged.`);
        return;
      }
      const handle = existing ?? (await localDirHandle.getFileHandle(name, { create: true }));
      const writable = await handle.createWritable();
      // Copy into a freshly allocated buffer: TS 5.7 widens a sliced
      // Uint8Array to ArrayBufferLike, which FileSystemWriteChunkType rejects.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      await writable.write(copy.buffer);
      await writable.close();
      setTransferStatus(`Downloaded ${remotePath} into ${localDirName}/${name} (${bytes.byteLength} bytes)`);
      void refreshLocalDirectory(localDirHandle);
    } catch (err) {
      setTransferStatus(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRemoteDrop = (event: DragEvent): void => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    void (async () => {
      for (const file of files) {
        await uploadLocalFile(file);
      }
    })();
  };

  const readRemoteLog = async (): Promise<void> => {
    const activeClient = liveSessionRef.current;
    if (!activeClient || !activeClient.isConnected) {
      setTransferStatus('Cannot read logs: the SSH session is disconnected.');
      return;
    }
    const path = tailFilePath.trim();
    if (!path.startsWith('/') || /[\u0000-\u001f]/.test(path)) {
      setTransferStatus('Log path must be an absolute path without control characters.');
      return;
    }
    try {
      const quoted = `'${path.replace(/'/g, `'\\''`)}'`;
      const res = await activeClient.execCommand(`tail -n 200 -- ${quoted} 2>&1`, 20_000);
      setTailLogLines(res.stdout.split(/\r?\n/));
      if (res.exitCode !== 0) {
        setTransferStatus(`Reading ${path} exited with code ${res.exitCode}; output shown as returned`);
      }
    } catch (err) {
      setTransferStatus(`Reading ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * Save the editor buffer. Refuses when the remote file changed since it was
   * loaded, and never reports success unless the write actually succeeded.
   */
  const saveEditorBuffer = async (overwrite = false): Promise<void> => {
    const activeClient = liveSessionRef.current;
    if (!activeClient || !activeClient.isConnected) {
      setEditorError('Not saved: the SSH session is disconnected. Reconnect before saving.');
      return;
    }
    setEditorError(null);
    try {
      if (!overwrite) {
        const current = await readRemoteFileComplete(editorFilePath, activeClient);
        // Fail closed: if the file cannot be re-read, a blind write could
        // silently destroy another operator's change.
        if ('error' in current) {
          setEditorError(
            `Not saved: could not re-read ${editorFilePath} to check for conflicts (${current.error}). Retry, or use "Overwrite with my version" if you accept the risk.`
          );
          return;
        }
        // A file that turned non-UTF-8 under us counts as changed: the text
        // comparison below cannot speak for it, so do not write over it.
        let currentText: string | null = null;
        try {
          currentText = decodeUtf8Text(current.bytes, editorFilePath);
        } catch {
          currentText = null;
        }
        if (currentText === null || currentText !== editorOriginalContent) {
          setEditorConflict(
            `${editorFilePath} changed on the server since you opened it. Saving now would overwrite those changes.`
          );
          return;
        }
      }
      const writeError = await writeRemoteFileBytes(
        editorFilePath,
        new TextEncoder().encode(editorContent),
        activeClient
      );
      if (writeError) {
        setEditorError(`Save failed: ${writeError}`);
        return;
      }
      setEditorLoadedPath(editorFilePath);
      setEditorOriginalContent(editorContent);
      setEditorSaved(true);
      setEditorConflict(null);
      setTransferStatus(`Saved ${editorFilePath} over SFTP`);
      void refreshSftpDirectory(sftpCurrentPath, activeClient);
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTestGateway = async (rawUrl = gatewayUrl): Promise<void> => {
    const check = validateGatewayWsUrl(rawUrl);
    if (!check.valid) {
      setGatewayProbeStatus({
        ok: false,
        message: check.error ?? 'Invalid Gateway WebSocket URL.'
      });
      return;
    }
    const healthUrl = deriveGatewayHealthUrl(check.normalizedUrl);
    try {
      const res = await fetch(healthUrl, { method: 'GET' });
      if (!res.ok) {
        setGatewayProbeStatus({
          ok: false,
          message: `Gateway returned HTTP ${res.status} at ${healthUrl}`
        });
        return;
      }
      const data = (await res.json()) as {
        status?: string;
        activeSessions?: number;
        tlsEnabled?: boolean;
        authRequired?: boolean;
        mode?: string;
        missingConfiguration?: string[];
      };
      if (data.status !== 'ok') {
        setGatewayProbeStatus({
          ok: false,
          message: `Backend setup incomplete: ${data.missingConfiguration?.join(', ') || data.status || 'invalid health response'}`
        });
        return;
      }
      if ((data.mode === 'cloudflare-relay') !== (transportMode === 'cloudflare-relay')) {
        setGatewayProbeStatus({ ok: false, message: 'Transport mode does not match this endpoint. Select the matching SSH Transport Mode.' });
        return;
      }
      setGatewayProbeStatus({
        ok: true,
        message: `Backend Online (${healthUrl}) · Active Sessions: ${data.activeSessions ?? 0} · TLS: ${
          data.tlsEnabled ? 'WSS Enabled' : 'HTTP/WS'
        } · Auth: ${data.authRequired ? 'Token Required' : 'Open'}`
      });
    } catch (err) {
      setGatewayProbeStatus({
        ok: false,
        message: `Gateway unreachable at ${healthUrl} (${err instanceof Error ? err.message : String(err)})`
      });
    }
  };

  const handleAddTab = (): void => {
    const nextNum = tabs.length + 1;
    const newId = `tab-${Date.now()}-${nextNum}`;
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const connection = connectionRegistryRef.current.get(activeTab?.connectionId);
    const newTitle = connection
      ? `Terminal ${nextNum} (${connection.user}@${connection.host})`
      : `Terminal ${nextNum}`;
    // A new tab is "opening" until the server acknowledges its PTY channel. It
    // is never labelled connected before that acknowledgement.
    setTabs((prev) => [
      ...prev,
      {
        id: newId,
        title: newTitle,
        connected: false,
        status: connection && connection.client.isConnected ? 'opening' : 'idle',
        connectionId: connection?.id
      }
    ]);
    setActiveTabId(newId);
    setSessionTabLabel(newTitle);
    setActiveScreen('workspace');

    if (!connection || !connection.client.isConnected) return;
    void connection.client
      .openChannel(cols, rows)
      .then((res) => {
        const channel = (res as { channel?: number }).channel;
        if (!channel) {
          const message =
            (res as { error?: string }).error ?? 'The server did not open a new terminal channel.';
          setTabs((prev) =>
            prev.map((t) =>
              t.id === newId ? { ...t, connected: false, status: 'error', errorMessage: message } : t
            )
          );
          return;
        }
        connectionRegistryRef.current.addChannel(connection.id, channel);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === newId
              ? { ...t, channelId: channel, connected: true, status: 'ready', errorMessage: undefined }
              : t
          )
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === newId ? { ...t, connected: false, status: 'error', errorMessage: message } : t
          )
        );
      });
  };

  const handleCloseTab = (tabId: string, e?: Event): void => {
    if (e) e.stopPropagation();
    const closingTab = tabs.find((t) => t.id === tabId);
    if (closingTab) {
      const registry = connectionRegistryRef.current;
      const connection = registry.get(closingTab.connectionId);
      if (connection) {
        if (closingTab.channelId !== undefined) {
          registry.closeChannel(connection.id, closingTab.channelId);
        }
        const remaining = tabs.filter(
          (t) => t.id !== tabId && t.connectionId === connection.id
        );
        // Only the last pane of a connection closes its transport; other
        // servers in the workspace are left alone.
        if (remaining.length === 0) {
          // Suppress retries BEFORE close(): the close event fires
          // synchronously and would otherwise schedule a reconnect for a
          // session the user just ended.
          suppressedReconnectRef.current.add(connection.id);
          clearReconnectTimer();
          setReconnectNotice(null);
          setReconnectMessage(null);
          registry.close(connection.id);
        }
        if (splitPaneChannel !== null && connection.channels.has(splitPaneChannel)) {
          registry.closeChannel(connection.id, splitPaneChannel);
          setSplitPaneChannel(null);
        }
      }
    }
    if (tabs.length <= 1) {
      clearReconnectTimer();
      setReconnectNotice(null);
      setReconnectMessage(null);
      setConnectedAt(null);
      setConnectionState('disconnected');
      setSessionTabLabel('Terminal 1');
      setTabs([{ id: 'tab-1', title: 'Terminal 1', connected: false, status: 'idle' }]);
      setActiveTabId('tab-1');
      setSftpRawEntries([]);
      setTransferStatus('Disconnected — Connect to an SSH host to browse SFTP files');
      setTerminalLines([]);
      return;
    }
    const nextTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(nextTabs);
    if (activeTabId === tabId && nextTabs[0]) {
      setActiveTabId(nextTabs[0].id);
      setSessionTabLabel(nextTabs[0].title);
      liveSessionRef.current =
        connectionRegistryRef.current.get(nextTabs[0].connectionId)?.client ?? null;
    }
  };

  const handleDisconnect = (): void => {
    clearReconnectTimer();
    setReconnectNotice(null);
    setReconnectMessage(null);
    setConnectedAt(null);
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const connection = connectionRegistryRef.current.get(activeTab?.connectionId);
    if (connection) connectionRegistryRef.current.close(connection.id);
    liveSessionRef.current = null;
    setConnectionState('disconnected');
    setPendingInputBytes(0);
    setSftpRawEntries([]);
    setTransferStatus('Disconnected — Connect to an SSH host to browse SFTP files');
    setTabs((prev) =>
      prev.map((t) =>
        connection && t.connectionId === connection.id
          ? { ...t, connected: false, status: 'idle', channelId: undefined, connectionId: undefined }
          : t
      )
    );
    setSessionTabLabel('Terminal 1');
    setTerminalLines([]);
    setEnvironmentLabel('');
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
      setUploadedKeyContent(text);
      if (text.trim()) {
        const check = await validateAndInspectPrivateKeyPem(text);
        if (!check.valid) {
          setConnectErrorMsg(check.error ?? 'Invalid private key format');
        } else if (check.fingerprint) {
          setGeneratedFp(check.fingerprint);
        }
      }
    } catch {
      setUploadedKeyContent('');
    }
  };

  type LiveSessionClient = LiveGatewaySessionClient | BrowserSshRelaySessionClient;

  const clearReconnectTimer = (): void => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setReconnectCountdown(null);
  };

  const transportOf = (connectionId: string): 'go-gateway' | 'cloudflare-relay' =>
    connectionRegistryRef.current.get(connectionId)?.transport ?? transportMode;

  const scheduleReconnect = (
    client: LiveSessionClient,
    connectionId: string,
    immediate = false
  ): void => {
    if (suppressedReconnectRef.current.has(connectionId)) return;
    // The socket close and the failed attempt both report here; only one timer
    // may be pending, or the attempt counter advances twice per retry.
    if (reconnectTimerRef.current !== null) return;
    const attempt = reconnectAttemptRef.current + 1;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      setConnectionState('disconnected');
      setReconnectNotice(null);
      setReconnectMessage(
        `Connection lost — ${MAX_RECONNECT_ATTEMPTS} automatic attempts failed. Press Reconnect to try again.`
      );
      return;
    }
    reconnectAttemptRef.current = attempt;
    setConnectionState('reconnecting');
    setReconnectNotice(describeReconnectAttempt(attempt));
    
    // Start countdown for user-visible reconnect ETA
    const delayMs = immediate ? 0 : reconnectDelayMs(attempt);
    let secondsLeft = Math.ceil(delayMs / 1000);
    setReconnectCountdown(secondsLeft > 0 ? secondsLeft : null);
    const countdownInterval = setInterval(() => {
      setReconnectCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(countdownInterval);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    
    reconnectTimerRef.current = setTimeout(
      () => {
        reconnectTimerRef.current = null;
        clearInterval(countdownInterval);
        setReconnectCountdown(null);
        void performReconnect(client, connectionId);
      },
      delayMs
    );
  };

  const performReconnect = async (
    client: LiveSessionClient,
    connectionId: string
  ): Promise<void> => {
    const transport = transportOf(connectionId);
    const gatewayResume = transport === 'go-gateway';
    try {
      const meta = await client.reconnect();
      const channel = meta.ptyChannel || 1;
      if (!gatewayResume) {
        // The relay keeps nothing server-side: the split pane and the uptime
        // belong to the socket that died.
        setSplitPaneChannel(null);
        setConnectedAt(Date.now());
      }
      setTabs((prev) =>
        prev.map((t) => {
          if (t.connectionId !== connectionId) return t;
          // A gateway resume keeps every channel of the session, so existing
          // pane bindings stay valid. The relay has no session to keep: only
          // the active pane is restored, and the others say so.
          if (gatewayResume) {
            if (t.channelId !== undefined) {
              return { ...t, connected: true, status: 'ready', errorMessage: undefined };
            }
            const saved = channelSnapshotRef.current.get(t.id);
            if (saved !== undefined) {
              return { ...t, connected: true, status: 'ready', channelId: saved, errorMessage: undefined };
            }
            return t.id === activeTabIdRef.current
              ? { ...t, connected: true, status: 'ready', channelId: channel, errorMessage: undefined }
              : {
                  ...t,
                  connected: false,
                  status: 'idle',
                  errorMessage: 'Session resumed — reopen this pane to attach a new shell.'
                };
          }
          return t.id === activeTabIdRef.current
            ? { ...t, connected: true, status: 'ready', channelId: channel, errorMessage: undefined }
            : {
                ...t,
                connected: false,
                status: 'idle',
                channelId: undefined,
                errorMessage: 'Relay reconnected — open a new pane for this session.'
              };
        })
      );
      setConnectionState('connected');
      setReconnectNotice(null);
      reconnectAttemptRef.current = 0;
      if (meta.cipher) setNegotiatedCipher(meta.cipher);
      if (meta.serverVersion) setNegotiatedServerVersion(meta.serverVersion);
      setReconnectCount((prev) => {
        const next = prev + 1;
        const message = reconnectOutcomeMessage(transport, next);
        setReconnectMessage(message);
        writeToXterm(`${String.fromCharCode(13, 10)}[webssh] ${message}${String.fromCharCode(13, 10)}`);
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/RESUME_FAILED|no detached session/i.test(message)) {
        // Retrying cannot help: this gateway closes the SSH session with the
        // socket. Say that plainly instead of looping.
        reconnectAttemptRef.current = 0;
        clearReconnectTimer();
        setConnectionState('disconnected');
        setReconnectNotice(null);
        setReconnectMessage(
          'This gateway does not keep sessions after a drop — start a new connection to continue.'
        );
        return;
      }
      setReconnectMessage(`Reconnect attempt failed: ${message}`);
      scheduleReconnect(client, connectionId);
    }
  };

  const handleReconnectNow = (): void => {
    const client = liveSessionRef.current;
    const activeConnectionId = tabsRef.current.find((t) => t.id === activeTabIdRef.current)?.connectionId;
    if (!client || !activeConnectionId) return;
    suppressedReconnectRef.current.delete(activeConnectionId);
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    scheduleReconnect(client, activeConnectionId, true);
  };

  const handleConnectSubmit = (e?: Event): void => {
    if (e) e.preventDefault();
    if (authMethod === 'Private Key (.pem / id_rsa)' && keyPermissionMode === '0644') {
      setConnectErrorMsg(
        'Permissions 0644 for private key are too open! OpenSSH requires chmod 0400 (-r--------) or 0600.'
      );
      return;
    }

    const gwValidation = validateGatewayWsUrl(gatewayUrl);
    if (!gwValidation.valid) {
      setConnectErrorMsg(gwValidation.error ?? 'Invalid SSH Gateway WebSocket URL.');
      return;
    }

    setConnectErrorMsg('');
    setConnectionState('connecting');
    const hostVal = connectHost.trim() || '127.0.0.1';
    const userVal = connectUser.trim() || 'ubuntu';
    const portVal = connectPort.trim() || '22';
    const portNum = Number.parseInt(portVal, 10) || 22;
    const label = `${userVal}@${hostVal}`;
    const tabTitle = `Terminal 1 (${label})`;

    if (connectInFlightRef.current) return;
    connectInFlightRef.current = true;

    void (async () => {
      try {
      if (authMethod === 'Private Key (.pem / id_rsa)' && uploadedKeyContent.trim()) {
        const keyCheck = await validateAndInspectPrivateKeyPem(uploadedKeyContent);
        if (!keyCheck.valid) {
          setConnectErrorMsg(keyCheck.error ?? 'Invalid private key PEM format.');
          return;
        }
      }

      const protocolAuthMethod =
        authMethod === 'Password'
          ? 'password'
          : authMethod === 'Private Key (.pem / id_rsa)'
            ? 'private_key'
            : 'remote_signer';

      // Guest flow: no account. The relay issues a short-lived ticket bound to
      // this host/port once the Turnstile challenge has been validated. The
      // ticket is single-use and expires, so it is reused only for the exact
      // destination it was issued for.
      let effectiveGatewayToken = gatewayAuthToken.trim();
      if (transportMode === 'cloudflare-relay' && !effectiveGatewayToken) {
        const destinationHost = hostVal.toLowerCase();
        const nowSec = Math.floor(Date.now() / 1000);
        const cached = guestTicketRef.current;
        const reusable =
          cached !== null &&
          cached.host === destinationHost &&
          cached.port === portNum &&
          cached.expiresAt - nowSec > 30;
        if (!reusable) {
          const failGuest = (message: string): void => {
            setGatewayProbeStatus(null);
            setConnectErrorMsg(message);
          };
          if (!turnstileSiteKey) {
            failGuest(
              'Guest connections are not configured in this build. Open Administrator settings and sign in with an account.'
            );
            return;
          }
          if (!turnstileToken) {
            failGuest('Complete the human check above, then press Connect.');
            return;
          }
          setConnectErrorMsg('');
          setGatewayProbeStatus({ ok: true, message: 'Requesting a connection ticket…' });
          try {
            const ticket = await requestConnectionTicket(gwValidation.normalizedUrl, {
              host: destinationHost,
              port: portNum,
              turnstileToken
            });
            guestTicketRef.current = {
              token: ticket.token,
              host: ticket.host,
              port: ticket.port,
              expiresAt: ticket.expiresAt
            };
            setGatewayProbeStatus({
              ok: true,
              message: `Connection ticket issued for ${ticket.host}:${ticket.port}`
            });
          } catch (err) {
            failGuest(err instanceof Error ? err.message : String(err));
            return;
          } finally {
            // A Turnstile response is single-use: whatever the outcome, the
            // next ticket request needs a freshly solved challenge.
            setTurnstileToken('');
            setTurnstileResetNonce((n) => n + 1);
          }
        }
        effectiveGatewayToken = guestTicketRef.current?.token ?? '';
      }

      const connectionId = nextConnectionId();

      const jumpHops = activeJumpHops;
      const sessionParams = {
        transportMode,
        jumpHops,
        gatewayUrl: gwValidation.normalizedUrl,
        gatewayAuthToken: effectiveGatewayToken,
        host: hostVal,
        port: portNum,
        user: userVal,
        authMethod: protocolAuthMethod as 'password' | 'private_key' | 'remote_signer',
        password: connectPassword,
        privateKeyPem: authMethod === 'Private Key (.pem / id_rsa)' ? uploadedKeyContent : undefined,
        publicKey: authMethod === 'Argon2id Ed25519 Key' ? generatedPubKey : undefined,
        keyFingerprint: generatedFp,
        cols,
        rows,
        onPtyData: (channel: number, data: Uint8Array) => {
          // The remote shell is the only writer to its terminal. Output is
          // routed to the pane that owns this channel; it is never copied into
          // a DOM transcription or stripped of escape sequences.
          const tab = tabsRef.current.find(
            (t) => t.connectionId === connectionId && t.channelId === channel
          );
          const recorder = recorderRef.current;
          const recordedConnection = recordConnectionRef.current;
          const isRecordedTab = tab?.id === recordTabIdRef.current;
          // The split pane has no tab of its own; record it when it shares the
          // recorded tab's connection, so the cast is not silently partial.
          const isRecordedSplit =
            recordedConnection !== null &&
            splitOwnerRef.current === recordedConnection &&
            splitChannelRef.current === channel;
          if (recorder && (isRecordedTab || isRecordedSplit)) {
            const decoded = recordDecoderRef.current?.decode(data, { stream: true });
            if (decoded) recorder.recordOutput(decoded);
          }
          const paneId =
            tab?.id ??
            (splitOwnerRef.current === connectionId && splitChannelRef.current === channel
              ? 'split-2'
              : null);
          const adapter = paneId ? paneAdaptersRef.current.get(paneId) : undefined;
          if (adapter) {
            try {
              adapter.writeBytes(data);
              return;
            } catch {
              // A pane disposed mid-write must not break the transport.
            }
          }
          channelOutputRef.current.push(`${connectionId}:${channel}`, data);
        },
        onHostKeyPrompt: async (prompt: {
          type: 'hostkey_prompt';
          host: string;
          port: number;
          algorithm: string;
          fingerprint: string;
          publicKeyBase64: string;
        }) => {
          const v = knownHosts.verify(
            prompt.host,
            prompt.port,
            prompt.algorithm,
            prompt.fingerprint,
            prompt.publicKeyBase64
          );
          if (v.status === 'trusted') {
            return true;
          }
          if (v.status === 'mismatch') {
            setPendingHostKeyPrompt({
              host: prompt.host,
              port: prompt.port,
              algorithm: prompt.algorithm,
              fingerprint: prompt.fingerprint,
              publicKeyBase64: prompt.publicKeyBase64,
              expectedFingerprint: v.expectedFingerprint
            });
            setHostKeyModal('mismatch');
            return new Promise<boolean>((resolve) => {
              hostKeyDecisionResolverRef.current = resolve;
            });
          }
          knownHosts.trustNewHost(
            prompt.host,
            prompt.port,
            prompt.algorithm,
            prompt.fingerprint,
            prompt.publicKeyBase64
          );
          return true;
        },
        onSignRequest: async (req: {
          type: 'sign_request';
          requestId: string;
          keyFingerprint: string;
          algorithm: string;
          dataBase64: string;
        }) => {
          const allKeys = vault.listKeys();
          if (allKeys[0]) {
            const resp = await vault.signChallenge(
              allKeys[0].id,
              base64ToBytes(req.dataBase64)
            );
            return bytesToBase64(resp.rawWebCryptoSignature);
          }
          return '';
        },
        onChannelClosed: (channel: number) => {
          setTabs((prev) =>
            prev.map((t) =>
              t.connectionId === connectionId && t.channelId === channel
                ? { ...t, connected: false, status: 'idle' }
                : t
            )
          );
        },
        onStateChange: (st: 'connected' | 'reconnecting' | 'disconnected', rtt: number) => {
          setRttMs(rtt);
          if (st === 'connected') {
            return;
          }
          const isActiveTab =
            tabsRef.current.find((t) => t.id === activeTabIdRef.current)?.connectionId === connectionId;
          // A gateway resume keeps the session's channels, so a pending
          // reconnect must not drop the per-pane bindings. Only a real
          // disconnect invalidates them — and it records them first.
          if (st !== 'reconnecting') {
            for (const t of tabsRef.current) {
              if (t.connectionId === connectionId && t.channelId !== undefined) {
                channelSnapshotRef.current.set(t.id, t.channelId);
              }
            }
          }
          setTabs((prev) =>
            prev.map((t) =>
              t.connectionId === connectionId
                ? st === 'reconnecting'
                  ? { ...t, connected: false, status: 'idle' }
                  : { ...t, connected: false, status: 'idle', channelId: undefined }
                : t
            )
          );
          if (!isActiveTab) return;
          if (st === 'reconnecting') {
            setConnectionState('reconnecting');
            return;
          }
          setConnectionState('disconnected');
          // Only an unexpected drop earns a retry; an explicit disconnect does not.
          if (!suppressedReconnectRef.current.has(connectionId)) {
            const activeClient = liveSessionRef.current;
            if (activeClient) {
              scheduleReconnect(activeClient, connectionId);
            }
          }
        }
      };

      const client =
        transportMode === 'cloudflare-relay'
          ? new BrowserSshRelaySessionClient(sessionParams)
          : new LiveGatewaySessionClient(sessionParams);

      try {
        const meta = await client.connect();
        liveSessionRef.current = client;
        // Reuse the profile the user connected from (an SSH-config import
        // uses `host-<alias>` and may carry ProxyJump hops). Writing a fresh
        // `host-<host>-<port>` record here creates a hop-less twin that
        // Recent hosts can offer, routing around the bastion.
        const sourceHost = hostRegistry
          .list()
          .find((h) => h.host === hostVal && h.port === portNum && h.user === userVal);
        hostRegistry.upsert(
          sourceHost ?? {
            id: `host-${userVal}-${hostVal}-${portNum}`,
            alias: hostVal,
            host: hostVal,
            port: portNum,
            user: userVal,
            folder: 'Connected',
            tags: [authMethod === 'Password' ? 'password' : 'key-400'],
            favorite: true,
            jumpHops: []
          }
        );
        setHosts(hostRegistry.list());
        setConnectedUser(userVal);
        setConnectedHost(hostVal);
        setEnvironmentLabel(deriveEnvironmentLabel(hostVal));
        setSessionTabLabel(tabTitle);
        setNegotiatedCipher(meta.cipher || '');
        setNegotiatedServerVersion(meta.serverVersion || '');
        const initialChannel = meta.ptyChannel || 1;
        connectionRegistryRef.current.add({
          id: connectionId,
          host: hostVal,
          port: portNum,
          user: userVal,
          transport: transportMode === 'cloudflare-relay' ? 'cloudflare-relay' : 'go-gateway',
          client,
          channels: new Set<number>([initialChannel])
        });
        const occupiedTab = tabsRef.current.find((t) => t.id === activeTabId);
        const occupiedConnection = connectionRegistryRef.current.get(occupiedTab?.connectionId);
        if (occupiedConnection && occupiedConnection.client.isConnected) {
          // The active tab already owns a live transport. Give the new server
          // its own tab instead of rewiring the pane onto a different client.
          const newTabId = `tab-${Date.now()}`;
          setTabs((prev) => [
            ...prev,
            {
              id: newTabId,
              title: tabTitle,
              connected: true,
              status: 'ready',
              connectionId,
              channelId: initialChannel
            }
          ]);
          setActiveTabId(newTabId);
        } else {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === activeTabId
                ? {
                    ...t,
                    title: tabTitle,
                    connected: true,
                    status: 'ready',
                    connectionId,
                    channelId: initialChannel
                  }
                : t
            )
          );
        }
        setConnectionState('connected');
        setConnectedAt(Date.now());
        setRttMs(0);
        setReconnectCount(0);
        setReconnectNotice(null);
        setReconnectMessage(null);
        reconnectAttemptRef.current = 0;
        suppressedReconnectRef.current.delete(connectionId);
        const matchedHost = hostRegistry
          .list()
          .find((h) => h.host === hostVal && h.user === userVal && h.port === portNum);
        if (matchedHost) {
          hostRegistry.upsert({ ...matchedHost, lastConnectedAt: Date.now() });
          setHosts(hostRegistry.list());
        }
        setConnectModalOpen(false);
        setActiveScreen('workspace');
        const workspaceSession = createRemoteSession(client, {
          transport: transportMode === 'cloudflare-relay' ? 'cloudflare-relay' : 'go-gateway',
          host: hostVal,
          user: userVal,
          port: portNum,
          isConnected: () => client.isConnected
        });
        setRemoteSession(workspaceSession);
        setCapabilities(null);
        setDiscoveryError(null);
        void discoverForSession(workspaceSession);
        const authDetail =
          authMethod === 'Private Key (.pem / id_rsa)'
            ? `Private Key ${uploadedKeyFileName || 'id_ed25519'} [chmod ${keyPermissionMode}]`
            : authMethod;
        const msg = `Connected to ${label}:${portVal} (${authDetail} · ${meta.serverVersion || 'SSH-2.0'})`;
        setTerminalLines((prev) => [...prev, msg]);
        writeToXterm(`${String.fromCharCode(13, 10)}${msg}${String.fromCharCode(13, 10)}`);
        if (meta.sftpReady) {
          void refreshSftpDirectory('~', client);
          void loadRemoteFileIntoEditor('README.md', client);
        } else {
          setSftpRawEntries([]);
          setTransferStatus(
            'Cloudflare Worker TCP Relay active — Terminal PTY, Tabs, Split Panes & Exec are live. SFTP, Remote Editor, and Ring-Buffer Resume require Go SSH/SFTP Gateway mode.'
          );
        }
      } catch (err) {
        liveSessionRef.current = null;
        setConnectionState('failed');
        setTabs((prev) => prev.map((t) => ({ ...t, connected: false })));
        const errMsg = err instanceof Error ? err.message : String(err);
        setConnectErrorMsg(errMsg);
        setTerminalLines((prev) => [...prev, `[SSH Connection Error] ${errMsg}`]);
      }
      } finally {
        connectInFlightRef.current = false;
      }
    })();
  };

  const appendCommandBlock = (
    command: string,
    outputLines: string[],
    exitCode = 0,
    durationMs = 12
  ): void => {
    const entry: CommandBlockEntry = {
      id: `block-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      command,
      outputLines,
      timestamp: new Date().toISOString().slice(11, 19),
      durationMs,
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
        paneAdaptersRef.current.get(activeTabIdRef.current)?.terminal.clear();
      } catch {
        // Ignore
      }
      return;
    }

    if (cmd === 'help') {
      const helpMsg =
        'Available local commands: connect <user@host>, pubkey, font <size>, clear, vault, split, features, telemetry, tunnels';
      setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, helpMsg]);
      appendCommandBlock(trimmed, [helpMsg], 0);
      writeToXterm(`${String.fromCharCode(13, 10)}${helpMsg}${String.fromCharCode(13, 10)}webssh:~$ `);
      return;
    }

    if (cmd === 'pubkey') {
      copyToClipboard(authorizedKeysSnippet);
      const out = [`Ed25519 Public Key: ${generatedPubKey}`, `Copy helper: ${authorizedKeysSnippet}`];
      setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, ...out]);
      appendCommandBlock(trimmed, out, 0);
      writeToXterm(`${String.fromCharCode(13, 10)}Ed25519 Public Key: ${generatedPubKey}${String.fromCharCode(13, 10)}webssh:~$ `);
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
        writeToXterm(`${String.fromCharCode(13, 10)}${msg}${String.fromCharCode(13, 10)}webssh:~$ `);
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
      setPendingJump(null);
      setConnectModalOpen(true);
      return;
    }

    if (cmd === 'vault') {
      const msg = generatedFp
        ? `Argon2id Vault Fingerprint: ${generatedFp}`
        : 'Argon2id vault has no key yet — generate one in the vault to see its fingerprint.';
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
      appendCommandBlock(trimmed, ['Opened Servers → Live control.'], 0);
      setActiveScreen('overview');
      return;
    }

    if (cmd === 'tunnels') {
      appendCommandBlock(trimmed, ['Opened Port Forwarding & Network Tunneling Studio.'], 0);
      setActiveScreen('tunnels');
      return;
    }

    const activeClient = liveSessionRef.current;
    if (activeClient && activeClient.isConnected) {
      setTerminalLines((prev) => [...prev, `${connectedUser}@${connectedHost}:~$ ${trimmed}`]);
      if (broadcastInput && splitPanes > 1 && splitPaneChannel !== null) {
        activeClient.sendPtyText(splitPaneChannel, trimmed + String.fromCharCode(13));
      }
      void activeClient
        .execCommand(trimmed)
        .then((res) => {
          const outText = [res.stdout, res.stderr, res.error]
            .filter((part) => Boolean(part && part.trim().length > 0))
            .join(String.fromCharCode(10));
          const outLines = outText
            ? outText
                .replace(/\r/g, '')
                .split(String.fromCharCode(10))
                .filter((line) => line.length > 0)
            : [`(exit ${res.exitCode ?? 0})`];
          setTerminalLines((prev) => [...prev, ...outLines]);
          appendCommandBlock(trimmed, outLines, res.exitCode ?? (res.ok ? 0 : 1), res.durationMs ?? 10);
          writeToXterm(
            `${String.fromCharCode(13, 10)}${outLines.join(String.fromCharCode(13, 10))}${String.fromCharCode(13, 10)}`
          );
        })
        .catch((err) => {
          const errLine = `Remote execution failed: ${err instanceof Error ? err.message : String(err)}`;
          setTerminalLines((prev) => [...prev, errLine]);
          appendCommandBlock(trimmed, [errLine], 1, 0);
        });
      return;
    }

    const offlineMsg = `Not connected to an SSH server. Click 'New Connection' or run 'connect <user@host>' to execute '${trimmed}' on a remote host.`;
    setTerminalLines((prev) => [...prev, `webssh:~$ ${trimmed}`, offlineMsg]);
    appendCommandBlock(trimmed, [offlineMsg], 1, 0);
    writeToXterm(`${String.fromCharCode(13, 10)}${offlineMsg}${String.fromCharCode(13, 10)}webssh:~$ `);
  };

  const handleTerminalKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && zenMode) {
      e.preventDefault();
      setZenMode(false);
      setActiveScreen('welcome');
      return;
    }
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      e.key.toLowerCase() === 'f' &&
      activeScreen === 'workspace'
    ) {
      e.preventDefault();
      openTerminalSearch();
      return;
    }
    const eventTarget = e.target as HTMLElement | null;
    if (eventTarget && typeof eventTarget.closest === 'function' && eventTarget.closest('.xterm')) {
      // xterm forwards these keys to the shell itself. Intercepting them here
      // double-echoed input into the local line editor.
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      // Allow global Cmd+K handler or clear buffer when Shift is held
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      const activeTab = tabs.find((t) => t.id === activeTabId);
      const activeChan = activeTab?.channelId ?? 1;
      if (liveSessionRef.current?.isConnected) {
        liveSessionRef.current.sendPtyText(activeChan, '\x03');
      }
      updateCurrentInput('');
      setTerminalLines((prev) => [...prev, '^C']);
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      setTerminalLines([]);
      try {
        paneAdaptersRef.current.get(activeTabIdRef.current)?.terminal.clear();
      } catch {
        // Ignore
      }
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

  // Flush output that arrived while a pane was still binding its channel.
  useEffect(() => {
    for (const tab of tabs) {
      if (!tab.connectionId || tab.channelId === undefined) continue;
      const adapter = paneAdaptersRef.current.get(tab.id);
      if (adapter) {
        channelOutputRef.current.drainTo(`${tab.connectionId}:${tab.channelId}`, adapter);
      }
    }
    const splitAdapter = paneAdaptersRef.current.get('split-2');
    if (splitAdapter && splitOwnerRef.current && splitPaneChannel !== null) {
      channelOutputRef.current.drainTo(`${splitOwnerRef.current}:${splitPaneChannel}`, splitAdapter);
    }
  }, [tabs, splitPaneChannel]);

  // A split pane is a real second channel on the active connection. It opens
  // only after the server acknowledges it, and it is closed with the pane.
  useEffect(() => {
    const owner = splitOwnerRef.current;
    const activeTab = tabsRef.current.find((t) => t.id === activeTabId);
    const connection = connectionRegistryRef.current.get(activeTab?.connectionId);
    // A split belongs to one connection. Closing it, or switching to another
    // server, must release that remote PTY instead of leaking it.
    if (owner && owner !== connection?.id && splitChannelRef.current !== null) {
      connectionRegistryRef.current.closeChannel(owner, splitChannelRef.current);
      splitOwnerRef.current = undefined;
      setSplitPaneChannel(null);
    }
    if (splitPanes <= 1) {
      if (splitChannelRef.current !== null && splitOwnerRef.current) {
        connectionRegistryRef.current.closeChannel(splitOwnerRef.current, splitChannelRef.current);
      }
      splitOwnerRef.current = undefined;
      setSplitPaneChannel(null);
      return;
    }
    if (!connection || !connection.client.isConnected) return;
    if (splitPaneChannel !== null && connection.channels.has(splitPaneChannel)) return;
    let cancelled = false;
    void connection.client
      .openChannel(cols, rows)
      .then((res) => {
        const channel = (res as { channel?: number }).channel;
        if (cancelled || !channel) return;
        connectionRegistryRef.current.addChannel(connection.id, channel);
        splitOwnerRef.current = connection.id;
        setSplitPaneChannel(channel);
      })
      .catch(() => {
        // The split stays closed when the server refuses a second channel.
      });
    return () => {
      cancelled = true;
    };
  }, [splitPanes, activeTabId, cols, rows, splitPaneChannel]);

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

  useEffect(() => {
    prefsStore.update({ density });
  }, [density, prefsStore]);

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
      } else if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'f' &&
        activeScreen === 'workspace'
      ) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && !target?.isContentEditable) {
          e.preventDefault();
          openTerminalSearch();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === '=') {
        e.preventDefault();
        setFontSize((s) => Math.min(32, s + 1));
      } else if ((e.metaKey || e.ctrlKey) && e.key === '-') {
        e.preventDefault();
        setFontSize((s) => Math.max(11, s - 1));
      } else if (e.key === 'F11' || ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f')) {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        // The terminal's own line editor is a div, so `?` is a real command
        // character there; only the surrounding shell should open help.
        const inTerminal =
          typeof target?.closest === 'function' &&
          Boolean(target.closest('.webssh-terminal-viewport'));
        if (tag !== 'input' && tag !== 'textarea' && !target?.isContentEditable && !inTerminal) {
          e.preventDefault();
          setShortcutsOpen(true);
        }
      } else if (e.key === 'Escape') {
        // Escape closes an open dialog wherever focus sits; the palette's own
        // input handles it too, but not after the list is clicked.
        if (paletteOpen || shortcutsOpen) {
          setPaletteOpen(false);
          setShortcutsOpen(false);
          return;
        }
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
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('keydown', onKeyDown);
    };
  });

  // Modal content is mounted whether or not it is open, so `autoFocus` alone
  // does not move the caret; focus explicitly each time the palette opens.
  useEffect(() => {
    if (paletteOpen) paletteInputRef.current?.focus();
  }, [paletteOpen]);

  // `autoFocus` alone is unreliable once xterm holds focus, so the find bar
  // claims the caret explicitly each time it opens.
  useEffect(() => {
    if (termSearchOpen) termSearchInputRef.current?.focus();
  }, [termSearchOpen]);

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

  // Rebuilt each render: the commands close over tabs, activeTabId, split
  // panes and full-screen state, and a memo over [isFullscreen] handed them a
  // first-render snapshot (e.g. "Close current tab" reset the workspace but
  // never closed the transport).
  const paletteRegistry = (() => {
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
      title: 'Open capability matrix',
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
      title: 'Open SFTP File Browser',
      category: 'Files',
      run: () => {
        setActiveScreen('files');
        setPaletteOpen(false);
      }
    });
    reg.register({
      id: 'terminal.find',
      title: 'Find in terminal output',
      category: 'Terminal',
      shortcut: 'Cmd+F',
      run: () => {
        setPaletteOpen(false);
        setActiveScreen('workspace');
        openTerminalSearch();
      }
    });
    reg.register({
      id: 'terminal.broadcast',
      title: 'Broadcast input to split panes',
      category: 'Terminal',
      run: () => {
        // Opening the split turns broadcast on; only an already-split pane
        // toggles it. Toggling blind turned it OFF when it had been left on
        // with a single pane.
        if (splitPanes === 1) {
          setSplitPanes(2);
          setBroadcastInput(true);
        } else {
          setBroadcastInput((v) => !v);
        }
        setPaletteOpen(false);
      }
    });
    reg.register({
      id: 'terminal.close',
      title: 'Close current tab',
      category: 'Terminal',
      run: () => {
        handleCloseTab(activeTabIdRef.current);
        setPaletteOpen(false);
      }
    });
    reg.register({
      id: 'ide.toggle',
      title: 'Toggle IDE mode',
      category: 'View',
      run: () => {
        setIdeMode((m) => !m);
        setPaletteOpen(false);
      }
    });
    reg.register({
      id: 'help.shortcuts',
      title: 'Show keyboard shortcuts',
      category: 'Help',
      shortcut: '?',
      run: () => {
        setPaletteOpen(false);
        setShortcutsOpen(true);
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
  })();

  const sftpEntries = useMemo(
    () => sortAndFilterEntries(sftpRawEntries, fileFilter),
    [sftpRawEntries, fileFilter]
  );

  const applyPreset = (preset: WorkspacePreset): void => {
    setWorkspacePreset(preset);
    prefsStore.update({ workspacePreset: preset });
    if (preset === 'terminal') {
      setLayoutPreset('sidebar-left');
      prefsStore.update({ layoutPreset: 'sidebar-left' });
      setSplitPanes(1);
      setActiveScreen('workspace');
    } else if (preset === 'develop') {
      setLayoutPreset('bottom-files');
      prefsStore.update({ layoutPreset: 'bottom-files' });
      setActiveScreen('editor');
    } else {
      setLayoutPreset('sidebar-left');
      prefsStore.update({ layoutPreset: 'sidebar-left' });
      setActiveScreen('overview');
    }
  };

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
      className={`webssh-app webssh-density-${density} ${isPseudoFullscreen ? 'webssh-app--pseudo-fullscreen' : ''}`.trim()}
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

      {!isFullscreen && !zenMode ? (
        <AppHeader
          activeScreen={activeScreen}
          setActiveScreen={setActiveScreen}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          view={{
            zenMode,
            setZenMode,
            isFullscreen,
            toggleFullscreen,
            activeTheme,
            setActiveTheme,
            density,
            setDensity,
            fontSize,
            setFontSize,
            isRailOpen: railOpen,
            toggleRail: () => setRailOpen((o) => !o)
          }}
          sessionTabs={{
            tabs,
            setTabs,
            activeTabId,
            setActiveTabId,
            activeTabIdRef,
            setSessionTabLabel,
            statusDotClass,
            handleAddTab,
            handleCloseTab
          }}
          connection={{
            connectionState,
            connectedUser,
            connectedHost,
            environmentLabel,
            rttMs,
            handleDisconnect,
            setPendingJump,
            setConnectModalOpen,
            liveSessionRef,
            connectionRegistryRef
          }}
          terminal={{
            splitPanes,
            setSplitPanes,
            broadcastInput,
            setBroadcastInput
          }}
          recorder={{ recording, startRecording, stopRecording, setReconnectNotice }}
        />
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

      <div
        className={`webssh-workspace-body ${
          layoutPreset === 'sidebar-right' ? 'webssh-workspace-body--right' : ''
        }`.trim()}
      >
        {!isFullscreen && !zenMode ? (
          <AppRail
            activeScreen={activeScreen}
            setActiveScreen={setActiveScreen}
            workspacePreset={workspacePreset}
            applyPreset={applyPreset}
            railWidth={railWidth}
            setRailWidth={setRailWidth}
            layoutPreset={layoutPreset}
            prefsStore={prefsStore}
            isRailOpen={railOpen}
          />
        ) : null}

        <main className="webssh-main">
          {activeScreen === 'workspace' ? (
            <div className="webssh-studio-outer" data-testid="terminal-studio-outer">
              <div className="webssh-studio-container" data-testid="terminal-studio-container">
                {termSearchOpen ? (
                  <div className="webssh-term-search" role="search" data-testid="terminal-search-bar">
                    <Icon name="search" />
                    <input
                      ref={(el) => {
                        termSearchInputRef.current = el;
                      }}
                      className="ui-input"
                      type="search"
                      autoFocus
                      aria-label="Search terminal output"
                      placeholder="Find in terminal…"
                      data-testid="terminal-search-input"
                      value={termSearchQuery}
                      onInput={(e) => setTermSearchQuery((e.currentTarget as HTMLInputElement).value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          runTerminalSearch(e.shiftKey ? -1 : 1);
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          closeTerminalSearch();
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      ariaLabel="Previous match"
                      onClick={() => runTerminalSearch(-1)}
                      testId="terminal-search-prev"
                    >
                      Prev
                    </Button>
                    <Button
                      variant="ghost"
                      ariaLabel="Next match"
                      onClick={() => runTerminalSearch(1)}
                      testId="terminal-search-next"
                    >
                      Next
                    </Button>
                    {termSearchStatus ? (
                      <span className="webssh-term-search-status" role="status" data-testid="terminal-search-status">
                        {termSearchStatus}
                      </span>
                    ) : null}
                    <Button
                      variant="ghost"
                      ariaLabel="Close terminal search"
                      onClick={closeTerminalSearch}
                      testId="terminal-search-close"
                    >
                      ×
                    </Button>
                  </div>
                ) : null}
                <div className="webssh-split-container">
                  <div
                    ref={terminalViewRef}
                    tabIndex={0}
                    role="region"
                    aria-label="SSH Terminal Viewport"
                    data-testid="terminal-viewport"
                    className="webssh-terminal-viewport"
                    style={{ fontSize: `${fontSize}px`, fontFamily }}
                    onClick={(e) => {
                      const target = e.target as HTMLElement | null;
                      if (target && typeof target.closest === 'function' && target.closest('.xterm')) {
                        // xterm already focused its helper textarea on mousedown.
                        return;
                      }
                      terminalViewRef.current?.focus();
                    }}
                    onKeyDown={handleTerminalKeyDown}
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
                            data-testid={`pane-slot-${tab.id}`}
                          >
                            <TerminalPane
                              paneId={tab.id}
                              channelId={tab.channelId ?? null}
                              transport={
                                (connectionRegistryRef.current.get(tab.connectionId)
                                  ?.client as unknown as PaneTransport) ?? null
                              }
                              active={isActive}
                              label={`${tab.title} terminal`}
                              fontFamily={fontFamily}
                              fontSize={fontSize}
                              lineHeight={1.45}
                              cursorStyle={cursorShape}
                              cursorBlink
                              scrollback={10000}
                              theme={{
                                background: terminalPalette.terminalBg,
                                foreground: terminalPalette.terminalFg,
                                cursor: terminalPalette.terminalCursor
                              }}
                              broadcastTo={broadcastInput && splitPanes > 1 ? splitPaneChannel : null}
                              onUserInput={(data) => {
                                if (recordTabIdRef.current === activeTabIdRef.current) {
                                  recorderRef.current?.recordInput(data);
                                }
                              }}
                              onAdapter={registerPaneAdapter}
                              onRendererChange={handleRendererChange}
                              testId="xterm-engine-mount"
                            />
                          </div>
                        );
                      })}
                      {splitPanes > 1 && splitPaneChannel !== null ? (
                        <div
                          className="webssh-terminal-pane-slot"
                          style={{
                            position: 'relative',
                            width: '100%',
                            height: '100%',
                            borderLeft: 'var(--border-hairline)'
                          }}
                          data-testid="terminal-split-pane-2"
                        >
                          <TerminalPane
                            paneId="split-2"
                            channelId={splitPaneChannel}
                            transport={splitPaneTransport}
                            active
                            label={`${sessionTabLabel} split terminal`}
                            fontFamily={fontFamily}
                            fontSize={fontSize}
                            lineHeight={1.45}
                            cursorStyle={cursorShape}
                            cursorBlink
                            scrollback={10000}
                            theme={{
                              background: terminalPalette.terminalBg,
                              foreground: terminalPalette.terminalFg,
                              cursor: terminalPalette.terminalCursor
                            }}
                            broadcastTo={
                              broadcastInput && splitPanes > 1
                                ? (tabs.find((t) => t.id === activeTabIdRef.current)?.channelId ?? null)
                                : null
                            }
                            onUserInput={(data) => {
                              const recordedConnection = recordConnectionRef.current;
                              if (
                                recorderRef.current &&
                                recordedConnection !== null &&
                                splitOwnerRef.current === recordedConnection
                              ) {
                                recorderRef.current.recordInput(data);
                              }
                            }}
                            onAdapter={registerPaneAdapter}
                            onRendererChange={handleRendererChange}
                            testId="xterm-engine-mount-2"
                          />
                        </div>
                      ) : null}
                      {connectionState !== 'connected' ? (
                        <div
                          className="webssh-terminal-disconnected"
                          data-testid="terminal-disconnected-state"
                        >
                          <p>No server connected.</p>
                          <p>Enter a host, user and port, then press Connect.</p>
                          <Button
                            variant="primary"
                            onClick={() => {
                              setPendingJump(null);
                              setConnectModalOpen(true);
                            }}
                            testId="empty-state-connect-btn"
                          >
                            Connect
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
                    {showCommandInspector ? (
                      <section
                        className="webssh-command-inspector"
                        data-testid="command-inspector"
                        aria-label="Local command inspector"
                      >
                        <header className="webssh-command-inspector-header">
                          <strong>Local command inspector</strong>
                          <span>
                            Output of explicit local commands only. Interactive shell output belongs to the
                            terminal above.
                          </span>
                        </header>
                        <div data-testid="local-command-output">
                          {terminalLines.map((line, i) => (
                            <div key={i}>{redactSecretsInText(line, redactionMode)}</div>
                          ))}
                        </div>
                        {commandBlocks.map((block) => (
                          <div key={block.id} className="webssh-cmd-block" data-testid={`cmd-block-${block.id}`}>
                            <div className="webssh-cmd-block-header">
                              <span>
                                <strong>$ {redactSecretsInText(block.command, redactionMode)}</strong> ·{' '}
                                {block.timestamp} ({block.durationMs}ms)
                              </span>
                              <Badge tone={block.exitCode === 0 ? 'success' : 'danger'}>
                                exit {block.exitCode}
                              </Badge>
                            </div>
                            {block.outputLines.map((outLine, idx) => (
                              <div key={idx}>{redactSecretsInText(outLine, redactionMode)}</div>
                            ))}
                          </div>
                        ))}
                        {terminalLines.length === 0 && commandBlocks.length === 0 ? (
                          <p>No local commands have run in this session.</p>
                        ) : null}
                      </section>
                    ) : null}
              </div>
            </div>
          ) : null}

          {activeScreen === 'workspace' && connectionState === 'disconnected' && (
            <div className="webssh-empty-state" data-testid="empty-disconnected-state">
              <div className="webssh-empty-state-icon">◐</div>
              <h2 className="webssh-empty-state-title">No active connection</h2>
              <p className="webssh-empty-state-description">
                Connect to an SSH server to open a terminal, browse files, and use the editor.
              </p>
              <div className="webssh-empty-state-actions">
                <Button
                  variant="primary"
                  onClick={() => {
                    setPendingJump(null);
                    setConnectModalOpen(true);
                  }}
                  testId="empty-state-connect-btn"
                >
                  Connect to a server
                </Button>
                {recentHosts.length > 0 ? (
                  <Button
                    variant="default"
                    onClick={() => setActiveScreen('welcome')}
                    testId="empty-state-welcome-btn"
                  >
                    Open Welcome screen
                  </Button>
                ) : null}
              </div>
            </div>
          )}

          {activeScreen === 'ide' ? (
            <Suspense fallback={<p className="ws-mod-muted">Loading workspace IDE…</p>}>
              <LightIde
                session={remoteSession}
                connectedLabel={connectedHost ? `${connectedUser}@${connectedHost}` : ''}
              />
            </Suspense>
          ) : null}
          <Suspense fallback={<p className="ws-mod-muted">Loading server modules…</p>}>
            {activeScreen === 'overview' ? <OverviewPanel ctx={moduleContext} /> : null}
            {activeScreen === 'software' ? <SoftwarePanel ctx={moduleContext} /> : null}
            {activeScreen === 'containers' ? <ContainersPanel ctx={moduleContext} /> : null}
            {activeScreen === 'kubernetes' ? <KubernetesPanel ctx={moduleContext} /> : null}
            {activeScreen === 'automations' ? <AutomationsPanel ctx={moduleContext} /> : null}
            {activeScreen === 'deployments' ? <DeploymentsPanel ctx={moduleContext} /> : null}
            {activeScreen === 'activity' ? <ActivityPanel ctx={moduleContext} /> : null}
          </Suspense>

          {activeScreen === 'features' ? (
            <Suspense fallback={<p className="ws-mod-muted">Loading capability matrix…</p>}>
              <CapabilityMatrixPanel />
            </Suspense>
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
                      const tunId = `tunnel-${Date.now()}`;
                      const activeClient = liveSessionRef.current;
                      if (activeClient && activeClient.isConnected) {
                        void activeClient
                          .tunnelOp({
                            op: 'start',
                            tunnelId: tunId,
                            forwardType: 'L',
                            bindAddress: '127.0.0.1',
                            localPort: lPort,
                            remoteHost: '127.0.0.1',
                            remotePort: rPort
                          })
                          .then((res) => {
                            if (!res.ok || !res.active) {
                              // Never show a tunnel card for a forward that
                              // the server did not actually open.
                              setTunnelPreviewOutput(
                                `Tunnel not started: ${res.error ?? 'the transport refused the forward'}`
                              );
                              return;
                            }
                            setTunnels((prev) => [
                              ...prev,
                              {
                                id: tunId,
                                name: `Custom Tunnel :${lPort}->:${rPort}`,
                                type: 'L',
                                bindAddress: res.boundAddress || '127.0.0.1',
                                localPort: lPort,
                                remoteHost: '127.0.0.1',
                                remotePort: rPort,
                                active: true,
                                bytesTransferred: 0
                              }
                            ]);
                          })
                          .catch((err: unknown) => {
                            setTunnelPreviewOutput(
                              `Tunnel not started: ${err instanceof Error ? err.message : String(err)}`
                            );
                          });
                      } else {
                        setTunnelPreviewOutput(
                          `Tunnel not started: connect to an SSH host first (${lPort} → ${rPort}).`
                        );
                      }
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
                        onClick={() => {
                          const activeClient = liveSessionRef.current;
                          if (!activeClient || !activeClient.isConnected) {
                            setTunnelPreviewOutput(
                              `Tunnel ${t.id} unchanged: the SSH session is disconnected.`
                            );
                            return;
                          }
                          const nextActive = !t.active;
                          const request = nextActive
                            ? activeClient.tunnelOp({
                                op: 'start',
                                tunnelId: t.id,
                                forwardType: t.type === 'R' ? 'R' : t.type === 'D' ? 'D' : 'L',
                                bindAddress: t.bindAddress,
                                localPort: t.localPort,
                                remoteHost: t.remoteHost,
                                remotePort: t.remotePort
                              })
                            : activeClient.tunnelOp({ op: 'stop', tunnelId: t.id });
                          void request.then((res) => {
                            setTunnels((prev) =>
                              prev.map((item) =>
                                item.id === t.id
                                  ? { ...item, active: res.ok ? nextActive : item.active }
                                  : item
                              )
                            );
                            if (!res.ok) {
                              setTunnelPreviewOutput(
                                `Tunnel ${t.id} ${nextActive ? 'start' : 'stop'} failed: ${res.error ?? 'unknown error'}`
                              );
                            }
                          });
                        }}
                      >
                        {t.active ? 'Pause Tunnel' : 'Start Tunnel'}
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => setWebPreviewPort(t.remotePort || t.localPort)}
                      >
                        Preview :{t.remotePort || t.localPort}
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>

              <Card testId="remote-web-preview-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <h2>One-Click Web Preview — Remote localhost:{webPreviewPort}</h2>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                    <Badge tone={connectionState === 'connected' ? 'success' : 'neutral'}>
                      {connectionState === 'connected' ? 'SSH Direct-TCPIP Ready' : 'Disconnected'}
                    </Badge>
                    <Button
                      variant="primary"
                      testId="probe-http-preview-btn"
                      onClick={() => {
                        const activeClient = liveSessionRef.current;
                        if (!activeClient || !activeClient.isConnected) {
                          setTunnelPreviewOutput(
                            `Cannot probe 127.0.0.1:${webPreviewPort}: Not connected to an SSH host.`
                          );
                          return;
                        }
                        void activeClient
                          .tunnelOp({
                            op: 'http_preview',
                            remoteHost: '127.0.0.1',
                            remotePort: webPreviewPort,
                            httpPath: '/'
                          })
                          .then((res) => {
                            if (res.ok) {
                              setTunnelPreviewOutput(
                                `HTTP/1.1 ${res.statusText || res.statusCode || 200}${String.fromCharCode(10)}${res.bodyPreview || ''}`
                              );
                            } else {
                              setTunnelPreviewOutput(
                                `Tunnel HTTP Probe Failed on 127.0.0.1:${webPreviewPort}: ${res.error || 'Connection refused'}`
                              );
                            }
                          });
                      }}
                    >
                      Probe HTTP Preview
                    </Button>
                  </div>
                </div>
                <p>
                  Proxying remote <code>http://127.0.0.1:{webPreviewPort}</code> over SSH <code>direct-tcpip</code> channel:
                </p>
                <pre data-testid="tunnel-preview-output">{tunnelPreviewOutput}</pre>
              </Card>
            </div>
          ) : null}

          {activeScreen === 'server-tools' ? (
            <div className="webssh-panel-content" data-testid="screen-server-tools">
              <h1>Server tools</h1>
              <p className="ws-mod-muted">
                Containers, Kubernetes, services, and automation for the active connection.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
                <Card>
                  <h3>Overview</h3>
                  <p className="ws-mod-muted">Live CPU, memory, disk, uptime, processes, and services.</p>
                  <Button variant="default" onClick={() => setActiveScreen('overview')} testId="server-tools-overview">
                    Open Overview
                  </Button>
                </Card>
                <Card>
                  <h3>Software</h3>
                  <p className="ws-mod-muted">Installed packages and software inventory.</p>
                  <Button variant="default" onClick={() => setActiveScreen('software')} testId="server-tools-software">
                    Open Software
                  </Button>
                </Card>
                <Card>
                  <h3>Containers</h3>
                  <p className="ws-mod-muted">Docker container management.</p>
                  <Button variant="default" onClick={() => setActiveScreen('containers')} testId="server-tools-containers">
                    Open Containers
                  </Button>
                </Card>
                <Card>
                  <h3>Kubernetes</h3>
                  <p className="ws-mod-muted">kubectl cluster inspection.</p>
                  <Button variant="default" onClick={() => setActiveScreen('kubernetes')} testId="server-tools-kubernetes">
                    Open Kubernetes
                  </Button>
                </Card>
                <Card>
                  <h3>Automations</h3>
                  <p className="ws-mod-muted">Python automation templates and job runner.</p>
                  <Button variant="default" onClick={() => setActiveScreen('automations')} testId="server-tools-automations">
                    Open Automations
                  </Button>
                </Card>
                <Card>
                  <h3>Deployments</h3>
                  <p className="ws-mod-muted">Git plan, preview, and deploy workflows.</p>
                  <Button variant="default" onClick={() => setActiveScreen('deployments')} testId="server-tools-deployments">
                    Open Deployments
                  </Button>
                </Card>
                <Card>
                  <h3>Activity</h3>
                  <p className="ws-mod-muted">Session history and job states.</p>
                  <Button variant="default" onClick={() => setActiveScreen('activity')} testId="server-tools-activity">
                    Open Activity
                  </Button>
                </Card>
              </div>
              <p className="ws-mod-muted" style={{ marginTop: 'var(--space-4)' }}>
                Some tools require the Go SSH/SFTP Gateway mode and may report &ldquo;not reported&rdquo;
                when a capability probe has not yet run.
              </p>
            </div>
          ) : null}

          {activeScreen === 'welcome' ? (
            <WelcomeScreen
              recentHosts={recentHosts}
              setPendingJump={setPendingJump}
              setConnectModalOpen={setConnectModalOpen}
              quickConnect={{
                connectHost,
                setConnectHost,
                connectUser,
                setConnectUser,
                connectPort,
                setConnectPort,
                authMethod,
                setAuthMethod,
                connectPassword,
                setConnectPassword,
                keyPermissionMode,
                setKeyPermissionMode,
                uploadedKeyContent,
                setUploadedKeyContent,
                connectErrorMsg,
                setConnectErrorMsg,
                handleConnectSubmit,
                handlePrivateKeyFileUpload,
                handleGenerateKey
              }}
              transport={{
                transportMode,
                setTransportMode,
                gatewayUrl,
                setGatewayUrl,
                gatewayAuthToken,
                setGatewayAuthToken,
                gatewayProbeStatus,
                setGatewayProbeStatus,
                handleTestGateway
              }}
              account={{
                relaySessionUser,
                relayLoginUser,
                setRelayLoginUser,
                relayLoginPass,
                setRelayLoginPass,
                handleRelayLogin,
                handleRelaySignOut
              }}
              guest={{ turnstileSiteKey, turnstileResetNonce, setTurnstileToken }}
              session={remoteSession}
              onNavigate={setActiveScreen}
            />
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
                    <p data-testid="vault-fingerprint">
                      Fingerprint: {generatedFp || 'not generated in this session'}
                    </p>
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
                      <Badge tone="neutral">Not available in-browser</Badge>
                    </div>
                    <p>
                      Browsers cannot create OpenSSH FIDO2 keys (<code>sk-ssh-ed25519@openssh.com</code>).
                      Generate one where the hardware key is attached, then register the public key with
                      the server:
                    </p>
                    <pre className="ws-mod-log">{'ssh-keygen -t ed25519-sk -O resident -O application=ssh:webssh'}</pre>
                    <p className="ws-mod-muted">
                      Import the resulting public key into Saved Hosts → authorized_keys. This build does
                      not fake the enrollment.
                    </p>
                  </Card>

                  <Card testId="ssh-ca-cert-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>SSH Certificate Authority (CA) Short-Lived Cert</strong>
                      <Badge tone={sshCertInfo.caFingerprint === '—' ? 'neutral' : 'success'}>
                        {sshCertInfo.caFingerprint === '—' ? 'no certificate loaded' : `${sshCertInfo.certType} cert`}
                      </Badge>
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
                    Preview mismatch dialog
                  </Button>
                  <Button
                    variant="default"
                    testId="export-hosts-btn"
                    onClick={() => {
                      const blob = new Blob([hostRegistry.exportJson()], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const anchor = document.createElement('a');
                      anchor.href = url;
                      anchor.download = 'webssh-hosts.json';
                      anchor.click();
                      // Firefox cancels the download if the blob URL is
                      // revoked in the same task; the IDE export already waits.
                      setTimeout(() => URL.revokeObjectURL(url), 5000);
                      setHostTransferStatus(`Exported ${hosts.length} host(s). No keys or passwords are included.`);
                    }}
                  >
                    Export JSON
                  </Button>
                  <Button
                    variant="default"
                    testId="import-hosts-btn"
                    onClick={() => hostImportInputRef.current?.click()}
                  >
                    Import JSON
                  </Button>
                  <input
                    ref={(el) => {
                      hostImportInputRef.current = el;
                    }}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    data-testid="import-hosts-file"
                    onChange={(e) => {
                      const input = e.currentTarget as HTMLInputElement;
                      const file = input.files?.[0];
                      if (!file) return;
                      void file.text().then((text) => {
                        try {
                          const result = hostRegistry.importJson(text);
                          setHosts(hostRegistry.list());
                          const detail =
                            result.skipped > 0
                              ? `, skipped ${result.skipped} malformed entr${result.skipped === 1 ? 'y' : 'ies'}.`
                              : '.';
                          setHostTransferStatus(
                            result.persisted
                              ? `Imported ${result.imported.length} host(s)${detail}`
                              : `Imported ${result.imported.length} host(s) for this session only${detail} ` +
                                  'Browser storage refused the write, so they will not survive a reload.'
                          );
                        } catch (err) {
                          setHostTransferStatus(
                            `Import failed: ${err instanceof Error ? err.message : String(err)}`
                          );
                        } finally {
                          input.value = '';
                        }
                      }).catch((err) => {
                        input.value = '';
                        setHostTransferStatus(
                          `Import failed: could not read the file (${err instanceof Error ? err.message : String(err)}).`
                        );
                      });
                    }}
                  />
                </div>
              </div>
              {hostTransferStatus ? (
                <p role="status" data-testid="host-transfer-status">
                  {hostTransferStatus}
                </p>
              ) : null}
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
                          setPendingJump({
                            targetHost: h.host,
                            targetPort: h.port,
                            hops: h.jumpHops.map((j) => ({ host: j.host, port: j.port, user: j.user }))
                          });
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
                <h1>SFTP File Browser</h1>
                <Badge tone="neutral" testId="storage-quota-badge">
                  Storage Guard: {quotaSnap.percentUsed}% of 256 MiB cap (256 KiB chunks, SHA-256 verified)
                </Badge>
              </div>
              <p data-testid="transfer-status-badge">{transferStatus}</p>
              <input
                type="search"
                className="ui-input"
                placeholder="Filter remote directory entries…"
                value={fileFilter}
                onInput={(e) => setFileFilter((e.target as HTMLInputElement).value)}
                aria-label="Filter remote directory entries"
              />
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(18rem, 1fr))',
                  gap: 'var(--space-3)'
                }}
                data-testid="sftp-dual-pane"
              >
                <Card testId="sftp-local-pane">
                  <h2>Local folder</h2>
                  <p className="ws-mod-muted">
                    {localFsAccessSupported
                      ? 'Pick a folder to move files between this computer and the server. Reads and writes happen in the browser; nothing is uploaded anywhere else.'
                      : 'This browser has no File System Access API (Firefox, Safari), so the local pane cannot list folders. Upload and Download below still work.'}
                  </p>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <Button
                      variant="default"
                      onClick={() => void pickLocalDirectory()}
                      disabled={!localFsAccessSupported}
                      testId="sftp-pick-local-dir"
                    >
                      {localDirHandle ? 'Change folder' : 'Choose folder'}
                    </Button>
                    {localDirHandle ? (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setLocalDirHandle(null);
                          setLocalDirName('');
                          setLocalEntries([]);
                          setLocalStatus('No local folder selected. Upload and download still work without one.');
                        }}
                        testId="sftp-clear-local-dir"
                      >
                        Forget folder
                      </Button>
                    ) : null}
                  </div>
                  <p role="status" data-testid="sftp-local-status">
                    {localStatus}
                  </p>
                  {localDirHandle ? (
                    <ul data-testid="sftp-local-list">
                      {localEntries.map((entry) => (
                        <li key={entry.name} data-testid={`sftp-local-row-${entry.name}`}>
                          <strong>{entry.kind === 'directory' ? `[DIR] ${entry.name}` : entry.name}</strong>
                          {entry.kind === 'file' ? ` — ${entry.size} bytes ` : ' '}
                          {entry.kind === 'file' ? (
                            <Button variant="ghost" onClick={() => void uploadLocalEntry(entry)}>
                              Upload
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Card>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <p>Upload a file into {sftpCurrentPath}. Writes go through SFTP, never through the shell.</p>
                  <label className="ui-button ui-button--primary" style={{ cursor: 'pointer' }}>
                    <Icon name="upload" /> Upload file
                    <input
                      type="file"
                      data-testid="sftp-upload-input"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const input = e.target as HTMLInputElement;
                        const file = input.files?.[0];
                        input.value = '';
                        if (file) void uploadLocalFile(file);
                      }}
                    />
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    className="ui-input"
                    aria-label="New folder name"
                    placeholder="New folder name"
                    value={newFolderName}
                    onInput={(e) => setNewFolderName((e.target as HTMLInputElement).value)}
                  />
                  <Button variant="default" onClick={() => void createFolder()} testId="sftp-create-folder">
                    Create folder
                  </Button>
                </div>
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleRemoteDrop(e as unknown as DragEvent)}
                  data-testid="sftp-remote-dropzone"
                >
                <p className="ws-mod-muted">Drop files here to upload them into {sftpCurrentPath}.</p>
                <ul>
                  {sftpEntries.map((entry) => (
                    <li key={entry.path} data-testid={`sftp-row-${entry.name}`}>
                      <strong>{entry.isDir ? `[DIR] ${entry.name}` : entry.name}</strong> — {entry.size} bytes ({entry.mode}){' '}
                      {entry.isDir ? null : (
                        <>
                          <Button variant="ghost" onClick={() => void downloadRemoteFile(entry.path)}>
                            Download
                          </Button>
                          {localDirHandle ? (
                            <Button
                              variant="ghost"
                              onClick={() => void downloadToLocalDirectory(entry.path)}
                              testId={`sftp-to-local-${entry.name}`}
                            >
                              Download to local
                            </Button>
                          ) : null}
                        </>
                      )}
                      <Button
                        variant="ghost"
                        onClick={() => setRenameTarget({ path: entry.path, name: entry.name })}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => setDeleteTarget({ path: entry.path, name: entry.name })}
                      >
                        Delete
                      </Button>
                    </li>
                  ))}
                </ul>
                </div>
                {renameTarget ? (
                  <div className="ws-mod-plan" role="group" aria-label="Rename entry">
                    <strong>Rename {renameTarget.path}</strong>
                    <input
                      className="ui-input"
                      aria-label="New name"
                      value={renameTarget.name}
                      onInput={(e) =>
                        setRenameTarget((prev) =>
                          prev ? { ...prev, name: (e.target as HTMLInputElement).value } : prev
                        )
                      }
                    />
                    <div className="ws-mod-actions">
                      <Button variant="primary" onClick={() => void renameEntry()} testId="sftp-confirm-rename">
                        Rename
                      </Button>
                      <Button variant="ghost" onClick={() => setRenameTarget(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
                {deleteTarget ? (
                  <div className="ws-mod-plan" role="alertdialog" aria-label="Confirm delete">
                    <strong>Delete {deleteTarget.path}?</strong>
                    <p className="ws-mod-muted">
                      This removes the entry from the server. Directories are deleted only when empty;
                      nothing is sent to a trash.
                    </p>
                    <div className="ws-mod-actions">
                      <Button variant="danger" onClick={() => void deleteEntry()} testId="sftp-confirm-delete">
                        Confirm delete
                      </Button>
                      <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </Card>
              </div>

              <div className="webssh-grid">
                <Card testId="chmod-matrix-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h2>Interactive chmod Permissions Matrix</h2>
                    <Badge tone="success" testId="chmod-octal-badge">
                      {chmodFormatted.octal} ({chmodFormatted.symbolic})
                    </Badge>
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                    <label htmlFor="chmod-target-input">Target:</label>
                    <input
                      id="chmod-target-input"
                      type="text"
                      className="ui-input"
                      value={chmodTargetFile}
                      onInput={(e) => setChmodTargetFile((e.target as HTMLInputElement).value)}
                      data-testid="chmod-target-input"
                    />
                  </div>
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
                      const activeClient = liveSessionRef.current;
                      if (activeClient && activeClient.isConnected) {
                        void activeClient
                          .sftpOp({
                            op: 'chmod',
                            path: chmodTargetFile,
                            mode: chmodFormatted.octal
                          })
                          .then((res) => {
                            if (res.ok) {
                              setTransferStatus(
                                `Applied chmod ${chmodFormatted.octal} (${chmodFormatted.symbolic}) to ${chmodTargetFile}`
                              );
                              void refreshSftpDirectory(sftpCurrentPath, activeClient, true);
                            } else {
                              setTransferStatus(`chmod failed on ${chmodTargetFile}: ${res.error ?? 'Unknown error'}`);
                            }
                          });
                      } else {
                        setTransferStatus(
                          `chmod ${chmodFormatted.octal} not applied: the SSH session is disconnected.`
                        );
                      }
                    }}
                  >
                    Apply chmod {chmodFormatted.octal}
                  </Button>
                </Card>

              </div>

              <Card testId="live-log-tailer-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <h2>Read a remote log file</h2>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <input
                      className="ui-input"
                      aria-label="Remote log path"
                      placeholder="/var/log/nginx/error.log"
                      value={tailFilePath}
                      onInput={(e) => setTailFilePath((e.target as HTMLInputElement).value)}
                      data-testid="tail-path-input"
                      style={{ minWidth: '220px' }}
                    />
                    <input
                      type="search"
                      className="ui-input"
                      placeholder="Filter lines (e.g. error, warn)…"
                      aria-label="Filter log stream"
                      value={tailFilter}
                      onInput={(e) => setTailFilter((e.target as HTMLInputElement).value)}
                      data-testid="tail-filter-input"
                    />
                    <Button
                      variant="primary"
                      testId="tail-read-btn"
                      onClick={() => void readRemoteLog()}
                    >
                      Read last 200 lines
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
                <h1>Remote File Editor — {editorFilePath}</h1>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    className="ui-input"
                    aria-label="Remote file path"
                    value={editorFilePath}
                    onInput={(e) => setEditorFilePath((e.target as HTMLInputElement).value)}
                    data-testid="editor-filepath-input"
                    style={{ width: '200px' }}
                  />
                  <Button
                    variant="default"
                    testId="load-remote-file-btn"
                    onClick={() => void loadRemoteFileIntoEditor(editorFilePath)}
                  >
                    Load from Host
                  </Button>
                  <Button
                    variant="default"
                    testId="toggle-diff-viewer-btn"
                    onClick={() => setShowDiffViewer((d) => !d)}
                  >
                    {showDiffViewer ? 'Hide Side-by-Side Diff' : 'Compare Side-by-Side Diff'}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void saveEditorBuffer()}
                    testId="save-remote-file-btn"
                  >
                    Save to host {editorLoadedPath !== editorFilePath ? '(Not loaded)' : editorSaved ? '(Saved)' : '(Unsaved*)'}
                  </Button>
                </div>
              </div>
              {editorError ? (
                <p className="ws-mod-error" role="alert" data-testid="editor-error">
                  {editorError}
                </p>
              ) : null}
              {editorConflict ? (
                <Card testId="editor-conflict-card">
                  <p className="ws-mod-warnings">{editorConflict}</p>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <Button
                      variant="danger"
                      onClick={() => void saveEditorBuffer(true)}
                      testId="editor-overwrite-remote"
                    >
                      Overwrite with my version
                    </Button>
                    <Button
                      variant="default"
                      onClick={() => {
                        setEditorConflict(null);
                        void loadRemoteFileIntoEditor(editorFilePath);
                      }}
                      testId="editor-reload-remote"
                    >
                      Discard mine and reload
                    </Button>
                  </div>
                </Card>
              ) : null}
              <textarea
                className="ui-input webssh-editor-textarea"
                rows={10}
                aria-label="Remote file content"
                data-testid="remote-editor-textarea"
                value={editorContent}
                onInput={(e) => {
                  setEditorContent((e.target as HTMLTextAreaElement).value);
                  setEditorSaved(false);
                }}
              />
              {showDiffViewer ? (
                <Card testId="side-by-side-diff-card">
                  <h2>Side-by-Side Diff vs Remote {editorFilePath}</h2>
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
                          void executeTerminalCommand(interpolated);
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
                <h2>Your recording</h2>
                {recordedCast ? (
                  <>
                    <p>
                      {recordedCast.events.length} event(s) captured from{' '}
                      <strong>{recordedCast.header.title ?? sessionTabLabel}</strong>. Only the
                      active pane's output and the keystrokes typed into it are stored in this
                      tab; nothing is uploaded.
                    </p>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(
                        0,
                        ...recordedCast.events.map((event) => event[0])
                      )}
                      step={0.1}
                      value={recordScrubber}
                      aria-label="Your recording timeline scrubber"
                      onInput={(e) => setRecordScrubber(Number((e.target as HTMLInputElement).value))}
                    />
                    <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                      <Button variant="primary" onClick={downloadRecording} testId="download-recording-btn">
                        Download .cast
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setRecordedCastText(null);
                          setRecordScrubber(0);
                        }}
                        testId="clear-recording-btn"
                      >
                        Clear
                      </Button>
                    </div>
                    <pre data-testid="recording-preview">
                      {scrubAsciicastOutput(recordedCast.events, recordScrubber)}
                    </pre>
                  </>
                ) : (
                  <p className="ws-mod-muted">
                    No recording yet. Press <strong>Record</strong> in the terminal toolbar while a
                    session is connected; output and typed input are captured locally, and the file
                    stays in this tab until you download or clear it.
                  </p>
                )}
              </Card>
              <Card>
                <h2>Demo recording preview ({scrubberSec.toFixed(1)}s)</h2>
                <p>Sample recording — not output from your server.</p>
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
            <SettingsScreen
              settingsSection={settingsSection}
              setSettingsSection={setSettingsSection}
              appearance={{
                fontFamily,
                setFontFamily,
                fontSize,
                setFontSize,
                activeTheme,
                setActiveTheme,
                layoutPreset,
                setLayoutPreset,
                cursorShape,
                setCursorShape,
                prefsStore
              }}
              keybindings={keybindings}
              cacheRepairStatus={cacheRepairStatus}
              setCacheRepairStatus={setCacheRepairStatus}
            />
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

      {connectionState === 'connecting' || connectionState === 'reconnecting' || reconnectMessage ? (
        <div
          className={`webssh-connection-state-banner ${
            connectionState === 'failed' || (reconnectMessage && !reconnectNotice)
              ? 'webssh-connection-state-banner--failed'
              : ''
          }`}
          role="status"
          data-testid="connection-state-banner"
        >
          <div className="webssh-connection-state-banner__label">
            <span className={`webssh-status-dot ${statusDotClass}`} aria-hidden="true" />
            <span>
              {connectionState === 'reconnecting'
                ? `Reconnecting${reconnectNotice ? ` (attempt ${reconnectCount})` : ''}${reconnectCountdown !== null ? ` — ${reconnectCountdown}s` : ''}…`
                : connectionState === 'connecting'
                  ? 'Connecting…'
                  : 'Connection failed'}
            </span>
            {connectedHost ? (
              <span className="webssh-connection-state-banner__detail">
                {connectedUser}@{connectedHost}
              </span>
            ) : null}
          </div>
          <div className="webssh-connection-state-banner__actions">
            {connectionState === 'reconnecting' || connectionState === 'connecting' ? (
              <Button variant="default" onClick={handleReconnectNow} testId="reconnect-now-btn">
                Cancel
              </Button>
            ) : (
              <Button variant="default" onClick={handleReconnectNow} testId="reconnect-now-btn">
                Reconnect now
              </Button>
            )}
            <Button variant="ghost" onClick={() => setReconnectMessage(null)} testId="dismiss-banner-btn">
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      {!isFullscreen && !zenMode ? (
        <footer className="webssh-statusbar" role="contentinfo" data-testid="status-bar">
          <span className="webssh-statusbar-health">
            <button
              type="button"
              className="webssh-statusbar-trigger"
              onClick={() => setConnectionPanelOpen((open) => !open)}
              aria-expanded={connectionPanelOpen}
              aria-controls="connection-details-panel"
              data-testid="connection-status-btn"
            >
              <span className={`webssh-status-dot ${statusDotClass}`.trim()} aria-hidden="true" />
              <span>
                {connectionState === 'connected'
                  ? `Connected · ${sessionTabLabel}`
                  : connectionState === 'reconnecting'
                    ? 'Reconnecting…'
                    : 'Disconnected'}
              </span>
            </button>
            {connectionState === 'connected' ? (
              <span className="webssh-statusbar-metrics">
                <span>{formatRtt(rttMs)}</span>
                <span aria-hidden="true">·</span>
                <span>{formatUptime(connectedAt !== null ? Date.now() - connectedAt : 0)}</span>
              </span>
            ) : null}
            {connectionPanelOpen ? (
              <div
                className="webssh-conn-panel"
                id="connection-details-panel"
                role="dialog"
                aria-label="Connection details"
                data-testid="connection-details-panel"
              >
                <div className="webssh-conn-panel-head">
                  <strong>Connection details</strong>
                  <Button
                    variant="ghost"
                    ariaLabel="Close connection details"
                    onClick={() => setConnectionPanelOpen(false)}
                  >
                    ×
                  </Button>
                </div>
                <dl className="webssh-conn-list">
                  {connectionHealthRows({
                    transportMode,
                    state:
                      connectionState === 'resumed'
                        ? 'connected'
                        : connectionState === 'offline'
                          ? 'disconnected'
                          : connectionState,
                    target: connectedHost ? `${connectedUser}@${connectedHost}` : '',
                    rttMs,
                    uptimeMs:
                      connectedAt !== null && connectionState === 'connected'
                        ? Date.now() - connectedAt
                        : null,
                    reconnects: reconnectCount,
                    cipher: connectionState === 'connected' ? negotiatedCipher : '',
                    serverVersion: connectionState === 'connected' ? negotiatedServerVersion : ''
                  }).map((row) => (
                    <div className="webssh-conn-row" key={row.label}>
                      <dt>{row.label}</dt>
                      <dd className={`webssh-conn-tone--${row.tone}`}>{row.value}</dd>
                    </div>
                  ))}
                  {connectionState === 'connected' && (
                    <>
                      <div className="webssh-conn-row">
                        <dt>Transport</dt>
                        <dd>{transportMode === 'go-gateway' ? 'Go Gateway (SSH+SFTP)' : 'Cloudflare Relay (TCP only)'}</dd>
                      </div>
                      <div className="webssh-conn-row">
                        <dt>Environment</dt>
                        <dd>{environmentLabel || '—'}</dd>
                      </div>
                      <div className="webssh-conn-row">
                        <dt>Open tabs</dt>
                        <dd>{tabs.filter((t) => t.connected).length}</dd>
                      </div>
                    </>
                  )}
                </dl>
              </div>
            ) : null}
          </span>
          <span className="webssh-statusbar-meta">
            <span>{cols}×{rows}</span>
            <span aria-hidden="true">·</span>
            <span>{fontSize}px</span>
            <span aria-hidden="true">·</span>
            <span>{transportMode === 'go-gateway' ? 'Gateway' : 'Relay'}</span>
            {connectionState === 'connected' && negotiatedServerVersion ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{negotiatedServerVersion}</span>
              </>
            ) : null}
            {rendererNotice ? (
              <>
                <span aria-hidden="true">·</span>
                <span data-testid="terminal-renderer-notice" role="status">
                  {rendererNotice}
                </span>
              </>
            ) : null}
            {ideMode ? (
              <>
                <span aria-hidden="true">·</span>
                <span>IDE</span>
              </>
            ) : null}
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
          {activeJumpHops ? (
            <p className="ws-mod-muted" role="note" data-testid="connect-jump-chain">
              ProxyJump: {activeJumpHops.map((j) => `${j.user}@${j.host}:${j.port}`).join(' → ')} →{' '}
              {connectHost}:{connectPort}. The same credentials are used for every hop;
              the Go gateway dials the chain, the Cloudflare relay refuses it.
            </p>
          ) : null}
          <div>
            <label htmlFor="modal-transport-mode-select">SSH Transport Mode</label>
            <select
              id="modal-transport-mode-select"
              className="ui-input"
              value={transportMode}
              onChange={(e) => {
                const mode = (e.target as HTMLSelectElement).value as TransportBackendMode;
                setTransportMode(mode);
                try {
                  globalThis.localStorage?.setItem('webssh.transport.mode', mode);
                } catch {
                  // ignore
                }
              }}
              data-testid="modal-transport-mode-select"
            >
              <option value="go-gateway">
                Go SSH/SFTP Gateway (Full PTY + SFTP + Editor + Tunnels + 4 MiB Resume)
              </option>
              <option value="cloudflare-relay">
                Cloudflare Worker SSH Relay (Browser SSH-2.0 over cloudflare:sockets — Zero Target Agent)
              </option>
            </select>
          </div>
          <div>
            <label htmlFor="connect-gateway-input">
              {transportMode === 'cloudflare-relay'
                ? 'Cloudflare Worker Relay URL (wss://<worker>.workers.dev/ws)'
                : 'SSH Gateway WebSocket URL'}
            </label>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <input
                id="connect-gateway-input"
                type="text"
                className="ui-input"
                placeholder="wss://ssh-gateway.yourdomain.com/ws or ws://127.0.0.1:8080/ws"
                value={gatewayUrl}
                onInput={(e) => {
                  const val = (e.target as HTMLInputElement).value;
                  setGatewayUrl(val);
                  setGatewayProbeStatus(null);
                  try {
                    globalThis.localStorage?.setItem('webssh.gateway.wsUrl', val);
                  } catch {
                    // ignore
                  }
                }}
                data-testid="gateway-url-input"
              />
              <Button
                variant="default"
                type="button"
                testId="modal-test-gateway-btn"
                onClick={() => void handleTestGateway(gatewayUrl)}
              >
                Test Gateway
              </Button>
            </div>
          </div>
          <div>
            <label htmlFor="connect-gateway-token-input">Gateway Auth Token (Optional EC2 WSS Token)</label>
            <input
              id="connect-gateway-token-input"
              type="password"
              className="ui-input"
              placeholder="Optional GATEWAY_AUTH_TOKEN or OIDC JWT"
              value={gatewayAuthToken}
              onInput={(e) => {
                const val = (e.target as HTMLInputElement).value;
                setGatewayAuthToken(val);
                try {
                  globalThis.sessionStorage?.setItem('webssh.gateway.authToken', val);
                } catch {
                  // ignore
                }
              }}
              data-testid="gateway-token-input"
            />
          </div>
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
          ref={(el) => {
            paletteInputRef.current = el;
          }}
          type="search"
          className="ui-input"
          placeholder="Type a command or search actions…"
          value={paletteQuery}
          onInput={(e) => {
            setPaletteQuery((e.target as HTMLInputElement).value);
            setPaletteIndex(0);
          }}
          onKeyDown={(e) => {
            const items = paletteRegistry.search(paletteQuery);
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setPaletteIndex((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setPaletteIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const cmd = items[paletteIndex];
              if (cmd) void cmd.run();
            } else if (e.key === 'Escape') {
              setPaletteOpen(false);
            }
          }}
          aria-label="Command palette search"
          data-testid="command-palette-input"
          autoFocus
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', marginTop: 'var(--space-3)' }}>
          {paletteRegistry.search(paletteQuery).map((cmd, idx) => (
            <Button
              key={cmd.id}
              variant={idx === paletteIndex ? 'primary' : 'ghost'}
              onClick={() => void cmd.run()}
              onMouseEnter={() => setPaletteIndex(idx)}
              testId={`palette-cmd-${cmd.id}`}
            >
              <span>{cmd.title}</span>
              {cmd.shortcut ? <Badge tone="neutral">{cmd.shortcut}</Badge> : null}
            </Button>
          ))}
        </div>
      </Modal>

      <Modal
        open={shortcutsOpen}
        title="Keyboard Shortcuts"
        onClose={() => setShortcutsOpen(false)}
        testId="shortcuts-modal"
      >
        <dl className="webssh-shortcuts" data-testid="shortcuts-list">
          <dt>
            <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>K</kbd>
          </dt>
          <dd>Open or close the command palette. Inside it: ↑ ↓ to move, Enter to run, Esc to close.</dd>
          <dt>
            <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>F</kbd>
          </dt>
          <dd>Find text in the active terminal. Enter finds the next match, Shift+Enter the previous, Esc closes.</dd>
          <dt>
            <kbd>?</kbd>
          </dt>
          <dd>Show this shortcuts list (not while typing in a text field).</dd>
          <dt>
            <kbd>F11</kbd>
          </dt>
          <dd>Toggle immersive full-screen terminal.</dd>
          <dt>
            <kbd>Esc</kbd>
          </dt>
          <dd>Leave Zen mode, full screen, or close an open dialog.</dd>
          <dt>
            <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>S</kbd>
          </dt>
          <dd>Save the active editor file (in the editor screen).</dd>
          <dt>
            <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>S</kbd>
          </dt>
          <dd>Save all open editor files.</dd>
          <dt>
            <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>T</kbd>
          </dt>
          <dd>Open a new terminal tab.</dd>
          <dt>
            <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>D</kbd>
          </dt>
          <dd>Split the terminal into panes.</dd>
          <dt>Double-click</dt>
          <dd>Rename a session tab.</dd>
        </dl>
      </Modal>

      <Modal
        open={hostKeyModal !== 'none'}
        danger={hostKeyModal === 'mismatch'}
        title={hostKeyModal === 'mismatch' ? 'WARNING: REMOTE HOST KEY CHANGED' : 'Verify Unknown Host Key (TOFU)'}
        onClose={() => {
          setHostKeyModal('none');
          if (hostKeyDecisionResolverRef.current) {
            hostKeyDecisionResolverRef.current(false);
            hostKeyDecisionResolverRef.current = null;
          }
        }}
        testId="hostkey-modal"
      >
        <p>
          Host:{' '}
          <strong>
            {pendingHostKeyPrompt?.host || connectHost || 'localhost'}:
            {pendingHostKeyPrompt?.port || connectPort || '22'}
          </strong>
        </p>
        <p>
          SHA-256 Fingerprint:{' '}
          <code data-testid="hostkey-modal-fingerprint">
            {pendingHostKeyPrompt?.fingerprint || 'not available'}
          </code>
        </p>
        {hostKeyModal === 'mismatch' ? (
          <p>
            The host key does not match your pinned fingerprint (
            <code>{pendingHostKeyPrompt?.expectedFingerprint || 'pinned-key'}</code>). This could indicate a
            man-in-the-middle attack. Connection is blocked unless you explicitly override.
          </p>
        ) : (
          <p>Trust on first use (TOFU) will pin this SHA-256 fingerprint in your browser store.</p>
        )}
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
          <Button
            variant={hostKeyModal === 'mismatch' ? 'danger' : 'primary'}
            onClick={() => {
              if (pendingHostKeyPrompt) {
                knownHosts.revokeHost(pendingHostKeyPrompt.host, pendingHostKeyPrompt.port);
                knownHosts.trustNewHost(
                  pendingHostKeyPrompt.host,
                  pendingHostKeyPrompt.port,
                  pendingHostKeyPrompt.algorithm,
                  pendingHostKeyPrompt.fingerprint,
                  pendingHostKeyPrompt.publicKeyBase64
                );
              }
              setHostKeyModal('none');
              setPendingHostKeyPrompt(null);
              if (hostKeyDecisionResolverRef.current) {
                hostKeyDecisionResolverRef.current(true);
                hostKeyDecisionResolverRef.current = null;
              }
            }}
            testId="hostkey-confirm-btn"
          >
            {hostKeyModal === 'mismatch' ? 'Explicit Override & Pin New Key' : 'Trust & Pin Host Key'}
          </Button>
          <Button
            variant="default"
            testId="hostkey-reject-btn"
            onClick={() => {
              setHostKeyModal('none');
              setPendingHostKeyPrompt(null);
              if (hostKeyDecisionResolverRef.current) {
                hostKeyDecisionResolverRef.current(false);
                hostKeyDecisionResolverRef.current = null;
              }
            }}
          >
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
