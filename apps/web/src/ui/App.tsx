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
import {
  KeyVault,
  KnownHostsStore,
  base64ToBytes,
  bytesToBase64,
  validateAndInspectPrivateKeyPem
} from '../vault';
import { HostRegistry, type HostProfile } from '../hosts';
import { PreferencesStore, type CursorShape, type LayoutPreset, type WorkspacePreset } from '../prefs';
import { XtermPaneAdapter } from '../terminal/xterm-adapter';
import {
  BrowserSshRelaySessionClient,
  LiveGatewaySessionClient,
  deriveGatewayHealthUrl,
  loginToCloudflareRelay,
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
import { repairApplicationAssetCaches } from './ErrorBoundary';
import {
  ActivityPanel,
  DeploymentsPanel,
  AutomationsPanel,
  ContainersPanel,
  KubernetesPanel,
  OverviewPanel,
  SoftwarePanel,
  runDiscovery,
  type ModuleContext
} from './ServerModules';
import { createRemoteSession, type WorkspaceRemoteSession } from '../session/adapters';
import { CapabilityMatrixPanel } from './CapabilityMatrixPanel';
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
  | 'snippets'
  | 'settings'
  | 'overview'
  | 'software'
  | 'containers'
  | 'kubernetes'
  | 'automations'
  | 'deployments'
  | 'activity';

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
  channelId?: number;
}

export function App(): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const terminalViewRef = useRef<HTMLDivElement | null>(null);
  const xtermHostRef = useRef<HTMLDivElement | null>(null);
  const xtermAdapterRef = useRef<XtermPaneAdapter | null>(null);

  const prefsStore = useMemo(() => new PreferencesStore(), []);
  const hostRegistry = useMemo(() => new HostRegistry(), []);

  const vault = useMemo(() => new KeyVault(), []);
  const knownHosts = useMemo(() => new KnownHostsStore(), []);
  const liveSessionRef = useRef<LiveGatewaySessionClient | BrowserSshRelaySessionClient | null>(null);
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

  // Default to clean Welcome screen & Minimal Mode (IDE mode disabled until requested)
  const [activeScreen, setActiveScreen] = useState<ScreenId>('welcome');
  const [ideMode, setIdeMode] = useState<boolean>(false);
  const [activeTheme, setActiveTheme] = useState<ThemeId>(() => {
    const stored = prefsStore.get().activeThemeId;
    return (THEME_IDS as readonly string[]).includes(stored) ? (stored as ThemeId) : 'dark';
  });
  const [layoutPreset, setLayoutPreset] = useState<LayoutPreset>(() => prefsStore.get().layoutPreset);
  const [workspacePreset, setWorkspacePreset] = useState<WorkspacePreset>(
    () => prefsStore.get().workspacePreset
  );
  const [railWidth, setRailWidth] = useState<number>(() => prefsStore.get().railWidthPx);
  const [cursorShape, setCursorShape] = useState<CursorShape>(() => prefsStore.get().surface.cursorShape);
  const [zenMode, setZenMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
  const [showOverlayBar, setShowOverlayBar] = useState(false);
  const [showFullscreenToast, setShowFullscreenToast] = useState(false);

  // 3. Fresh Default State (Zero Pre-Populated Mock Data)
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [sessionTabLabel, setSessionTabLabel] = useState<string>('Terminal 1');
  const [connectedUser, setConnectedUser] = useState<string>('');
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
  const [paletteQuery, setPaletteQuery] = useState('');
  const [hostKeyModal, setHostKeyModal] = useState<'none' | 'tofu' | 'mismatch'>('none');
  const [hosts, setHosts] = useState<HostProfile[]>(() => hostRegistry.list());
  const [cacheRepairStatus, setCacheRepairStatus] = useState<string>('');
  const [hostSearch, setHostSearch] = useState('');
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
  const [editorFilePath, setEditorFilePath] = useState<string>('README.md');
  const [editorOriginalContent, setEditorOriginalContent] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [editorSaved, setEditorSaved] = useState(true);
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
  const [relaySessionUser, setRelaySessionUser] = useState<string>('');

  const handleRelayLogin = async (): Promise<void> => {
    try {
      const res = await loginToCloudflareRelay(gatewayUrl, relayLoginUser, relayLoginPass);
      setGatewayAuthToken(res.token);
      setRelaySessionUser(res.userId);
      setRelayLoginPass('');
      setGatewayProbeStatus({
        ok: true,
        message: `Relay Session Active (${res.userId}) · Short-lived JWT expires in ${Math.round(
          res.expiresIn / 60
        )}m`
      });
    } catch (err) {
      setGatewayProbeStatus({
        ok: false,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  };
  const [negotiatedCipher, setNegotiatedCipher] = useState<string>('chacha20-poly1305@openssh.com');
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
      const res = await sessionClient.sftpOp({ op: 'read_file', path: remotePath });
      if (res.ok && res.dataBase64 !== undefined) {
        const text = new TextDecoder().decode(base64ToBytes(res.dataBase64));
        setEditorFilePath(remotePath);
        setEditorOriginalContent(text);
        setEditorContent(text);
        setEditorSaved(true);
      } else {
        setEditorError(res.error ?? `Could not read ${remotePath}`);
      }
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
      const res = await activeClient.sftpOp({
        op: 'write_file',
        path: target,
        dataBase64: btoa(binary)
      });
      if (!res.ok) {
        setTransferStatus(`Upload failed: ${res.error ?? 'Unknown error'}`);
        return;
      }
      setTransferStatus(`Uploaded ${file.name} to ${target} (${bytes.byteLength} bytes)`);
      void refreshSftpDirectory(sftpCurrentPath, activeClient, true);
    } catch (err) {
      setTransferStatus(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const downloadRemoteFile = async (remotePath: string): Promise<void> => {
    const activeClient = liveSessionRef.current;
    if (!activeClient || !activeClient.isConnected) {
      setTransferStatus('Download not started: the SSH session is disconnected.');
      return;
    }
    try {
      const res = await activeClient.sftpOp({ op: 'read_file', path: remotePath });
      if (!res.ok || res.dataBase64 === undefined) {
        setTransferStatus(`Download failed: ${res.error ?? 'No data returned'}`);
        return;
      }
      const bytes = base64ToBytes(res.dataBase64);
      const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = remotePath.split('/').pop() || 'download.bin';
      a.click();
      URL.revokeObjectURL(url);
      setTransferStatus(`Downloaded ${remotePath} (${bytes.byteLength} bytes)`);
    } catch (err) {
      setTransferStatus(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
        const current = await activeClient.sftpOp({ op: 'read_file', path: editorFilePath });
        // Fail closed: if the file cannot be re-read, a blind write could
        // silently destroy another operator's change.
        if (!current.ok || current.dataBase64 === undefined) {
          setEditorError(
            `Not saved: could not re-read ${editorFilePath} to check for conflicts (${current.error ?? 'unknown error'}). Retry, or use "Overwrite with my version" if you accept the risk.`
          );
          return;
        }
        if (new TextDecoder().decode(base64ToBytes(current.dataBase64)) !== editorOriginalContent) {
          setEditorConflict(
            `${editorFilePath} changed on the server since you opened it. Saving now would overwrite those changes.`
          );
          return;
        }
      }
      const encoded = bytesToBase64(new TextEncoder().encode(editorContent));
      const res = await activeClient.sftpOp({
        op: 'write_file',
        path: editorFilePath,
        dataBase64: encoded
      });
      if (!res.ok) {
        setEditorError(`Save failed: ${res.error ?? 'Unknown error'}`);
        return;
      }
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
    const isLive = Boolean(liveSessionRef.current?.isConnected);
    const newTitle = isLive
      ? `Terminal ${nextNum} (${connectedUser}@${connectedHost})`
      : `Terminal ${nextNum}`;
    setTabs((prev) => [...prev, { id: newId, title: newTitle, connected: isLive, channelId: nextNum }]);
    setActiveTabId(newId);
    setSessionTabLabel(newTitle);
    setActiveScreen('workspace');
    if (liveSessionRef.current?.isConnected) {
      void liveSessionRef.current
        .openChannel(cols, rows)
        .then((res) => {
          if (res.ok && res.channel) {
            setTabs((prev) =>
              prev.map((t) => (t.id === newId ? { ...t, channelId: res.channel, connected: true } : t))
            );
          }
        })
        .catch(() => {
          // Ignore channel open errors
        });
    }
  };

  const handleCloseTab = (tabId: string, e?: Event): void => {
    if (e) e.stopPropagation();
    const closingTab = tabs.find((t) => t.id === tabId);
    if (closingTab?.channelId && liveSessionRef.current?.isConnected && tabs.length > 1) {
      liveSessionRef.current.closeChannel(closingTab.channelId);
    }
    if (tabs.length <= 1) {
      liveSessionRef.current?.close();
      liveSessionRef.current = null;
      setConnectionState('disconnected');
      setSessionTabLabel('Terminal 1');
      setConnectedUser('bob');
      setConnectedHost('caleston-lp10');
      setTabs([{ id: 'tab-1', title: 'Terminal 1', connected: false, channelId: 1 }]);
      setActiveTabId('tab-1');
      setSftpRawEntries([]);
      setTransferStatus('Disconnected — Connect to an SSH host to browse SFTP files');
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
    liveSessionRef.current?.close();
    liveSessionRef.current = null;
    setConnectionState('disconnected');
    setPendingInputBytes(0);
    setSftpRawEntries([]);
    setTransferStatus('Disconnected — Connect to an SSH host to browse SFTP files');
    setTerminalLines((prev) => [...prev, `Disconnected from ${sessionTabLabel}.`]);
    writeToXterm(
      `${String.fromCharCode(13, 10)}Disconnected from ${sessionTabLabel}.${String.fromCharCode(13, 10)}webssh:~$ `
    );
    const resetTitle = 'Terminal 1';
    setSessionTabLabel(resetTitle);
    setConnectedUser('bob');
    setConnectedHost('caleston-lp10');
    setTabs((prev) =>
      prev.map((t) => ({ ...t, title: t.id === activeTabId ? resetTitle : t.title, connected: false }))
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
    const hostVal = connectHost.trim() || '127.0.0.1';
    const userVal = connectUser.trim() || 'ubuntu';
    const portVal = connectPort.trim() || '22';
    const portNum = Number.parseInt(portVal, 10) || 22;
    const label = `${userVal}@${hostVal}`;
    const tabTitle = `Terminal 1 (${label})`;

    void (async () => {
      if (authMethod === 'Private Key (.pem / id_rsa)' && uploadedKeyContent.trim()) {
        const keyCheck = await validateAndInspectPrivateKeyPem(uploadedKeyContent);
        if (!keyCheck.valid) {
          setConnectErrorMsg(keyCheck.error ?? 'Invalid private key PEM format.');
          return;
        }
      }

      liveSessionRef.current?.close();
      const protocolAuthMethod =
        authMethod === 'Password'
          ? 'password'
          : authMethod === 'Private Key (.pem / id_rsa)'
            ? 'private_key'
            : 'remote_signer';

      const sessionParams = {
        transportMode,
        gatewayUrl: gwValidation.normalizedUrl,
        gatewayAuthToken,
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
        onPtyData: (_channel: number, data: Uint8Array) => {
          try {
            xtermAdapterRef.current?.writeBytes(data);
          } catch {
            // ignore
          }
          const rawText = new TextDecoder().decode(data);
          const cleaned = rawText
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\r/g, '')
            .split('\n')
            .map((l) => l.trimEnd())
            .filter((l) => l.length > 0);
          if (cleaned.length > 0) {
            setTerminalLines((prev) => [...prev.slice(-200), ...cleaned]);
          }
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
            prev.map((t) => (t.channelId === channel ? { ...t, connected: false } : t))
          );
        },
        onStateChange: (st: string) => {
          if (st === 'disconnected') {
            setConnectionState('disconnected');
            setTabs((prev) => prev.map((t) => ({ ...t, connected: false })));
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
        hostRegistry.upsert({
          id: `host-${hostVal}-${portVal}`,
          alias: hostVal,
          host: hostVal,
          port: portNum,
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
        setNegotiatedCipher(meta.cipher || 'chacha20-poly1305@openssh.com');
        setNegotiatedServerVersion(meta.serverVersion || 'SSH-2.0-OpenSSH');
        setTabs((prev) =>
          prev.map((t) =>
            t.id === activeTabId
              ? { ...t, title: tabTitle, connected: true, channelId: meta.ptyChannel || 1 }
              : t
          )
        );
        setConnectionState('connected');
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
        setConnectionState('disconnected');
        setTabs((prev) => prev.map((t) => ({ ...t, connected: false })));
        const errMsg = err instanceof Error ? err.message : String(err);
        setConnectErrorMsg(errMsg);
        setTerminalLines((prev) => [...prev, `[SSH Connection Error] ${errMsg}`]);
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
        xtermAdapterRef.current?.terminal.clear();
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
      if (broadcastInput && splitPanes > 1) {
        activeClient.sendPtyText(2, trimmed + String.fromCharCode(13));
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
        xtermAdapterRef.current?.terminal.clear();
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
            liveSessionRef.current?.resizeChannel(1, c, r);
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
                    <span>{ideMode ? 'Disable IDE Mode' : 'Enable IDE Mode'}</span>
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

      <div
        className={`webssh-workspace-body ${
          layoutPreset === 'sidebar-right' ? 'webssh-workspace-body--right' : ''
        }`.trim()}
      >
        {!isFullscreen && !zenMode ? (
          <>
          <nav
            className="webssh-rail"
            aria-label="Workspace navigation"
            style={{ width: `${railWidth}px` }}
          >
            <Button
              variant={activeScreen === 'welcome' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('welcome')}
              testId="nav-welcome"
            >
              Welcome
            </Button>
            <div className="webssh-rail-presets" role="group" aria-label="Workspace preset">
              {(['terminal', 'develop', 'operate'] as const).map((preset) => (
                <Button
                  key={preset}
                  variant={workspacePreset === preset ? 'primary' : 'ghost'}
                  onClick={() => applyPreset(preset)}
                  testId={`preset-${preset}`}
                >
                  {preset[0]!.toUpperCase() + preset.slice(1)}
                </Button>
              ))}
            </div>
            <Button
              variant={activeScreen === 'workspace' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('workspace')}
              testId="nav-workspace"
            >
              <Icon name="terminal" /> Terminal
            </Button>
            <Button
              variant={activeScreen === 'overview' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('overview')}
              testId="nav-overview"
            >
              <Icon name="server" /> Servers
            </Button>
            <Button
              variant={activeScreen === 'files' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('files')}
              testId="nav-files"
            >
              <Icon name="folder" /> Files
            </Button>
            <Button
              variant={activeScreen === 'software' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('software')}
              testId="nav-software"
            >
              Software
            </Button>
            <Button
              variant={activeScreen === 'containers' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('containers')}
              testId="nav-containers"
            >
              Containers
            </Button>
            <Button
              variant={activeScreen === 'kubernetes' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('kubernetes')}
              testId="nav-kubernetes"
            >
              Kubernetes
            </Button>
            <Button
              variant={activeScreen === 'automations' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('automations')}
              testId="nav-automations"
            >
              Automations
            </Button>
            <Button
              variant={activeScreen === 'activity' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('activity')}
              testId="nav-activity"
            >
              Activity
            </Button>
            <Button
              variant={activeScreen === 'deployments' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('deployments')}
              testId="nav-deployments"
            >
              Deployments
            </Button>
            <Button
              variant={activeScreen === 'settings' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('settings')}
              testId="nav-settings"
            >
              <Icon name="settings" /> Settings
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
              {ideMode ? 'IDE Mode: ON' : 'Open IDE'}
            </Button>

            {ideMode ? (
              <div data-testid="sidebar-nav" style={{ display: 'contents' }}>
                <Button
                  variant={activeScreen === 'features' ? 'primary' : 'ghost'}
                  onClick={() => setActiveScreen('features')}
                  testId="nav-features"
                >
                  Features (50)
                </Button>
                <Button
                  variant={activeScreen === 'tunnels' ? 'primary' : 'ghost'}
                  onClick={() => setActiveScreen('tunnels')}
                  testId="nav-tunnels"
                >
                  Port Tunnels
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
              </div>
            ) : null}
          </nav>
          <div
            className="webssh-rail-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize navigation rail"
            aria-valuenow={railWidth}
            aria-valuemin={120}
            aria-valuemax={360}
            tabIndex={0}
            onKeyDown={(e) => {
              const step = e.key === 'ArrowLeft' ? -8 : e.key === 'ArrowRight' ? 8 : 0;
              if (!step) return;
              e.preventDefault();
              setRailWidth((w) => {
                const next = Math.min(360, Math.max(120, w + step));
                prefsStore.update({ railWidthPx: next });
                return next;
              });
            }}
            onPointerDown={(e) => {
              const startX = e.clientX;
              const startWidth = railWidth;
              const target = e.currentTarget as HTMLElement;
              target.setPointerCapture(e.pointerId);
              const onMove = (move: PointerEvent): void => {
                const delta =
                  layoutPreset === 'sidebar-right' ? startX - move.clientX : move.clientX - startX;
                setRailWidth(Math.min(360, Math.max(120, startWidth + delta)));
              };
              const onUp = (): void => {
                target.removeEventListener('pointermove', onMove);
                target.removeEventListener('pointerup', onUp);
                setRailWidth((w) => {
                  prefsStore.update({ railWidthPx: w });
                  return w;
                });
              };
              target.addEventListener('pointermove', onMove);
              target.addEventListener('pointerup', onUp);
            }}
          />
          </>
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
                    onClick={() => terminalViewRef.current?.focus()}
                    onKeyDown={handleTerminalKeyDown}
                  >
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

          {activeScreen === 'overview' ? <OverviewPanel ctx={moduleContext} /> : null}
          {activeScreen === 'software' ? <SoftwarePanel ctx={moduleContext} /> : null}
          {activeScreen === 'containers' ? <ContainersPanel ctx={moduleContext} /> : null}
          {activeScreen === 'kubernetes' ? <KubernetesPanel ctx={moduleContext} /> : null}
          {activeScreen === 'automations' ? <AutomationsPanel ctx={moduleContext} /> : null}
          {activeScreen === 'deployments' ? <DeploymentsPanel ctx={moduleContext} /> : null}
          {activeScreen === 'activity' ? <ActivityPanel ctx={moduleContext} /> : null}

          {activeScreen === 'features' ? <CapabilityMatrixPanel /> : null}

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
                    Open IDE
                  </Button>
                </div>
              </div>

              <Card testId="welcome-quick-connect-card">
                <h2>Quick SSH Connect</h2>
                <form
                  onSubmit={handleConnectSubmit}
                  style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
                >
                  <div>
                    <label htmlFor="welcome-transport-mode-select">SSH Transport Mode</label>
                    <select
                      id="welcome-transport-mode-select"
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
                      data-testid="welcome-transport-mode-select"
                    >
                      <option value="go-gateway">
                        Go SSH/SFTP Gateway (Full PTY + SFTP + Editor + Tunnels + 4 MiB Resume)
                      </option>
                      <option value="cloudflare-relay">
                        Cloudflare Worker SSH Relay (Browser SSH-2.0 over cloudflare:sockets — Zero Target Agent)
                      </option>
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div style={{ flex: 2, minWidth: '220px' }}>
                      <label htmlFor="welcome-gateway-url-input">
                        {transportMode === 'cloudflare-relay'
                          ? 'Cloudflare Worker Relay Endpoint (wss://<worker>.workers.dev/ws)'
                          : 'SSH Gateway WebSocket Endpoint (WSS / WS)'}
                      </label>
                      <input
                        id="welcome-gateway-url-input"
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
                        data-testid="welcome-gateway-url-input"
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: '160px' }}>
                      <label htmlFor="welcome-gateway-token-input">Gateway Auth Token (Optional)</label>
                      <input
                        id="welcome-gateway-token-input"
                        type="password"
                        className="ui-input"
                        placeholder="Bearer / EC2 gateway token"
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
                        data-testid="welcome-gateway-token-input"
                      />
                    </div>
                    <Button
                      variant="default"
                      type="button"
                      testId="test-gateway-btn"
                      onClick={() => void handleTestGateway(gatewayUrl)}
                    >
                      Test Gateway
                    </Button>
                  </div>
                  {transportMode === 'cloudflare-relay' ? (
                    <div
                      style={{
                        display: 'flex',
                        gap: 'var(--space-2)',
                        flexWrap: 'wrap',
                        alignItems: 'flex-end'
                      }}
                      data-testid="relay-user-login-bar"
                    >
                      <div style={{ flex: 1, minWidth: '160px' }}>
                        <label htmlFor="relay-login-user-input">Relay Account Username</label>
                        <input
                          id="relay-login-user-input"
                          type="text"
                          className="ui-input"
                          placeholder="alice"
                          value={relayLoginUser}
                          onInput={(e) => setRelayLoginUser((e.target as HTMLInputElement).value)}
                          data-testid="relay-login-user-input"
                        />
                      </div>
                      <div style={{ flex: 1, minWidth: '160px' }}>
                        <label htmlFor="relay-login-pass-input">Relay Account Password</label>
                        <input
                          id="relay-login-pass-input"
                          type="password"
                          className="ui-input"
                          placeholder="Sign in for 15m session JWT"
                          value={relayLoginPass}
                          onInput={(e) => setRelayLoginPass((e.target as HTMLInputElement).value)}
                          data-testid="relay-login-pass-input"
                        />
                      </div>
                      <Button
                        variant="default"
                        type="button"
                        testId="relay-login-submit-btn"
                        onClick={() => void handleRelayLogin()}
                      >
                        {relaySessionUser ? `Signed In (${relaySessionUser})` : 'Sign In to Relay'}
                      </Button>
                    </div>
                  ) : null}
                  {gatewayProbeStatus ? (
                    <Badge
                      tone={gatewayProbeStatus.ok ? 'success' : 'danger'}
                      testId="gateway-probe-badge"
                    >
                      {gatewayProbeStatus.message}
                    </Badge>
                  ) : null}
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
              <p data-testid="transfer-status-badge">{transferStatus}</p>
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
                <ul>
                  {sftpEntries.map((entry) => (
                    <li key={entry.path} data-testid={`sftp-row-${entry.name}`}>
                      <strong>{entry.isDir ? `[DIR] ${entry.name}` : entry.name}</strong> — {entry.size} bytes ({entry.mode}){' '}
                      {entry.isDir ? null : (
                        <Button variant="ghost" onClick={() => void downloadRemoteFile(entry.path)}>
                          Download
                        </Button>
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
                    Save to host {editorSaved ? '(Saved)' : '(Unsaved*)'}
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
                className="ui-input"
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
                    onClick={() => { setLayoutPreset('sidebar-left'); prefsStore.update({ layoutPreset: 'sidebar-left' }); }}
                  >
                    Sidebar Left
                  </Button>
                  <Button
                    variant={layoutPreset === 'sidebar-right' ? 'primary' : 'default'}
                    onClick={() => { setLayoutPreset('sidebar-right'); prefsStore.update({ layoutPreset: 'sidebar-right' }); }}
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
              <Card testId="settings-asset-cache-card">
                <h2>Application Asset Cache Recovery</h2>
                <p>
                  Purge Service Worker and static bundle caches without clearing your saved SSH hosts, non-extractable Key Vault keys, or user preferences.
                </p>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button
                    variant="default"
                    testId="settings-repair-cache-btn"
                    onClick={() => {
                      void repairApplicationAssetCaches().then((res) => {
                        setCacheRepairStatus(
                          `Cleared ${res.deletedCaches.length} asset cache(s) and unregistered ${res.unregisteredServiceWorkers} service worker(s). Saved hosts, keys, and settings preserved.`
                        );
                      });
                    }}
                  >
                    Repair Application Asset Cache
                  </Button>
                  {cacheRepairStatus ? (
                    <Badge tone="success" testId="settings-repair-cache-status">
                      {cacheRepairStatus}
                    </Badge>
                  ) : null}
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
              ? `Connected: ${sessionTabLabel} · Cipher: ${negotiatedCipher}${negotiatedServerVersion ? ` · ${negotiatedServerVersion}` : ''}`
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
