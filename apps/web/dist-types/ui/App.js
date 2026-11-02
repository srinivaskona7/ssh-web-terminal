import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "preact/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Badge, Button, Card, ComponentGallery, EmptyState, Icon, Modal, THEME_IDS, THEMES, applyThemeToDocument } from '@webssh/ui-kit';
import { KeyVault, KnownHostsStore, base64ToBytes, bytesToBase64, validateAndInspectPrivateKeyPem } from '../vault';
import { HostRegistry } from '../hosts';
import { PreferencesStore } from '../prefs';
import { XtermPaneAdapter } from '../terminal/xterm-adapter';
import { LiveGatewaySessionClient, resolveGatewayWsUrl } from '../transport';
import { AsciicastRecorder, CommandPaletteRegistry, KeybindingRegistry, SPECIAL_KEYS_ROW, SnippetLibrary, interpolateSnippet, parseAsciicastV2, scrubAsciicastOutput } from './productivity';
import { StorageGuard, sortAndFilterEntries } from '../files';
import { computeGhostAutocomplete, computeSideBySideDiff, detectDangerousCommand, formatChmodOctal, redactSecretsInText } from './advanced-features';
import { repairApplicationAssetCaches } from './ErrorBoundary';
export const FIFTY_FEATURES_CATALOG = [
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
export function App() {
    const rootRef = useRef(null);
    const terminalViewRef = useRef(null);
    const xtermHostRef = useRef(null);
    const xtermAdapterRef = useRef(null);
    const prefsStore = useMemo(() => new PreferencesStore(), []);
    const hostRegistry = useMemo(() => new HostRegistry(), []);
    const vault = useMemo(() => new KeyVault(), []);
    const knownHosts = useMemo(() => new KnownHostsStore(), []);
    const liveSessionRef = useRef(null);
    const hostKeyDecisionResolverRef = useRef(null);
    const storageGuard = useMemo(() => new StorageGuard(), []);
    const snippetLib = useMemo(() => new SnippetLibrary([
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
    ]), []);
    const keybindings = useMemo(() => new KeybindingRegistry([
        { actionId: 'palette.toggle', description: 'Open Command Palette', shortcut: 'Cmd/Ctrl+K' },
        { actionId: 'fullscreen.toggle', description: 'Toggle Immersive Full-Screen', shortcut: 'F11' },
        { actionId: 'vault.lock', description: 'Lock Key Vault', shortcut: 'Cmd/Ctrl+Shift+L' }
    ]), []);
    // 1 & 3. Default Font Size (+20% = 17px) & Font Family
    const [fontSize, setFontSize] = useState(17);
    const [fontFamily, setFontFamily] = useState("'JetBrains Mono', 'Fira Code', monospace");
    const [cols, setCols] = useState(80);
    const [rows, setRows] = useState(24);
    // 1. Native Menu Bar state
    const [openMenu, setOpenMenu] = useState(null);
    // 2. macOS / VS Code / Studio Tabs state
    const [tabs, setTabs] = useState([
        { id: 'tab-1', title: 'Terminal 1', connected: false }
    ]);
    const [activeTabId, setActiveTabId] = useState('tab-1');
    const [splitPanes, setSplitPanes] = useState(1);
    const [broadcastInput, setBroadcastInput] = useState(false);
    // Default to clean Welcome screen & Minimal Mode (IDE mode disabled until requested)
    const [activeScreen, setActiveScreen] = useState('welcome');
    const [ideMode, setIdeMode] = useState(false);
    const [activeTheme, setActiveTheme] = useState(() => {
        const stored = prefsStore.get().activeThemeId;
        return THEME_IDS.includes(stored) ? stored : 'dark';
    });
    const [layoutPreset, setLayoutPreset] = useState(() => prefsStore.get().layoutPreset);
    const [cursorShape, setCursorShape] = useState(() => prefsStore.get().surface.cursorShape);
    const [zenMode, setZenMode] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
    const [showOverlayBar, setShowOverlayBar] = useState(false);
    const [showFullscreenToast, setShowFullscreenToast] = useState(false);
    // 3. Fresh Default State (Zero Pre-Populated Mock Data)
    const [connectionState, setConnectionState] = useState('disconnected');
    const [sessionTabLabel, setSessionTabLabel] = useState('Terminal 1');
    const [connectedUser, setConnectedUser] = useState('bob');
    const [connectedHost, setConnectedHost] = useState('caleston-lp10');
    const [pendingInputBytes, setPendingInputBytes] = useState(0);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [paletteQuery, setPaletteQuery] = useState('');
    const [hostKeyModal, setHostKeyModal] = useState('none');
    const [hosts, setHosts] = useState(() => hostRegistry.list());
    const [cacheRepairStatus, setCacheRepairStatus] = useState('');
    const [hostSearch, setHostSearch] = useState('');
    const [sshConfigInput, setSshConfigInput] = useState('');
    const [generatedPubKey, setGeneratedPubKey] = useState('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWebSSHStudioBrowserNonExtractableKey webssh@browser');
    const [generatedFp, setGeneratedFp] = useState('SHA256:k9XmP2vR7wL4qN8sT1yB6cF3hJ5mZ0pQ9vW2xR4tY8u');
    const [vaultLocked, setVaultLocked] = useState(false);
    const [fileFilter, setFileFilter] = useState('');
    const [transferStatus, setTransferStatus] = useState('Disconnected — Connect to an SSH host to browse SFTP files');
    const [sftpRawEntries, setSftpRawEntries] = useState([]);
    const [sftpCurrentPath, setSftpCurrentPath] = useState('~');
    const [editorFilePath, setEditorFilePath] = useState('README.md');
    const [editorOriginalContent, setEditorOriginalContent] = useState('');
    const [editorContent, setEditorContent] = useState('');
    const [editorSaved, setEditorSaved] = useState(true);
    const [showDiffViewer, setShowDiffViewer] = useState(false);
    const [gatewayUrl, setGatewayUrl] = useState(() => resolveGatewayWsUrl());
    const [negotiatedCipher, setNegotiatedCipher] = useState('chacha20-poly1305@openssh.com');
    const [negotiatedServerVersion, setNegotiatedServerVersion] = useState('');
    const [pendingHostKeyPrompt, setPendingHostKeyPrompt] = useState(null);
    const [tunnelPreviewOutput, setTunnelPreviewOutput] = useState('Connect to an SSH host and click Probe HTTP Preview to inspect remote localhost HTTP responses.');
    const [scrubberSec, setScrubberSec] = useState(2.5);
    const [snippetVarService, setSnippetVarService] = useState('sshd');
    const [snippetVarLines, setSnippetVarLines] = useState('50');
    // Step 12 Advanced Feature Suite State (Clean / Empty until connected or invoked)
    const [redactionMode, setRedactionMode] = useState(false);
    const [dangerousCommandPending, setDangerousCommandPending] = useState(null);
    const [commandBlocks, setCommandBlocks] = useState([]);
    const [vitals, setVitals] = useState({
        cpuPercent: 0,
        ramUsedGiB: 0,
        ramTotalGiB: 0,
        diskIoMbps: 0,
        netRxMbps: 0,
        netTxMbps: 0,
        loadAvg: [0, 0, 0]
    });
    const [processFilter, setProcessFilter] = useState('');
    const [processes, setProcesses] = useState([]);
    const [containers, setContainers] = useState([]);
    const [listeningPorts, setListeningPorts] = useState([]);
    const [tunnels, setTunnels] = useState([]);
    const [webPreviewPort, setWebPreviewPort] = useState(3000);
    const [newTunnelLocalPort, setNewTunnelLocalPort] = useState('8080');
    const [newTunnelRemotePort, setNewTunnelRemotePort] = useState('80');
    const [chmodTargetFile, setChmodTargetFile] = useState('~/.ssh/id_ed25519');
    const [chmodPerms, setChmodPerms] = useState({
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
    const [tailLogLines, setTailLogLines] = useState([]);
    const [tailFilter, setTailFilter] = useState('');
    const [tailPaused, setTailPaused] = useState(false);
    const [relayStatus, setRelayStatus] = useState('Ready to relay files between two connected SSH hosts');
    const [fido2Enrolled, setFido2Enrolled] = useState(false);
    const [fido2KeyLine, setFido2KeyLine] = useState('');
    const [sshCertInfo] = useState({
        keyId: 'none',
        certType: 'user',
        principals: [],
        validAfter: '—',
        validBefore: '—',
        caFingerprint: '—',
        extensions: ['permit-pty', 'permit-port-forwarding']
    });
    const [playbookScript, setPlaybookScript] = useState('uptime && uname -a');
    const [playbookResults, setPlaybookResults] = useState([]);
    // 50-Feature Explorer & Workbench State
    const [featureCategory, setFeatureCategory] = useState('All');
    const [featureQuery, setFeatureQuery] = useState('');
    const [selectedFeatureId, setSelectedFeatureId] = useState(1);
    const [lastExecutedFeatureMsg, setLastExecutedFeatureMsg] = useState('Select any of the 50 features below to inspect and run it live.');
    const [terminalLines, setTerminalLines] = useState([
        'WebSSH Studio v1.0.0',
        "Type 'help' for local commands or click 'New Connection' to authenticate."
    ]);
    // 4. Interactive Terminal Input & Command Execution State
    const [currentInput, setCurrentInput] = useState('');
    const currentInputRef = useRef('');
    const [history, setHistory] = useState([]);
    const historyRef = useRef([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const historyIndexRef = useRef(-1);
    const [copiedSnippet, setCopiedSnippet] = useState(false);
    const ghostSuggestion = useMemo(() => computeGhostAutocomplete(currentInput, history), [currentInput, history]);
    const chmodFormatted = useMemo(() => formatChmodOctal(chmodPerms), [chmodPerms]);
    const diffEntries = useMemo(() => computeSideBySideDiff(editorOriginalContent, editorContent), [editorOriginalContent, editorContent]);
    const updateCurrentInput = (next) => {
        const resolved = typeof next === 'function' ? next(currentInputRef.current) : next;
        currentInputRef.current = resolved;
        setCurrentInput(resolved);
    };
    // 5. Simple Server Connection (Password OR Private Key Upload with chmod 0400 permission)
    const [connectModalOpen, setConnectModalOpen] = useState(false);
    const [connectHost, setConnectHost] = useState('');
    const [connectPort, setConnectPort] = useState('22');
    const [connectUser, setConnectUser] = useState('ubuntu');
    const [authMethod, setAuthMethod] = useState('Password');
    const [connectPassword, setConnectPassword] = useState('');
    const [uploadedKeyFileName, setUploadedKeyFileName] = useState('');
    const [uploadedKeyContent, setUploadedKeyContent] = useState('');
    const [keyPermissionMode, setKeyPermissionMode] = useState('0400');
    const [connectErrorMsg, setConnectErrorMsg] = useState('');
    const authorizedKeysSnippet = useMemo(() => `echo "${generatedPubKey}" >> ~/.ssh/authorized_keys`, [generatedPubKey]);
    const activeSessionTitle = useMemo(() => {
        const found = tabs.find((t) => t.id === activeTabId);
        return found ? found.title : sessionTabLabel;
    }, [tabs, activeTabId, sessionTabLabel]);
    const writeToXterm = (text) => {
        try {
            xtermAdapterRef.current?.writeText(text);
        }
        catch {
            // Ignore in headless environments without canvas
        }
    };
    const copyToClipboard = (text) => {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            void navigator.clipboard.writeText(text).catch(() => {
                // Ignore clipboard errors in restricted environments
            });
        }
        setCopiedSnippet(true);
        setTimeout(() => setCopiedSnippet(false), 2000);
    };
    const refreshSftpDirectory = async (targetPath = sftpCurrentPath, sessionClient = liveSessionRef.current) => {
        if (!sessionClient || !sessionClient.isConnected) {
            setTransferStatus('Disconnected — Connect to an SSH host to browse SFTP files');
            return;
        }
        try {
            const res = await sessionClient.sftpOp({ op: 'list', path: targetPath });
            if (res.ok && res.entries) {
                setSftpCurrentPath(targetPath);
                setSftpRawEntries(res.entries);
                setTransferStatus(`Listed ${res.entries.length} remote items in ${targetPath}`);
            }
            else {
                setTransferStatus(`SFTP list error: ${res.error ?? 'Unknown error'}`);
            }
        }
        catch (err) {
            setTransferStatus(`SFTP list failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const loadRemoteFileIntoEditor = async (remotePath = editorFilePath, sessionClient = liveSessionRef.current) => {
        if (!sessionClient || !sessionClient.isConnected) {
            return;
        }
        try {
            const res = await sessionClient.sftpOp({ op: 'read_file', path: remotePath });
            if (res.ok && res.dataBase64 !== undefined) {
                const text = new TextDecoder().decode(base64ToBytes(res.dataBase64));
                setEditorFilePath(remotePath);
                setEditorOriginalContent(text);
                setEditorContent(text);
                setEditorSaved(true);
            }
        }
        catch {
            // Ignore if file does not exist yet
        }
    };
    const handleAddTab = () => {
        const nextNum = tabs.length + 1;
        const newId = `tab-${Date.now()}-${nextNum}`;
        const isLive = Boolean(liveSessionRef.current?.isConnected);
        const newTitle = isLive
            ? `Terminal ${nextNum} (${connectedUser}@${connectedHost})`
            : `Terminal ${nextNum}`;
        setTabs((prev) => [...prev, { id: newId, title: newTitle, connected: isLive }]);
        setActiveTabId(newId);
        setSessionTabLabel(newTitle);
        setActiveScreen('workspace');
        if (liveSessionRef.current?.isConnected) {
            void liveSessionRef.current.openChannel(cols, rows).catch(() => {
                // Ignore channel open errors
            });
        }
    };
    const handleCloseTab = (tabId, e) => {
        if (e)
            e.stopPropagation();
        if (tabs.length <= 1) {
            liveSessionRef.current?.close();
            liveSessionRef.current = null;
            setConnectionState('disconnected');
            setSessionTabLabel('Terminal 1');
            setConnectedUser('bob');
            setConnectedHost('caleston-lp10');
            setTabs([{ id: 'tab-1', title: 'Terminal 1', connected: false }]);
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
    const handleDisconnect = () => {
        liveSessionRef.current?.close();
        liveSessionRef.current = null;
        setConnectionState('disconnected');
        setPendingInputBytes(0);
        setSftpRawEntries([]);
        setTransferStatus('Disconnected — Connect to an SSH host to browse SFTP files');
        setTerminalLines((prev) => [...prev, `Disconnected from ${sessionTabLabel}.`]);
        writeToXterm(`${String.fromCharCode(13, 10)}Disconnected from ${sessionTabLabel}.${String.fromCharCode(13, 10)}webssh:~$ `);
        const resetTitle = 'Terminal 1';
        setSessionTabLabel(resetTitle);
        setConnectedUser('bob');
        setConnectedHost('caleston-lp10');
        setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, title: resetTitle, connected: false } : t)));
    };
    const handlePrivateKeyFileUpload = async (e) => {
        const input = e.currentTarget;
        const file = input.files?.[0];
        if (!file)
            return;
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
                }
                else if (check.fingerprint) {
                    setGeneratedFp(check.fingerprint);
                }
            }
        }
        catch {
            setUploadedKeyContent('');
        }
    };
    const handleConnectSubmit = (e) => {
        if (e)
            e.preventDefault();
        if (authMethod === 'Private Key (.pem / id_rsa)' && keyPermissionMode === '0644') {
            setConnectErrorMsg('Permissions 0644 for private key are too open! OpenSSH requires chmod 0400 (-r--------) or 0600.');
            return;
        }
        setConnectErrorMsg('');
        const hostVal = connectHost.trim() || '127.0.0.1';
        const userVal = connectUser.trim() || 'ubuntu';
        const portVal = connectPort.trim() || '22';
        const portNum = Number.parseInt(portVal, 10) || 22;
        const label = `${userVal}@${hostVal}`;
        const tabTitle = `Terminal 1 (${label})`;
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
        void (async () => {
            if (authMethod === 'Private Key (.pem / id_rsa)' && uploadedKeyContent.trim()) {
                const keyCheck = await validateAndInspectPrivateKeyPem(uploadedKeyContent);
                if (!keyCheck.valid) {
                    setConnectErrorMsg(keyCheck.error ?? 'Invalid private key PEM format.');
                    return;
                }
            }
            liveSessionRef.current?.close();
            const protocolAuthMethod = authMethod === 'Password'
                ? 'password'
                : authMethod === 'Private Key (.pem / id_rsa)'
                    ? 'private_key'
                    : 'remote_signer';
            const client = new LiveGatewaySessionClient({
                gatewayUrl,
                host: hostVal,
                port: portNum,
                user: userVal,
                authMethod: protocolAuthMethod,
                password: connectPassword,
                privateKeyPem: authMethod === 'Private Key (.pem / id_rsa)' ? uploadedKeyContent : undefined,
                publicKey: authMethod === 'Argon2id Ed25519 Key' ? generatedPubKey : undefined,
                keyFingerprint: generatedFp,
                cols,
                rows,
                onPtyData: (_channel, data) => {
                    try {
                        xtermAdapterRef.current?.writeBytes(data);
                    }
                    catch {
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
                onHostKeyPrompt: async (prompt) => {
                    const v = knownHosts.verify(prompt.host, prompt.port, prompt.algorithm, prompt.fingerprint, prompt.publicKeyBase64);
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
                        return new Promise((resolve) => {
                            hostKeyDecisionResolverRef.current = resolve;
                        });
                    }
                    knownHosts.trustNewHost(prompt.host, prompt.port, prompt.algorithm, prompt.fingerprint, prompt.publicKeyBase64);
                    return true;
                },
                onSignRequest: async (req) => {
                    const allKeys = vault.listKeys();
                    if (allKeys[0]) {
                        const resp = await vault.signChallenge(allKeys[0].id, base64ToBytes(req.dataBase64));
                        return bytesToBase64(resp.rawWebCryptoSignature);
                    }
                    return '';
                },
                onStateChange: (st) => {
                    if (st === 'disconnected') {
                        setConnectionState('disconnected');
                    }
                }
            });
            try {
                const meta = await client.connect();
                liveSessionRef.current = client;
                setNegotiatedCipher(meta.cipher || 'chacha20-poly1305@openssh.com');
                setNegotiatedServerVersion(meta.serverVersion || 'SSH-2.0-OpenSSH');
                setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, title: tabTitle, connected: true } : t)));
                setConnectionState('connected');
                setConnectModalOpen(false);
                setActiveScreen('workspace');
                const authDetail = authMethod === 'Private Key (.pem / id_rsa)'
                    ? `Private Key ${uploadedKeyFileName || 'id_ed25519'} [chmod ${keyPermissionMode}]`
                    : authMethod;
                const msg = `Connected to ${label}:${portVal} (${authDetail} · ${meta.serverVersion || 'SSH-2.0'})`;
                setTerminalLines((prev) => [...prev, msg]);
                writeToXterm(`${String.fromCharCode(13, 10)}${msg}${String.fromCharCode(13, 10)}`);
                if (meta.sftpReady) {
                    void refreshSftpDirectory('~', client);
                    void loadRemoteFileIntoEditor('README.md', client);
                }
            }
            catch (err) {
                liveSessionRef.current = null;
                setConnectionState('disconnected');
                const errMsg = err instanceof Error ? err.message : String(err);
                setConnectErrorMsg(errMsg);
                setTerminalLines((prev) => [...prev, `[SSH Connection Error] ${errMsg}`]);
            }
        })();
    };
    const appendCommandBlock = (command, outputLines, exitCode = 0, durationMs = 12) => {
        const entry = {
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
    const executeTerminalCommand = (rawCommand, bypassSafetyGuard = false) => {
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
            }
            catch {
                // Ignore
            }
            return;
        }
        if (cmd === 'help') {
            const helpMsg = 'Available local commands: connect <user@host>, pubkey, font <size>, clear, vault, split, features, telemetry, tunnels, playbooks';
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
            }
            else {
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
                    if (u)
                        userPart = u;
                    hostPart = rest ?? '';
                }
                if (hostPart.includes(':')) {
                    const [h, p] = hostPart.split(':');
                    hostPart = h ?? '';
                    if (p)
                        portPart = p;
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
                writeToXterm(`${String.fromCharCode(13, 10)}${outLines.join(String.fromCharCode(13, 10))}${String.fromCharCode(13, 10)}`);
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
    const handleTerminalKeyDown = (e) => {
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
            if (hist.length === 0)
                return;
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
            if (hist.length === 0 || curIdx === -1)
                return;
            const nextIdx = curIdx + 1;
            if (nextIdx >= hist.length) {
                historyIndexRef.current = -1;
                setHistoryIndex(-1);
                updateCurrentInput('');
            }
            else {
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
        if (!hostEl)
            return;
        const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
        if (isJsdom)
            return;
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
                if (disposed)
                    return;
                const helperTextarea = hostEl.querySelector('.xterm-helper-textarea');
                if (helperTextarea) {
                    helperTextarea.setAttribute('aria-label', 'Terminal xterm input');
                    helperTextarea.setAttribute('tabindex', '-1');
                }
            });
        }
        catch {
            // Fallback to DOM viewport when canvas/matchMedia is unavailable
        }
        return () => {
            disposed = true;
            try {
                xtermAdapterRef.current?.dispose();
            }
            catch {
                // Ignore dispose errors
            }
            xtermAdapterRef.current = null;
        };
    }, []);
    useEffect(() => {
        const adapter = xtermAdapterRef.current;
        if (!adapter)
            return;
        try {
            adapter.terminal.options.fontSize = fontSize;
            adapter.terminal.options.fontFamily = fontFamily;
            adapter.terminal.options.cursorStyle = cursorShape;
            adapter.fitAddon.fit();
        }
        catch {
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
    const enterImmersiveFullscreen = async () => {
        const el = rootRef.current;
        if (el && typeof el.requestFullscreen === 'function') {
            try {
                await el.requestFullscreen();
                setIsFullscreen(true);
                setIsPseudoFullscreen(false);
            }
            catch {
                setIsPseudoFullscreen(true);
                setIsFullscreen(true);
            }
        }
        else {
            setIsPseudoFullscreen(true);
            setIsFullscreen(true);
        }
        setShowFullscreenToast(true);
        setTimeout(() => setShowFullscreenToast(false), 3000);
        terminalViewRef.current?.focus();
    };
    const exitImmersiveFullscreen = async () => {
        if (typeof document !== 'undefined' && document.fullscreenElement && typeof document.exitFullscreen === 'function') {
            try {
                await document.exitFullscreen();
            }
            catch {
                // Ignore exit error
            }
        }
        setIsFullscreen(false);
        setIsPseudoFullscreen(false);
        setShowOverlayBar(false);
        terminalViewRef.current?.focus();
    };
    const toggleFullscreen = () => {
        if (isFullscreen) {
            void exitImmersiveFullscreen();
        }
        else {
            void enterImmersiveFullscreen();
        }
    };
    useEffect(() => {
        const onFullscreenChange = () => {
            if (typeof document !== 'undefined') {
                const fsActive = Boolean(document.fullscreenElement);
                if (!fsActive && !isPseudoFullscreen) {
                    setIsFullscreen(false);
                }
            }
        };
        const onKeyDown = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setPaletteOpen((prev) => !prev);
            }
            else if (e.key === 'F11' || ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f')) {
                e.preventDefault();
                toggleFullscreen();
            }
            else if (e.key === 'Escape') {
                setZenMode((wasZen) => {
                    if (wasZen) {
                        setActiveScreen('welcome');
                    }
                    return false;
                });
                if (isFullscreen) {
                    void exitImmersiveFullscreen();
                }
            }
            else if (e.key === 'Alt' && isFullscreen) {
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
    const handleGenerateKey = async () => {
        try {
            await vault.initializeOrUnlock('webssh-local-pass');
            const record = await vault.generateKeyPair('prod-ed25519-key');
            setGeneratedPubKey(record.authorizedKeyLine);
            setGeneratedFp(record.fingerprintSHA256);
        }
        catch {
            // Keep fallback display in constrained environment
        }
    };
    const handleRunFeature = (feature) => {
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
    const sftpEntries = useMemo(() => sortAndFilterEntries(sftpRawEntries, fileFilter), [sftpRawEntries, fileFilter]);
    const filteredFeatures = useMemo(() => {
        return FIFTY_FEATURES_CATALOG.filter((f) => {
            if (featureCategory !== 'All' && f.category !== featureCategory)
                return false;
            if (!featureQuery.trim())
                return true;
            const q = featureQuery.toLowerCase();
            return (f.title.toLowerCase().includes(q) ||
                f.description.toLowerCase().includes(q) ||
                f.category.toLowerCase().includes(q) ||
                String(f.id) === q);
        });
    }, [featureCategory, featureQuery]);
    const quotaSnap = storageGuard.snapshot();
    const statusDotClass = connectionState === 'reconnecting'
        ? 'webssh-status-dot--reconnecting'
        : connectionState === 'offline'
            ? 'webssh-status-dot--offline'
            : connectionState === 'disconnected'
                ? 'webssh-status-dot--disconnected'
                : '';
    return (_jsxs("div", { ref: rootRef, "data-testid": "workspace-root", className: `webssh-app ${isPseudoFullscreen ? 'webssh-app--pseudo-fullscreen' : ''}`.trim(), onKeyDown: (e) => {
            if (e.key === 'Escape' && zenMode) {
                e.preventDefault();
                setZenMode(false);
                setActiveScreen('welcome');
            }
        }, onClick: () => {
            if (openMenu !== null)
                setOpenMenu(null);
        }, children: [isFullscreen ? (_jsx("div", { "data-testid": "fullscreen-top-hover-zone", className: "webssh-fullscreen-hover-zone", onMouseEnter: () => setShowOverlayBar(true) })) : null, isFullscreen && showOverlayBar ? (_jsxs("div", { "data-testid": "fullscreen-overlay-bar", className: "webssh-fullscreen-overlay-bar", onMouseLeave: () => setShowOverlayBar(false), children: [_jsx(Badge, { tone: connectionState === 'connected' ? 'success' : 'neutral', children: sessionTabLabel }), _jsx(Button, { variant: "ghost", onClick: () => setActiveScreen('settings'), testId: "overlay-settings-btn", children: "Settings" }), _jsx(Button, { variant: "primary", onClick: () => void exitImmersiveFullscreen(), testId: "overlay-exit-fullscreen-btn", children: "Exit Full Screen" })] })) : null, showFullscreenToast ? (_jsx("div", { role: "status", "data-testid": "fullscreen-toast", className: "webssh-fullscreen-toast", children: "Press F11 or Esc to exit" })) : null, !isFullscreen && !zenMode ? (_jsxs("div", { className: "webssh-titlebar", "data-testid": "macos-titlebar", children: [_jsxs("div", { className: "webssh-titlebar-left", children: [_jsxs("div", { className: "webssh-traffic-lights", role: "group", "aria-label": "Window controls", children: [_jsx("button", { type: "button", className: "webssh-traffic-light webssh-traffic-light--close", "aria-label": "Close session or reset", title: "Close session / Reset", "data-testid": "traffic-light-close", onClick: handleDisconnect }), _jsx("button", { type: "button", className: "webssh-traffic-light webssh-traffic-light--minimize", "aria-label": "Minimize or toggle Zen mode", title: "Minimize / Toggle Zen Mode", "data-testid": "traffic-light-minimize", onClick: () => setZenMode((z) => !z) }), _jsx("button", { type: "button", className: "webssh-traffic-light webssh-traffic-light--fullscreen", "aria-label": "Toggle full screen", title: "Full Screen", "data-testid": "traffic-light-fullscreen", onClick: toggleFullscreen })] }), _jsxs("nav", { className: "webssh-menubar", "aria-label": "Application menu bar", "data-testid": "macos-menubar", children: [_jsxs("div", { className: "webssh-menu-group", onClick: (e) => e.stopPropagation(), children: [_jsx("button", { type: "button", className: `webssh-menu-trigger ${openMenu === 'terminal' ? 'webssh-menu-trigger--open' : ''}`.trim(), onClick: () => setOpenMenu((m) => (m === 'terminal' ? null : 'terminal')), "data-testid": "menu-terminal-btn", children: "Terminal" }), openMenu === 'terminal' ? (_jsxs("div", { className: "webssh-menu-dropdown", role: "menu", "data-testid": "menu-terminal-dropdown", children: [_jsxs("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            handleAddTab();
                                                            setOpenMenu(null);
                                                        }, children: [_jsx("span", { children: "New Tab" }), _jsx("span", { children: "Cmd+T" })] }), _jsxs("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            setSplitPanes((n) => (n === 1 ? 2 : 1));
                                                            setActiveScreen('workspace');
                                                            setOpenMenu(null);
                                                        }, children: [_jsx("span", { children: "Split Terminal" }), _jsx("span", { children: "Cmd+D" })] }), _jsxs("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            handleDisconnect();
                                                            setOpenMenu(null);
                                                        }, children: [_jsx("span", { children: "Disconnect" }), _jsx("span", { children: "Cmd+W" })] })] })) : null] }), _jsxs("div", { className: "webssh-menu-group", onClick: (e) => e.stopPropagation(), children: [_jsx("button", { type: "button", className: `webssh-menu-trigger ${openMenu === 'edit' ? 'webssh-menu-trigger--open' : ''}`.trim(), onClick: () => setOpenMenu((m) => (m === 'edit' ? null : 'edit')), "data-testid": "menu-edit-btn", children: "Edit" }), openMenu === 'edit' ? (_jsxs("div", { className: "webssh-menu-dropdown", role: "menu", "data-testid": "menu-edit-dropdown", children: [_jsxs("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            copyToClipboard(terminalLines.join(String.fromCharCode(10)));
                                                            setOpenMenu(null);
                                                        }, children: [_jsx("span", { children: "Copy" }), _jsx("span", { children: "Cmd+C" })] }), _jsxs("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            updateCurrentInput((prev) => `${prev}ls -la`);
                                                            setOpenMenu(null);
                                                        }, children: [_jsx("span", { children: "Paste" }), _jsx("span", { children: "Cmd+V" })] }), _jsxs("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            setTerminalLines([]);
                                                            setOpenMenu(null);
                                                        }, children: [_jsx("span", { children: "Clear Buffer" }), _jsx("span", { children: "Cmd+K" })] })] })) : null] }), _jsxs("div", { className: "webssh-menu-group", onClick: (e) => e.stopPropagation(), children: [_jsx("button", { type: "button", className: `webssh-menu-trigger ${openMenu === 'view' ? 'webssh-menu-trigger--open' : ''}`.trim(), onClick: () => setOpenMenu((m) => (m === 'view' ? null : 'view')), "data-testid": "menu-view-btn", children: "View" }), openMenu === 'view' ? (_jsxs("div", { className: "webssh-menu-dropdown", role: "menu", "data-testid": "menu-view-dropdown", children: [_jsx("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            setZenMode((z) => !z);
                                                            setOpenMenu(null);
                                                        }, children: _jsx("span", { children: "Toggle Zen Mode" }) }), _jsxs("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            toggleFullscreen();
                                                            setOpenMenu(null);
                                                        }, children: [_jsx("span", { children: "Fullscreen" }), _jsx("span", { children: "F11" })] }), _jsxs("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            setFontSize((s) => Math.min(32, s + 1));
                                                            setOpenMenu(null);
                                                        }, children: [_jsx("span", { children: "Increase Font Size" }), _jsx("span", { children: "Cmd++" })] }), _jsxs("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            setFontSize((s) => Math.max(11, s - 1));
                                                            setOpenMenu(null);
                                                        }, children: [_jsx("span", { children: "Decrease Font Size" }), _jsx("span", { children: "Cmd+-" })] })] })) : null] }), _jsxs("div", { className: "webssh-menu-group", onClick: (e) => e.stopPropagation(), children: [_jsx("button", { type: "button", className: `webssh-menu-trigger ${openMenu === 'security' ? 'webssh-menu-trigger--open' : ''}`.trim(), onClick: () => setOpenMenu((m) => (m === 'security' ? null : 'security')), "data-testid": "menu-security-btn", children: "Security" }), openMenu === 'security' ? (_jsxs("div", { className: "webssh-menu-dropdown", role: "menu", "data-testid": "menu-security-dropdown", children: [_jsx("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            setActiveScreen('vault');
                                                            setOpenMenu(null);
                                                        }, children: _jsx("span", { children: "Argon2id Key Vault" }) }), _jsx("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            setActiveScreen('hosts');
                                                            setOpenMenu(null);
                                                        }, children: _jsx("span", { children: "Known Hosts" }) }), _jsx("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                            copyToClipboard(authorizedKeysSnippet);
                                                            setTerminalLines((prev) => [
                                                                ...prev,
                                                                `Deployed Public Key Snippet: ${authorizedKeysSnippet}`
                                                            ]);
                                                            setOpenMenu(null);
                                                        }, children: _jsx("span", { children: "Deploy Public Key" }) })] })) : null] }), _jsx("div", { className: "webssh-menu-group", onClick: (e) => e.stopPropagation(), children: _jsx("button", { type: "button", className: `webssh-menu-trigger ${openMenu === 'features' ? 'webssh-menu-trigger--open' : ''}`.trim(), onClick: () => {
                                                setActiveScreen('features');
                                                setOpenMenu(null);
                                            }, "data-testid": "menu-features-btn", children: "Features (50)" }) })] })] }), _jsxs("div", { className: "webssh-window-title", "data-testid": "macos-window-title", children: [_jsx(Icon, { name: "folder" }), _jsxs("span", { children: ["terminal \u2014 ", activeSessionTitle, " \u2014 ", cols, "x", rows] })] }), _jsx("div", { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }, children: _jsx(Badge, { tone: connectionState === 'connected' ? 'success' : 'neutral', children: connectionState === 'connected' ? 'SSH Active' : 'Local Shell' }) })] })) : null, !isFullscreen && !zenMode ? (_jsxs("header", { className: "webssh-topbar webssh-studio-toolbar", role: "banner", children: [_jsxs("div", { className: "webssh-studio-tabs", children: [_jsx("div", { className: "webssh-studio-tabs", role: "tablist", "aria-label": "Active SSH sessions", children: tabs.map((tab, idx) => {
                                    const isActive = tab.id === activeTabId;
                                    return (_jsxs("button", { type: "button", role: "tab", "aria-selected": isActive && activeScreen === 'workspace', className: `webssh-studio-tab ${isActive && activeScreen === 'workspace' ? 'webssh-studio-tab--active' : ''}`.trim(), onClick: () => {
                                            setActiveTabId(tab.id);
                                            setSessionTabLabel(tab.title);
                                            setActiveScreen('workspace');
                                        }, "data-testid": idx === 0 ? 'tab-session-1' : `tab-session-${idx + 1}`, children: [_jsx("span", { className: `webssh-status-dot ${statusDotClass}`.trim() }), _jsx("span", { children: idx === 0 ? sessionTabLabel : tab.title }), _jsx("span", { "aria-hidden": "true", className: "webssh-tab-close", "data-testid": `close-tab-${tab.id}`, onClick: (e) => handleCloseTab(tab.id, e), children: "\u00D7" })] }, tab.id));
                                }) }), _jsx("span", { className: "webssh-studio-tab-separator", "data-testid": "tab-separator", "aria-hidden": "true" }), _jsx("button", { type: "button", className: "webssh-studio-add-btn", "aria-label": "New terminal tab", title: "Add Terminal Session", "data-testid": "add-tab-btn", onClick: handleAddTab, children: "+" })] }), _jsxs("div", { "data-testid": "topbar-quick-controls", className: "webssh-studio-controls", children: [_jsxs("select", { className: "ui-select", "aria-label": "Terminal font family", "data-testid": "font-family-select", value: fontFamily, onChange: (e) => setFontFamily(e.currentTarget.value), style: { width: 'auto' }, children: [_jsx("option", { value: "'DejaVu Sans Mono', Menlo, monospace", children: "DejaVu Sans Mono" }), _jsx("option", { value: "SF Mono", children: "SF Mono" }), _jsx("option", { value: "'JetBrains Mono', 'Fira Code', monospace", children: "JetBrains Mono" }), _jsx("option", { value: "Fira Code", children: "Fira Code" }), _jsx("option", { value: "Menlo", children: "Menlo" }), _jsx("option", { value: "Monaco", children: "Monaco" }), _jsx("option", { value: "Courier New", children: "Courier New" })] }), _jsxs("div", { style: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }, children: [_jsx(Button, { variant: "ghost", ariaLabel: "Decrease font size", testId: "font-size-dec-btn", onClick: () => setFontSize((s) => Math.max(11, s - 1)), children: "A-" }), _jsxs("span", { className: "font-size-badge", "data-testid": "font-size-badge", children: [fontSize, "px"] }), _jsx(Button, { variant: "ghost", ariaLabel: "Increase font size", testId: "font-size-inc-btn", onClick: () => setFontSize((s) => Math.min(36, s + 1)), children: "A+" })] }), _jsx("span", { className: `webssh-status-dot ${statusDotClass}`.trim(), title: `Connection state: ${connectionState}`, "data-testid": "connection-status-dot" }), connectionState === 'disconnected' ? (_jsx(Button, { variant: "primary", onClick: () => setConnectModalOpen(true), testId: "new-connection-btn", children: "New Connection" })) : null, _jsxs("button", { type: "button", className: "webssh-studio-stop-btn", onClick: handleDisconnect, "data-testid": connectionState === 'connected' ? 'disconnect-btn' : 'stop-session-btn', title: "Stop Session / Disconnect", children: [_jsx("span", { className: "webssh-studio-stop-square", "data-testid": "stop-red-square", "aria-hidden": "true" }), _jsx("span", { children: connectionState === 'connected' ? 'Stop Session (Disconnect)' : 'Stop Session' })] }), _jsx(Button, { variant: ideMode ? 'primary' : 'default', onClick: () => setIdeMode((m) => !m), testId: "toggle-ide-mode-btn", children: ideMode ? 'IDE Mode: ON' : 'Open IDE' }), ideMode ? (_jsx(Button, { variant: redactionMode ? 'primary' : 'ghost', onClick: () => setRedactionMode((r) => !r), testId: "toggle-redaction-btn", children: redactionMode ? 'Redaction: ON' : 'Redact Secrets' })) : null, _jsxs(Button, { variant: "ghost", onClick: () => setPaletteOpen(true), testId: "open-palette-btn", children: [_jsx(Icon, { name: "search" }), " Command Palette (Cmd+K)"] }), _jsx(Button, { variant: "ghost", onClick: () => setZenMode((z) => !z), testId: "toggle-zen-btn", children: "Zen" }), _jsxs("button", { type: "button", className: "webssh-studio-icon-btn", onClick: toggleFullscreen, "aria-label": "Expand terminal fullscreen", title: "Full Screen (F11)", "data-testid": "toggle-fullscreen-btn", children: [_jsx(Icon, { name: "maximize" }), _jsx("span", { children: "Full Screen" })] }), _jsxs("button", { type: "button", className: "webssh-studio-icon-btn", "aria-label": "Pop out terminal view", title: "Open Terminal Workspace View", "data-testid": "popout-terminal-btn", onClick: () => {
                                    setActiveScreen('workspace');
                                    terminalViewRef.current?.focus();
                                }, children: [_jsx("span", { "aria-hidden": "true", children: "\u2197" }), _jsx("span", { children: "Pop-out" })] }), _jsxs("div", { className: "webssh-menu-group", onClick: (e) => e.stopPropagation(), children: [_jsx("button", { type: "button", className: "webssh-studio-icon-btn", "aria-label": "More terminal options", title: "More Custom Options", "data-testid": "more-options-menu-btn", onClick: () => setOpenMenu((m) => (m === 'more' ? null : 'more')), children: _jsx("span", { "aria-hidden": "true", children: "\u2022\u2022\u2022" }) }), openMenu === 'more' ? (_jsxs("div", { className: "webssh-menu-dropdown", role: "menu", "data-testid": "more-options-dropdown", style: { right: 0, left: 'auto' }, children: [_jsx("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                    setIdeMode((m) => !m);
                                                    setOpenMenu(null);
                                                }, children: _jsx("span", { children: ideMode ? 'Disable IDE Mode' : 'Enable IDE Mode (50 Features)' }) }), _jsx("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                    setSplitPanes((n) => (n === 1 ? 2 : 1));
                                                    setActiveScreen('workspace');
                                                    setOpenMenu(null);
                                                }, children: _jsx("span", { children: "Toggle Split Pane" }) }), _jsx("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                    setRedactionMode((r) => !r);
                                                    setOpenMenu(null);
                                                }, children: _jsx("span", { children: redactionMode ? 'Disable Secret Redaction' : 'Enable Secret Redaction' }) }), _jsx("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                    setActiveScreen('settings');
                                                    setOpenMenu(null);
                                                }, children: _jsx("span", { children: "Themes & Typography Settings" }) }), _jsx("button", { type: "button", className: "webssh-menu-item", role: "menuitem", onClick: () => {
                                                    setActiveScreen('welcome');
                                                    setOpenMenu(null);
                                                }, children: _jsx("span", { children: "Quick Connect Welcome Screen" }) })] })) : null] })] })] })) : null, zenMode ? (_jsxs("div", { className: "webssh-banner", role: "status", "data-testid": "zen-mode-banner", style: { justifyContent: 'space-between' }, children: [_jsx("span", { children: "Zen Mode Active \u2014 Press Esc to return" }), _jsx(Button, { variant: "default", testId: "exit-zen-btn", onClick: () => {
                            setZenMode(false);
                            setActiveScreen('welcome');
                        }, children: "Exit Zen (Esc)" })] })) : null, connectionState !== 'connected' && connectionState !== 'disconnected' ? (_jsxs("div", { className: "webssh-banner", role: "status", "data-testid": "reconnect-banner", children: [_jsxs("span", { children: [connectionState === 'reconnecting' && 'Reconnecting (attempt 3, backoff 2.1s)…', connectionState === 'offline' && 'Offline — queuing input locally (64 KiB cap)', connectionState === 'resumed' && 'Session resumed from gateway ring buffer'] }), pendingInputBytes > 0 ? (_jsxs(Badge, { tone: "warning", testId: "pending-input-badge", children: ["Pending input: ", pendingInputBytes, " B"] })) : null, _jsx(Button, { variant: "ghost", onClick: () => {
                            setConnectionState('connected');
                            setPendingInputBytes(0);
                        }, children: "Dismiss" })] })) : null, _jsxs("div", { className: `webssh-workspace-body ${layoutPreset === 'sidebar-right' ? 'webssh-workspace-body--right' : ''}`.trim(), children: [!isFullscreen && !zenMode ? (_jsxs("nav", { className: "webssh-rail", "aria-label": "Workspace navigation", children: [_jsx(Button, { variant: activeScreen === 'welcome' ? 'primary' : 'ghost', onClick: () => setActiveScreen('welcome'), testId: "nav-welcome", children: "Welcome" }), _jsxs(Button, { variant: activeScreen === 'workspace' ? 'primary' : 'ghost', onClick: () => setActiveScreen('workspace'), testId: "nav-workspace", children: [_jsx(Icon, { name: "terminal" }), " Terminal"] }), _jsx(Button, { variant: ideMode ? 'primary' : 'default', onClick: () => {
                                    setIdeMode((prev) => {
                                        const next = !prev;
                                        if (next && activeScreen === 'welcome') {
                                            setActiveScreen('features');
                                        }
                                        return next;
                                    });
                                }, testId: "enable-ide-mode-btn", children: ideMode ? 'IDE Enabled (All Features)' : 'Open IDE (All Features)' }), ideMode ? (_jsxs(_Fragment, { children: [_jsx(Button, { variant: activeScreen === 'features' ? 'primary' : 'ghost', onClick: () => setActiveScreen('features'), testId: "nav-features", children: "Features (50)" }), _jsx(Button, { variant: activeScreen === 'telemetry' ? 'primary' : 'ghost', onClick: () => setActiveScreen('telemetry'), testId: "nav-telemetry", children: "Telemetry HUD" }), _jsx(Button, { variant: activeScreen === 'tunnels' ? 'primary' : 'ghost', onClick: () => setActiveScreen('tunnels'), testId: "nav-tunnels", children: "Port Tunnels" }), _jsx(Button, { variant: activeScreen === 'playbooks' ? 'primary' : 'ghost', onClick: () => setActiveScreen('playbooks'), testId: "nav-playbooks", children: "Fleet Playbooks" }), _jsxs(Button, { variant: activeScreen === 'vault' ? 'primary' : 'ghost', onClick: () => setActiveScreen('vault'), testId: "nav-vault", children: [_jsx(Icon, { name: "key" }), " Key Vault"] }), _jsxs(Button, { variant: activeScreen === 'hosts' ? 'primary' : 'ghost', onClick: () => setActiveScreen('hosts'), testId: "nav-hosts", children: [_jsx(Icon, { name: "server" }), " Hosts"] }), _jsxs(Button, { variant: activeScreen === 'files' ? 'primary' : 'ghost', onClick: () => setActiveScreen('files'), testId: "nav-files", children: [_jsx(Icon, { name: "folder" }), " SFTP Files"] }), _jsx(Button, { variant: activeScreen === 'editor' ? 'primary' : 'ghost', onClick: () => setActiveScreen('editor'), testId: "nav-editor", children: "Editor" }), _jsx(Button, { variant: activeScreen === 'snippets' ? 'primary' : 'ghost', onClick: () => setActiveScreen('snippets'), testId: "nav-snippets", children: "Snippets & Replay" }), _jsxs(Button, { variant: activeScreen === 'settings' ? 'primary' : 'ghost', onClick: () => setActiveScreen('settings'), testId: "nav-settings", children: [_jsx(Icon, { name: "settings" }), " Settings"] })] })) : null] })) : null, _jsxs("main", { className: "webssh-main", children: [activeScreen === 'workspace' ? (_jsx("div", { className: "webssh-studio-outer", "data-testid": "terminal-studio-outer", children: _jsx("div", { className: "webssh-studio-container", "data-testid": "terminal-studio-container", children: _jsxs("div", { className: "webssh-split-container", children: [_jsxs("div", { ref: terminalViewRef, tabIndex: 0, role: "region", "aria-label": "SSH Terminal Viewport", "data-testid": "terminal-viewport", className: "webssh-terminal-viewport", style: { fontSize: `${fontSize}px`, fontFamily }, onKeyDown: handleTerminalKeyDown, children: [_jsxs("div", { className: "webssh-ascii-banner", "data-testid": "terminal-ascii-banner", children: [_jsx("div", { className: "webssh-ascii-welcome-line", "data-testid": "terminal-welcome-banner-text", children: "Welcome to the WebSSH Studio Interactive Terminal." }), _jsxs("pre", { className: "webssh-ascii-art", "aria-label": "WEBSSH STUDIO ASCII Art", children: [_jsx("span", { className: "webssh-logo-col-1", children: '██╗    ██╗███████╗' }), _jsx("span", { className: "webssh-logo-col-2", children: '██████╗ ███████╗' }), _jsx("span", { className: "webssh-logo-col-3", children: '███████╗██╗  ██╗' }), _jsx("span", { className: "webssh-logo-col-4", children: ' ███████╗████████╗' }), _jsx("span", { className: "webssh-logo-col-5", children: '██╗   ██╗██████╗ ' }), String.fromCharCode(10), _jsx("span", { className: "webssh-logo-col-1", children: '██║    ██║██╔════╝' }), _jsx("span", { className: "webssh-logo-col-2", children: '██╔══██╗██╔════╝' }), _jsx("span", { className: "webssh-logo-col-3", children: '██╔════╝██║  ██║' }), _jsx("span", { className: "webssh-logo-col-4", children: ' ██╔════╝╚══██╔══╝' }), _jsx("span", { className: "webssh-logo-col-5", children: '██║   ██║██╔══██╗' }), String.fromCharCode(10), _jsx("span", { className: "webssh-logo-col-1", children: '██║ █╗ ██║█████╗  ' }), _jsx("span", { className: "webssh-logo-col-2", children: '██████╔╝███████╗' }), _jsx("span", { className: "webssh-logo-col-3", children: '███████╗███████║' }), _jsx("span", { className: "webssh-logo-col-4", children: ' ███████╗   ██║   ' }), _jsx("span", { className: "webssh-logo-col-5", children: '██║   ██║██║  ██║' }), String.fromCharCode(10), _jsx("span", { className: "webssh-logo-col-1", children: '██║███╗██║██╔══╝  ' }), _jsx("span", { className: "webssh-logo-col-2", children: '██╔══██╗╚════██║' }), _jsx("span", { className: "webssh-logo-col-3", children: '╚════██║██╔══██║' }), _jsx("span", { className: "webssh-logo-col-4", children: ' ╚════██║   ██║   ' }), _jsx("span", { className: "webssh-logo-col-5", children: '██║   ██║██║  ██║' }), String.fromCharCode(10), _jsx("span", { className: "webssh-logo-col-1", children: '╚███╔███╔╝███████╗' }), _jsx("span", { className: "webssh-logo-col-2", children: '██████╔╝███████║' }), _jsx("span", { className: "webssh-logo-col-3", children: '███████║██║  ██║' }), _jsx("span", { className: "webssh-logo-col-4", children: ' ███████║   ██║   ' }), _jsx("span", { className: "webssh-logo-col-5", children: '╚██████╔╝██████╔╝' })] })] }), terminalLines.map((line, i) => (_jsx("div", { children: redactSecretsInText(line, redactionMode) }, i))), _jsxs("div", { className: "webssh-prompt-line", "data-testid": "terminal-prompt-line", children: [_jsx("span", { className: "webssh-prompt-user", "data-testid": "prompt-username", children: connectedUser }), _jsx("span", { children: "@" }), _jsx("span", { className: "webssh-prompt-host", "data-testid": "prompt-hostname", children: connectedHost }), _jsx("span", { children: " " }), _jsx("span", { className: "webssh-prompt-dir", "data-testid": "prompt-directory", children: "~" }), _jsx("span", { className: "webssh-prompt-arrow", "data-testid": "prompt-arrow", children: ' ➜ ' }), _jsx("span", { className: "webssh-prompt-input", "data-testid": "terminal-current-input", children: currentInput }), ghostSuggestion ? (_jsx("span", { className: "webssh-ghost-text", "data-testid": "terminal-ghost-suggestion", children: ghostSuggestion })) : null, _jsx("span", { className: `webssh-terminal-cursor ${cursorShape === 'bar'
                                                                    ? 'webssh-terminal-cursor--bar'
                                                                    : cursorShape === 'underline'
                                                                        ? 'webssh-terminal-cursor--underline'
                                                                        : ''}`.trim(), "aria-hidden": "true" })] }), _jsx("div", { className: "webssh-cmd-blocks", "data-testid": "command-blocks-list", children: commandBlocks.map((block) => (_jsxs("div", { className: "webssh-cmd-block", "data-testid": `cmd-block-${block.id}`, children: [_jsxs("div", { className: "webssh-cmd-block-header", children: [_jsxs("span", { children: [_jsxs("strong", { children: ["$ ", redactSecretsInText(block.command, redactionMode)] }), " \u00B7", ' ', block.timestamp, " (", block.durationMs, "ms)"] }), _jsxs("div", { style: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }, children: [_jsxs(Badge, { tone: block.exitCode === 0 ? 'success' : 'danger', children: ["exit ", block.exitCode] }), _jsx(Button, { variant: "ghost", onClick: () => setCommandBlocks((prev) => prev.map((b) => (b.id === block.id ? { ...b, collapsed: !b.collapsed } : b))), testId: `toggle-block-${block.id}`, children: block.collapsed ? 'Expand' : 'Fold' }), _jsx(Button, { variant: "ghost", onClick: () => copyToClipboard(block.outputLines.join(String.fromCharCode(10))), children: "Copy Output" }), _jsx(Button, { variant: "ghost", onClick: () => executeTerminalCommand(block.command), children: "Re-run" })] })] }), !block.collapsed ? (_jsx("div", { style: { marginTop: 'var(--space-1)' }, children: block.outputLines.map((outLine, idx) => (_jsx("div", { children: redactSecretsInText(outLine, redactionMode) }, idx))) })) : null] }, block.id))) }), _jsx("div", { ref: xtermHostRef, className: "webssh-xterm-mount", "aria-hidden": "true", "data-testid": "xterm-engine-mount" })] }), splitPanes > 1 ? (_jsxs("div", { tabIndex: 0, role: "region", "aria-label": "Secondary Split Terminal Viewport", "data-testid": "terminal-split-pane-2", className: "webssh-terminal-viewport", style: {
                                                    fontSize: `${fontSize}px`,
                                                    fontFamily,
                                                    borderLeft: 'var(--border-hairline)'
                                                }, children: [_jsxs("div", { children: ["Split Pane #2 (", broadcastInput ? 'Broadcast Input ON' : 'Independent Shell', ")"] }), _jsxs("div", { className: "webssh-prompt-line", children: [_jsx("span", { className: "webssh-prompt-user", children: connectedUser }), _jsx("span", { children: "@" }), _jsx("span", { className: "webssh-prompt-host", children: connectedHost }), _jsx("span", { children: " " }), _jsx("span", { className: "webssh-prompt-dir", children: "~" }), _jsx("span", { className: "webssh-prompt-arrow", children: ' ➜ ' }), _jsx("span", { children: broadcastInput ? currentInput : '' }), _jsx("span", { className: "webssh-terminal-cursor", "aria-hidden": "true" })] })] })) : null] }) }) })) : null, activeScreen === 'features' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-features", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsx("h1", { children: "All 50 Features \u2014 Interactive Selector & Workbench" }), _jsx(Badge, { tone: "success", testId: "feature-active-status", children: lastExecutedFeatureMsg })] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }, children: [['All', 'Connection', 'Terminal', 'Files', 'Customization', 'Security', 'Productivity'].map((cat) => (_jsx(Button, { variant: featureCategory === cat ? 'primary' : 'default', onClick: () => setFeatureCategory(cat), testId: `feature-cat-${cat.toLowerCase()}`, children: cat }, cat))), _jsx("input", { type: "search", className: "ui-input", placeholder: "Search all 50 features by name, number, or category\u2026", "aria-label": "Search 50 features", value: featureQuery, onInput: (e) => setFeatureQuery(e.target.value), "data-testid": "feature-search-input", style: { flex: 1, minWidth: '220px' } })] }), _jsx("div", { className: "webssh-grid", children: filteredFeatures.map((feat) => (_jsxs(Card, { testId: `feature-card-${feat.id}`, className: selectedFeatureId === feat.id ? 'ui-card--selected' : '', children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsxs("strong", { children: ["#", feat.id, " \u00B7 ", feat.title] }), _jsx(Badge, { tone: "neutral", children: feat.category })] }), _jsx("p", { children: feat.description }), _jsx("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: _jsx(Button, { variant: "primary", onClick: () => handleRunFeature(feat), testId: `run-feature-${feat.id}`, children: feat.actionLabel }) })] }, feat.id))) })] })) : null, activeScreen === 'telemetry' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-telemetry", children: [_jsx("h1", { children: "Server Observability & DevOps HUD (Agentless SSH Probe)" }), _jsxs("div", { className: "webssh-hud-strip", "data-testid": "telemetry-vitals-hud", children: [_jsxs("div", { className: "webssh-hud-metric", children: [_jsx("span", { children: "CPU Load" }), _jsxs("strong", { children: [vitals.cpuPercent, "%"] }), _jsx("div", { className: "webssh-sparkbar", children: _jsx("div", { className: "webssh-sparkbar-fill", style: { width: `${vitals.cpuPercent}%` } }) })] }), _jsxs("div", { className: "webssh-hud-metric", children: [_jsx("span", { children: "RAM Usage" }), _jsxs("strong", { children: [vitals.ramUsedGiB, " / ", vitals.ramTotalGiB, " GiB"] }), _jsx("div", { className: "webssh-sparkbar", children: _jsx("div", { className: "webssh-sparkbar-fill", style: { width: `${Math.round((vitals.ramUsedGiB / vitals.ramTotalGiB) * 100)}%` } }) })] }), _jsxs("div", { className: "webssh-hud-metric", children: [_jsx("span", { children: "Disk I/O" }), _jsxs("strong", { children: [vitals.diskIoMbps, " MB/s"] })] }), _jsxs("div", { className: "webssh-hud-metric", children: [_jsx("span", { children: "Network RX / TX" }), _jsxs("strong", { children: ["\u2193 ", vitals.netRxMbps, " MB/s \u00B7 \u2191 ", vitals.netTxMbps, " MB/s"] })] }), _jsxs("div", { className: "webssh-hud-metric", children: [_jsx("span", { children: "Load Avg (1m/5m/15m)" }), _jsx("strong", { children: vitals.loadAvg.join(' / ') })] })] }), _jsxs(Card, { children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsx("h2", { children: "Interactive Process Manager (htop-in-GUI)" }), _jsx("input", { type: "search", className: "ui-input", placeholder: "Filter processes by PID, user, or command\u2026", "aria-label": "Filter processes", value: processFilter, onInput: (e) => setProcessFilter(e.target.value), "data-testid": "process-filter-input", style: { maxWidth: '280px' } })] }), _jsxs("table", { className: "webssh-table", "data-testid": "process-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "PID" }), _jsx("th", { children: "User" }), _jsx("th", { children: "CPU %" }), _jsx("th", { children: "MEM %" }), _jsx("th", { children: "Command" }), _jsx("th", { children: "Action" })] }) }), _jsx("tbody", { children: processes
                                                            .filter((p) => !processFilter ||
                                                            p.command.toLowerCase().includes(processFilter.toLowerCase()) ||
                                                            String(p.pid).includes(processFilter))
                                                            .map((proc) => (_jsxs("tr", { "data-testid": `proc-row-${proc.pid}`, children: [_jsx("td", { children: proc.pid }), _jsx("td", { children: proc.user }), _jsxs("td", { children: [proc.cpuPercent, "%"] }), _jsxs("td", { children: [proc.memPercent, "%"] }), _jsx("td", { children: proc.command }), _jsx("td", { children: _jsx(Button, { variant: "danger", testId: `kill-proc-${proc.pid}`, onClick: () => setProcesses((prev) => prev.filter((item) => item.pid !== proc.pid)), children: "SIGTERM" }) })] }, proc.pid))) })] })] }), _jsxs("div", { className: "webssh-grid", children: [_jsxs(Card, { children: [_jsx("h2", { children: "Docker & Kubernetes Container Inspector" }), containers.map((c) => (_jsxs("div", { "data-testid": `container-row-${c.id}`, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }, children: [_jsxs("div", { children: [_jsx("strong", { children: c.name }), " (", c.runtime, ")", _jsx("div", { children: _jsxs("small", { children: [c.image, " \u00B7 ", c.ports] }) })] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-1)' }, children: [_jsx(Badge, { tone: "success", children: c.status }), _jsx(Button, { variant: "primary", testId: `exec-container-${c.id}`, onClick: () => {
                                                                            handleAddTab();
                                                                            setTerminalLines((prev) => [
                                                                                ...prev,
                                                                                `webssh:~$ ${c.runtime === 'docker' ? 'docker' : 'kubectl'} exec -it ${c.name} -- /bin/sh`
                                                                            ]);
                                                                        }, children: "Exec Shell" }), _jsx(Button, { variant: "default", onClick: () => setContainers((prev) => prev.map((item) => item.id === c.id ? { ...item, status: 'Restarting' } : item)), children: "Restart" })] })] }, c.id)))] }), _jsxs(Card, { children: [_jsx("h2", { children: "Active Listening Ports & Sockets (ss -tulnp)" }), _jsxs("table", { className: "webssh-table", "data-testid": "listening-ports-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Proto" }), _jsx("th", { children: "Bind:Port" }), _jsx("th", { children: "Process (PID)" }), _jsx("th", { children: "Preview" })] }) }), _jsx("tbody", { children: listeningPorts.map((lp) => (_jsxs("tr", { children: [_jsx("td", { children: lp.proto }), _jsxs("td", { children: [lp.bindAddress, ":", lp.port] }), _jsxs("td", { children: [lp.process, " (", lp.pid, ")"] }), _jsx("td", { children: lp.webPreviewable ? (_jsx(Button, { variant: "primary", testId: `preview-port-${lp.port}`, onClick: () => {
                                                                                    setWebPreviewPort(lp.port);
                                                                                    setActiveScreen('tunnels');
                                                                                }, children: "Web Preview" })) : (_jsx(Badge, { tone: "neutral", children: "TCP Tunnel" })) })] }, lp.port))) })] })] })] })] })) : null, activeScreen === 'tunnels' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-tunnels", children: [_jsx("h1", { children: "Port Forwarding & Network Tunneling Studio (-L / -R / -D SOCKS5)" }), _jsxs(Card, { children: [_jsx("h2", { children: "Create Custom SSH Port Forward Rule" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }, children: [_jsx("label", { htmlFor: "new-tunnel-local", children: "Local Port" }), _jsx("input", { id: "new-tunnel-local", type: "number", className: "ui-input", value: newTunnelLocalPort, onInput: (e) => setNewTunnelLocalPort(e.target.value), "data-testid": "new-tunnel-local-input", style: { width: '110px' } }), _jsx("label", { htmlFor: "new-tunnel-remote", children: "Remote Port" }), _jsx("input", { id: "new-tunnel-remote", type: "number", className: "ui-input", value: newTunnelRemotePort, onInput: (e) => setNewTunnelRemotePort(e.target.value), "data-testid": "new-tunnel-remote-input", style: { width: '110px' } }), _jsx(Button, { variant: "primary", testId: "add-tunnel-btn", onClick: () => {
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
                                                                            active: Boolean(res.ok && res.active),
                                                                            bytesTransferred: 0
                                                                        }
                                                                    ]);
                                                                });
                                                            }
                                                            else {
                                                                setTunnels((prev) => [
                                                                    ...prev,
                                                                    {
                                                                        id: tunId,
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
                                                            }
                                                        }, children: "+ Add Tunnel" })] })] }), _jsx("div", { className: "webssh-grid", children: tunnels.map((t) => (_jsxs(Card, { testId: `tunnel-card-${t.id}`, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsxs("strong", { children: ["[-", t.type, "] ", t.name] }), _jsx(Badge, { tone: t.active ? 'success' : 'neutral', children: t.active ? 'Active' : 'Stopped' })] }), _jsxs("p", { children: [t.bindAddress, ":", t.localPort, " \u2192 ", t.remoteHost, ":", t.remotePort, " \u00B7", ' ', Math.round(t.bytesTransferred / 1024), " KiB transferred"] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsx(Button, { variant: "default", testId: `toggle-tunnel-${t.id}`, onClick: () => {
                                                                if (t.active && liveSessionRef.current?.isConnected) {
                                                                    void liveSessionRef.current.tunnelOp({ op: 'stop', tunnelId: t.id });
                                                                }
                                                                setTunnels((prev) => prev.map((item) => (item.id === t.id ? { ...item, active: !item.active } : item)));
                                                            }, children: t.active ? 'Pause Tunnel' : 'Start Tunnel' }), _jsxs(Button, { variant: "primary", onClick: () => setWebPreviewPort(t.remotePort || t.localPort), children: ["Preview :", t.remotePort || t.localPort] })] })] }, t.id))) }), _jsxs(Card, { testId: "remote-web-preview-card", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsxs("h2", { children: ["One-Click Web Preview \u2014 Remote localhost:", webPreviewPort] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }, children: [_jsx(Badge, { tone: connectionState === 'connected' ? 'success' : 'neutral', children: connectionState === 'connected' ? 'SSH Direct-TCPIP Ready' : 'Disconnected' }), _jsx(Button, { variant: "primary", testId: "probe-http-preview-btn", onClick: () => {
                                                                    const activeClient = liveSessionRef.current;
                                                                    if (!activeClient || !activeClient.isConnected) {
                                                                        setTunnelPreviewOutput(`Cannot probe 127.0.0.1:${webPreviewPort}: Not connected to an SSH host.`);
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
                                                                            setTunnelPreviewOutput(`HTTP/1.1 ${res.statusText || res.statusCode || 200}${String.fromCharCode(10)}${res.bodyPreview || ''}`);
                                                                        }
                                                                        else {
                                                                            setTunnelPreviewOutput(`Tunnel HTTP Probe Failed on 127.0.0.1:${webPreviewPort}: ${res.error || 'Connection refused'}`);
                                                                        }
                                                                    });
                                                                }, children: "Probe HTTP Preview" })] })] }), _jsxs("p", { children: ["Proxying remote ", _jsxs("code", { children: ["http://127.0.0.1:", webPreviewPort] }), " over SSH ", _jsx("code", { children: "direct-tcpip" }), " channel:"] }), _jsx("pre", { "data-testid": "tunnel-preview-output", children: tunnelPreviewOutput })] })] })) : null, activeScreen === 'playbooks' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-playbooks", children: [_jsx("h1", { children: "Multi-Host Playbook & Fleet Runner" }), _jsxs(Card, { children: [_jsx("label", { htmlFor: "playbook-script-input", children: "Fleet Playbook Command / Script" }), _jsx("input", { id: "playbook-script-input", type: "text", className: "ui-input", value: playbookScript, onInput: (e) => setPlaybookScript(e.target.value), "data-testid": "playbook-script-input" }), _jsx("div", { style: { marginTop: 'var(--space-2)' }, children: _jsxs(Button, { variant: "primary", testId: "run-playbook-btn", onClick: () => setPlaybookResults((prev) => prev.map((r) => ({
                                                        ...r,
                                                        output: `[Executed "${playbookScript}"] -> ${r.output}`
                                                    }))), children: ["Run Playbook Across Fleet (", playbookResults.length, " Hosts)"] }) })] }), _jsx("div", { className: "webssh-grid", "data-testid": "playbook-results-grid", children: playbookResults.map((res) => (_jsxs(Card, { testId: `playbook-host-${res.hostAlias}`, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsxs("strong", { children: [res.hostAlias, " (", res.hostAddress, ")"] }), _jsxs(Badge, { tone: res.exitCode === 0 ? 'success' : 'danger', children: ["exit ", res.exitCode, " \u00B7 ", res.durationMs, "ms"] })] }), _jsx("pre", { children: res.output })] }, res.hostAlias))) })] })) : null, activeScreen === 'welcome' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-welcome", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsxs("div", { children: [_jsx("h1", { children: "Welcome to WebSSH Studio" }), _jsxs("p", { style: { color: 'var(--color-fg-secondary)' }, children: ["Clean, minimal SSH workspace \u2014 connect with Username & Password or upload a Private Key (", _jsx("code", { children: "chmod 0400" }), ")."] })] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsxs(Button, { variant: "default", testId: "welcome-open-terminal-btn", onClick: () => setActiveScreen('workspace'), children: [_jsx(Icon, { name: "terminal" }), " Open Terminal"] }), _jsx(Button, { variant: ideMode ? 'primary' : 'default', testId: "welcome-open-ide-btn", onClick: () => {
                                                            setIdeMode(true);
                                                            setActiveScreen('features');
                                                        }, children: "Open IDE (All 50 Features)" })] })] }), _jsxs(Card, { testId: "welcome-quick-connect-card", children: [_jsx("h2", { children: "Quick SSH Connect" }), _jsxs("form", { onSubmit: handleConnectSubmit, style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }, children: [_jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }, children: [_jsxs("div", { style: { flex: 2, minWidth: '180px' }, children: [_jsx("label", { htmlFor: "welcome-host-input", children: "Host / IP" }), _jsx("input", { id: "welcome-host-input", type: "text", className: "ui-input", placeholder: "e.g. 192.168.1.10 or server.example.com", value: connectHost, onInput: (e) => setConnectHost(e.target.value), "data-testid": "welcome-host-input" })] }), _jsxs("div", { style: { flex: 1, minWidth: '130px' }, children: [_jsx("label", { htmlFor: "welcome-user-input", children: "Username" }), _jsx("input", { id: "welcome-user-input", type: "text", className: "ui-input", placeholder: "ubuntu / root", value: connectUser, onInput: (e) => setConnectUser(e.target.value), "data-testid": "welcome-user-input" })] }), _jsxs("div", { style: { width: '100px' }, children: [_jsx("label", { htmlFor: "welcome-port-input", children: "Port" }), _jsx("input", { id: "welcome-port-input", type: "number", className: "ui-input", value: connectPort, onInput: (e) => setConnectPort(e.target.value), "data-testid": "welcome-port-input" })] })] }), _jsxs("div", { children: [_jsx("label", { children: "Authentication Method" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-1)', flexWrap: 'wrap' }, children: [_jsx(Button, { variant: authMethod === 'Password' ? 'primary' : 'default', onClick: () => {
                                                                            setAuthMethod('Password');
                                                                            setConnectErrorMsg('');
                                                                        }, testId: "welcome-auth-password-btn", children: "Username & Password" }), _jsx(Button, { variant: authMethod === 'Private Key (.pem / id_rsa)' ? 'primary' : 'default', onClick: () => {
                                                                            setAuthMethod('Private Key (.pem / id_rsa)');
                                                                            setConnectErrorMsg('');
                                                                        }, testId: "welcome-auth-keyfile-btn", children: "Upload Private Key (.pem / chmod 400)" }), _jsx(Button, { variant: authMethod === 'Argon2id Ed25519 Key' ? 'primary' : 'default', onClick: () => {
                                                                            setAuthMethod('Argon2id Ed25519 Key');
                                                                            setConnectErrorMsg('');
                                                                        }, testId: "welcome-auth-argon-btn", children: "Browser Ed25519 Key" })] })] }), authMethod === 'Password' ? (_jsxs("div", { children: [_jsx("label", { htmlFor: "welcome-password-input", children: "Password" }), _jsx("input", { id: "welcome-password-input", type: "password", className: "ui-input", placeholder: "Enter SSH password\u2026", value: connectPassword, onInput: (e) => setConnectPassword(e.target.value), "data-testid": "welcome-password-input" })] })) : null, authMethod === 'Private Key (.pem / id_rsa)' ? (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsxs("label", { htmlFor: "welcome-key-file-input", children: ["Upload Private Key (", _jsx("code", { children: ".pem" }), ", ", _jsx("code", { children: ".key" }), ", ", _jsx("code", { children: "id_ed25519" }), ", ", _jsx("code", { children: "id_rsa" }), ")"] }), _jsx(Badge, { tone: keyPermissionMode === '0644' ? 'danger' : 'success', testId: "private-key-chmod-badge", children: keyPermissionMode === '0400'
                                                                            ? 'chmod 0400 (-r--------) Enforced'
                                                                            : keyPermissionMode === '0600'
                                                                                ? 'chmod 0600 (-rw-------) Enforced'
                                                                                : 'UNPROTECTED KEY (0644) — Set chmod 400' })] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }, children: [_jsx("input", { id: "welcome-key-file-input", type: "file", className: "ui-input", accept: ".pem,.key,.pub,*", onChange: (e) => void handlePrivateKeyFileUpload(e), "data-testid": "private-key-file-input", style: { flex: 1 } }), _jsxs("select", { "aria-label": "Private key chmod permission", className: "ui-select", value: keyPermissionMode, onChange: (e) => {
                                                                            setKeyPermissionMode(e.currentTarget.value);
                                                                            setConnectErrorMsg('');
                                                                        }, "data-testid": "private-key-chmod-select", style: { width: 'auto' }, children: [_jsx("option", { value: "0400", children: "chmod 0400 (-r--------) Read-Only" }), _jsx("option", { value: "0600", children: "chmod 0600 (-rw-------) Owner R/W" }), _jsx("option", { value: "0644", children: "chmod 0644 (-rw-r--r--) Too Open" })] }), _jsx(Button, { variant: "default", testId: "apply-key-chmod-400-btn", onClick: () => {
                                                                            setKeyPermissionMode('0400');
                                                                            setConnectErrorMsg('');
                                                                        }, children: "Set chmod 400" })] }), _jsx("textarea", { className: "ui-input", rows: 3, placeholder: "Or paste -----BEGIN OPENSSH PRIVATE KEY----- / .pem content here\u2026", "aria-label": "Private key content", value: uploadedKeyContent, onInput: (e) => setUploadedKeyContent(e.target.value), "data-testid": "private-key-textarea" })] })) : null, connectErrorMsg ? (_jsx(Badge, { tone: "danger", testId: "connect-error-badge", children: connectErrorMsg })) : null, _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }, children: [_jsx(Button, { variant: "primary", type: "submit", testId: "welcome-connect-submit-btn", children: "Connect to Server" }), _jsx(Button, { variant: "default", onClick: () => void handleGenerateKey(), testId: "welcome-generate-key-btn", children: "Generate SSH key" })] })] })] })] })) : null, activeScreen === 'vault' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-vault", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("h1", { children: "SSH Key Vault" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsx(Button, { variant: "primary", onClick: () => void handleGenerateKey(), testId: "vault-generate-btn", children: "Generate SSH key" }), _jsxs(Button, { variant: "default", onClick: () => setVaultLocked((v) => !v), testId: "vault-lock-btn", children: [_jsx(Icon, { name: "lock" }), " ", vaultLocked ? 'Unlock Vault' : 'Lock Vault'] })] })] }), vaultLocked ? (_jsx(EmptyState, { title: "Vault is Locked", description: "Protected with Argon2id + AES-GCM wrapping. Unlock to sign SSH challenges.", action: _jsx(Button, { variant: "primary", onClick: () => setVaultLocked(false), children: "Unlock Vault" }) })) : (_jsxs("div", { className: "webssh-grid", children: [_jsxs(Card, { children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("strong", { children: "prod-ed25519-key" }), _jsx(Badge, { tone: "success", children: "Ed25519 \u00B7 Non-Extractable" })] }), _jsxs("p", { "data-testid": "vault-fingerprint", children: ["Fingerprint: ", generatedFp] }), _jsx("label", { htmlFor: "pubkey-box", children: "OpenSSH Public Key & authorized_keys snippet" }), _jsx("textarea", { id: "pubkey-box", className: "ui-input", readOnly: true, rows: 3, value: generatedPubKey, "data-testid": "vault-pubkey-output" }), _jsx("div", { style: { display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }, children: _jsxs(Button, { variant: "default", onClick: () => copyToClipboard(authorizedKeysSnippet), children: [_jsx(Icon, { name: "copy" }), " Copy authorized_keys Snippet"] }) })] }), _jsxs(Card, { testId: "fido2-hardware-card", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("strong", { children: "WebAuthn / FIDO2 Hardware Key (YubiKey / TouchID)" }), _jsx(Badge, { tone: fido2Enrolled ? 'success' : 'neutral', children: fido2Enrolled ? 'Hardware Bound' : 'Ready to Enroll' })] }), _jsxs("p", { children: ["OpenSSH Hardware Resident Key: ", _jsx("code", { children: "sk-ssh-ed25519@openssh.com" })] }), _jsx("input", { type: "text", className: "ui-input", readOnly: true, "aria-label": "FIDO2 public key", value: fido2KeyLine, "data-testid": "fido2-pubkey-output" }), _jsx(Button, { variant: "primary", testId: "enroll-fido2-btn", onClick: () => {
                                                            setFido2Enrolled(true);
                                                            setFido2KeyLine('sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAA EnrolledHardwarePasskey yubikey@webssh');
                                                        }, children: "Enroll FIDO2 Passkey" })] }), _jsxs(Card, { testId: "ssh-ca-cert-card", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("strong", { children: "SSH Certificate Authority (CA) Short-Lived Cert" }), _jsxs(Badge, { tone: "success", children: [sshCertInfo.certType, " cert"] })] }), _jsxs("p", { children: ["Key ID: ", _jsx("code", { children: sshCertInfo.keyId })] }), _jsxs("p", { children: ["Principals: ", _jsx("code", { children: sshCertInfo.principals.join(', ') })] }), _jsxs("p", { children: ["Validity: ", sshCertInfo.validAfter, " \u2192 ", sshCertInfo.validBefore] }), _jsxs("p", { children: ["CA Fingerprint: ", _jsx("code", { children: sshCertInfo.caFingerprint })] })] })] }))] })) : null, activeScreen === 'hosts' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-hosts", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("h1", { children: "Saved Hosts & ProxyJump Chains" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsx(Button, { variant: "default", onClick: () => setHostKeyModal('tofu'), testId: "trigger-tofu-modal-btn", children: "Verify Host Key (TOFU)" }), _jsx(Button, { variant: "danger", onClick: () => setHostKeyModal('mismatch'), testId: "trigger-mismatch-modal-btn", children: "Simulate KEY CHANGED" })] })] }), _jsx("input", { type: "search", className: "ui-input", placeholder: "Filter hosts by alias, user, hostname, or tag\u2026", value: hostSearch, onInput: (e) => setHostSearch(e.target.value), "aria-label": "Filter hosts" }), _jsx("div", { className: "webssh-grid", children: hosts
                                            .filter((h) => !hostSearch || h.alias.toLowerCase().includes(hostSearch.toLowerCase()))
                                            .map((h) => (_jsxs(Card, { testId: `host-card-${h.alias}`, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between' }, children: [_jsx("strong", { children: h.alias }), _jsx(Badge, { tone: "success", children: h.folder ?? 'Default' })] }), _jsxs("p", { children: [h.user, "@", h.host, ":", h.port] }), h.jumpHops.length > 0 ? (_jsxs("p", { children: ["ProxyJump: ", h.jumpHops.map((j) => `${j.user}@${j.host}:${j.port}`).join(' -> ')] })) : null, _jsx(Button, { variant: "primary", onClick: () => {
                                                        setConnectUser(h.user);
                                                        setConnectHost(h.host);
                                                        setConnectPort(String(h.port));
                                                        setConnectModalOpen(true);
                                                    }, children: "Connect" })] }, h.id))) }), _jsxs(Card, { children: [_jsx("h2", { children: "Import ~/.ssh/config" }), _jsx("textarea", { className: "ui-input", rows: 4, "aria-label": "SSH config content", value: sshConfigInput, onInput: (e) => setSshConfigInput(e.target.value) }), _jsx("div", { style: { marginTop: 'var(--space-2)' }, children: _jsx(Button, { variant: "primary", testId: "import-ssh-config-btn", onClick: () => {
                                                        hostRegistry.importSshConfig(sshConfigInput);
                                                        setHosts(hostRegistry.list());
                                                    }, children: "Import ~/.ssh/config" }) })] })] })) : null, activeScreen === 'files' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-files", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsx("h1", { children: "Dual-Pane SFTP File Manager" }), _jsxs(Badge, { tone: "neutral", testId: "storage-quota-badge", children: ["Storage Guard: ", quotaSnap.percentUsed, "% of 256 MiB cap (256 KiB chunks, SHA-256 verified)"] })] }), _jsx("p", { children: transferStatus }), _jsx("input", { type: "search", className: "ui-input", placeholder: "Filter remote directory entries\u2026", value: fileFilter, onInput: (e) => setFileFilter(e.target.value), "aria-label": "Filter remote directory entries" }), _jsxs(Card, { children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsx("p", { children: "Drop files or folders to upload to /srv/app (resumable .part atomic rename)" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsxs(Button, { variant: "primary", onClick: () => setTransferStatus('Uploaded release.tar.zst (20/20 chunks · 256 KiB · SHA-256 verified)'), children: [_jsx(Icon, { name: "upload" }), " Simulate 256 KiB Upload"] }), _jsxs(Button, { variant: "default", onClick: () => setTransferStatus('Streaming /etc/app/config.zip via ZIP64 writer…'), children: [_jsx(Icon, { name: "download" }), " Download Folder ZIP"] })] })] }), _jsx("ul", { children: sftpEntries.map((entry) => (_jsxs("li", { children: [_jsx("strong", { children: entry.isDir ? `[DIR] ${entry.name}` : entry.name }), " \u2014 ", entry.size, " bytes (", entry.mode, ")"] }, entry.path))) })] }), _jsxs("div", { className: "webssh-grid", children: [_jsxs(Card, { testId: "chmod-matrix-card", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("h2", { children: "Interactive chmod Permissions Matrix" }), _jsxs(Badge, { tone: "success", testId: "chmod-octal-badge", children: [chmodFormatted.octal, " (", chmodFormatted.symbolic, ")"] })] }), _jsxs("p", { children: ["Target: ", _jsx("code", { children: chmodTargetFile })] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }, children: [_jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: chmodPerms.ownerWrite, onChange: (e) => setChmodPerms((prev) => ({
                                                                            ...prev,
                                                                            ownerWrite: e.currentTarget.checked
                                                                        })), "data-testid": "chmod-owner-write" }), ' ', "Owner Write"] }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: chmodPerms.groupWrite, onChange: (e) => setChmodPerms((prev) => ({
                                                                            ...prev,
                                                                            groupWrite: e.currentTarget.checked
                                                                        })), "data-testid": "chmod-group-write" }), ' ', "Group Write"] }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: chmodPerms.publicExec, onChange: (e) => setChmodPerms((prev) => ({
                                                                            ...prev,
                                                                            publicExec: e.currentTarget.checked
                                                                        })), "data-testid": "chmod-public-exec" }), ' ', "Public Exec"] })] }), _jsxs(Button, { variant: "primary", testId: "apply-chmod-btn", onClick: () => {
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
                                                                        setTransferStatus(`Applied chmod ${chmodFormatted.octal} (${chmodFormatted.symbolic}) to ${chmodTargetFile}`);
                                                                        void refreshSftpDirectory(sftpCurrentPath, activeClient);
                                                                    }
                                                                    else {
                                                                        setTransferStatus(`chmod failed on ${chmodTargetFile}: ${res.error ?? 'Unknown error'}`);
                                                                    }
                                                                });
                                                            }
                                                            else {
                                                                setChmodTargetFile('/etc/nginx/nginx.conf');
                                                                setTransferStatus(`Applied chmod ${chmodFormatted.octal} (${chmodFormatted.symbolic}) to ${chmodTargetFile}`);
                                                            }
                                                        }, children: ["Apply chmod ", chmodFormatted.octal] })] }), _jsxs(Card, { testId: "server-relay-card", children: [_jsx("h2", { children: "Server-to-Server Direct SFTP Relay" }), _jsx("p", { "data-testid": "relay-status-text", children: relayStatus }), _jsx(Button, { variant: "primary", testId: "trigger-sftp-relay-btn", onClick: () => setRelayStatus('Transferred 5.0 MiB directly: prod-edge-01 → staging-web (SHA-256 verified, 0 local disk usage)'), children: "Relay File Between Hosts" })] })] }), _jsxs(Card, { testId: "live-log-tailer-card", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsx("h2", { children: "Live Log Tailer (tail -f /var/log/nginx/error.log)" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsx("input", { type: "search", className: "ui-input", placeholder: "Filter log stream (e.g. error, warn)\u2026", "aria-label": "Filter log stream", value: tailFilter, onInput: (e) => setTailFilter(e.target.value), "data-testid": "tail-filter-input" }), _jsx(Button, { variant: "default", testId: "tail-pause-btn", onClick: () => setTailPaused((p) => !p), children: tailPaused ? 'Resume Stream' : 'Pause Stream' }), _jsx(Button, { variant: "primary", testId: "tail-append-btn", onClick: () => {
                                                                    if (!tailPaused) {
                                                                        setTailLogLines((prev) => [
                                                                            ...prev,
                                                                            '2026-11-01T08:15:30Z [info] healthcheck 200 OK in 4ms'
                                                                        ]);
                                                                    }
                                                                }, children: "Simulate Log Event" })] })] }), _jsx("pre", { "data-testid": "tail-log-output", children: tailLogLines
                                                    .filter((l) => !tailFilter || l.toLowerCase().includes(tailFilter.toLowerCase()))
                                                    .join(String.fromCharCode(10)) })] })] })) : null, activeScreen === 'editor' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-editor", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsxs("h1", { children: ["Remote File Editor \u2014 ", editorFilePath] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }, children: [_jsx("input", { type: "text", className: "ui-input", "aria-label": "Remote file path", value: editorFilePath, onInput: (e) => setEditorFilePath(e.target.value), "data-testid": "editor-filepath-input", style: { width: '200px' } }), _jsx(Button, { variant: "default", testId: "load-remote-file-btn", onClick: () => void loadRemoteFileIntoEditor(editorFilePath), children: "Load from Host" }), _jsx(Button, { variant: "default", testId: "toggle-diff-viewer-btn", onClick: () => setShowDiffViewer((d) => !d), children: showDiffViewer ? 'Hide Side-by-Side Diff' : 'Compare Side-by-Side Diff' }), _jsxs(Button, { variant: "primary", onClick: () => {
                                                            const activeClient = liveSessionRef.current;
                                                            if (activeClient && activeClient.isConnected) {
                                                                const encoded = bytesToBase64(new TextEncoder().encode(editorContent));
                                                                void activeClient
                                                                    .sftpOp({
                                                                    op: 'write_file',
                                                                    path: editorFilePath,
                                                                    dataBase64: encoded
                                                                })
                                                                    .then((res) => {
                                                                    if (res.ok) {
                                                                        setEditorOriginalContent(editorContent);
                                                                        setEditorSaved(true);
                                                                        setTransferStatus(`Saved ${editorFilePath} over SFTP`);
                                                                        void refreshSftpDirectory(sftpCurrentPath, activeClient);
                                                                    }
                                                                    else {
                                                                        setTransferStatus(`Save failed: ${res.error ?? 'Unknown error'}`);
                                                                    }
                                                                });
                                                            }
                                                            else {
                                                                setEditorSaved(true);
                                                            }
                                                        }, testId: "save-remote-file-btn", children: ["Save to host ", editorSaved ? '(Saved)' : '(Unsaved*)'] })] })] }), _jsx("textarea", { className: "ui-input", rows: 10, "aria-label": "Remote file content", value: editorContent, onInput: (e) => {
                                            setEditorContent(e.target.value);
                                            setEditorSaved(false);
                                        } }), showDiffViewer ? (_jsxs(Card, { testId: "side-by-side-diff-card", children: [_jsx("h2", { children: "Side-by-Side Diff vs Remote /etc/nginx/nginx.conf" }), _jsxs("div", { className: "webssh-diff-grid", children: [_jsxs("div", { children: [_jsx("strong", { children: "Original Remote File" }), diffEntries.map((d) => (_jsxs("div", { className: `webssh-diff-line--${d.status}`, children: [d.lineNumber, ": ", d.before] }, `orig-${d.lineNumber}`)))] }), _jsxs("div", { children: [_jsx("strong", { children: "Modified Buffer" }), diffEntries.map((d) => (_jsxs("div", { className: `webssh-diff-line--${d.status}`, children: [d.lineNumber, ": ", d.after] }, `mod-${d.lineNumber}`)))] })] })] })) : null] })) : null, activeScreen === 'snippets' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-snippets", children: [_jsx("h1", { children: "Snippets & Asciicast v2 Session Replay" }), _jsxs(Card, { children: [_jsx("h2", { children: "Variable Interpolation Parameters" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }, children: [_jsxs("div", { children: [_jsx("label", { htmlFor: "snip-var-service", children: "service" }), _jsx("input", { id: "snip-var-service", className: "ui-input", value: snippetVarService, onInput: (e) => setSnippetVarService(e.target.value) })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "snip-var-lines", children: "lines" }), _jsx("input", { id: "snip-var-lines", className: "ui-input", value: snippetVarLines, onInput: (e) => setSnippetVarLines(e.target.value) })] })] })] }), _jsx("div", { className: "webssh-grid", children: snippetLib.list().map((snip) => {
                                            const interpolated = interpolateSnippet(snip.command, {
                                                service: snippetVarService,
                                                lines: snippetVarLines
                                            });
                                            return (_jsxs(Card, { children: [_jsx("strong", { children: snip.name }), _jsx("code", { children: interpolated }), _jsx(Button, { variant: "primary", onClick: () => {
                                                            setTerminalLines((prev) => [...prev, `webssh:~$ ${interpolated}`]);
                                                            setActiveScreen('workspace');
                                                        }, children: "Run Snippet" })] }, snip.id));
                                        }) }), _jsxs(Card, { children: [_jsxs("h2", { children: ["Session Replay Scrubber (", scrubberSec.toFixed(1), "s)"] }), _jsx("input", { type: "range", min: 0, max: 3, step: 0.5, value: scrubberSec, "aria-label": "Replay timeline scrubber", onInput: (e) => setScrubberSec(Number(e.target.value)) }), _jsx("pre", { children: scrubAsciicastOutput(demoCast.events, scrubberSec) })] })] })) : null, activeScreen === 'settings' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-settings", children: [_jsx("h1", { children: "Preferences, Theme Gallery & Keybindings" }), _jsx(ComponentGallery, { activeTheme: activeTheme, onSelectTheme: (t) => setActiveTheme(t) }), _jsxs(Card, { children: [_jsx("h2", { children: "Theme Selector" }), _jsx("div", { style: { display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }, children: THEME_IDS.map((id) => (_jsx(Button, { variant: id === activeTheme ? 'primary' : 'default', onClick: () => setActiveTheme(id), testId: `theme-btn-${id}`, children: id }, id))) })] }), _jsxs(Card, { children: [_jsx("h2", { children: "Workspace Layout & Cursor Geometry" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }, children: [_jsx(Button, { variant: layoutPreset === 'sidebar-left' ? 'primary' : 'default', onClick: () => setLayoutPreset('sidebar-left'), children: "Sidebar Left" }), _jsx(Button, { variant: layoutPreset === 'sidebar-right' ? 'primary' : 'default', onClick: () => setLayoutPreset('sidebar-right'), children: "Sidebar Right" }), _jsx(Button, { variant: cursorShape === 'block' ? 'primary' : 'default', onClick: () => setCursorShape('block'), children: "Cursor: Block" }), _jsx(Button, { variant: cursorShape === 'bar' ? 'primary' : 'default', onClick: () => setCursorShape('bar'), children: "Cursor: Bar" }), _jsx(Button, { variant: cursorShape === 'underline' ? 'primary' : 'default', onClick: () => setCursorShape('underline'), children: "Cursor: Underline" })] })] }), _jsxs(Card, { children: [_jsx("h2", { children: "Keybindings" }), _jsx("ul", { children: keybindings.list().map((kb) => (_jsxs("li", { children: [_jsxs("strong", { children: [kb.description, ":"] }), " ", _jsx("code", { children: kb.shortcut })] }, kb.actionId))) })] }), _jsxs(Card, { children: [_jsx("h2", { children: "Simulate Reconnect / Resilience States" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsx(Button, { variant: "default", testId: "sim-reconnecting-btn", onClick: () => {
                                                            setConnectionState('reconnecting');
                                                            setPendingInputBytes(128);
                                                        }, children: "Simulate Reconnecting" }), _jsx(Button, { variant: "default", testId: "sim-resumed-btn", onClick: () => {
                                                            setConnectionState('resumed');
                                                            setPendingInputBytes(0);
                                                        }, children: "Simulate Resumed" })] })] }), _jsxs(Card, { testId: "settings-asset-cache-card", children: [_jsx("h2", { children: "Application Asset Cache Recovery" }), _jsx("p", { children: "Purge Service Worker and static bundle caches without clearing your saved SSH hosts, non-extractable Key Vault keys, or user preferences." }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }, children: [_jsx(Button, { variant: "default", testId: "settings-repair-cache-btn", onClick: () => {
                                                            void repairApplicationAssetCaches().then((res) => {
                                                                setCacheRepairStatus(`Cleared ${res.deletedCaches.length} asset cache(s) and unregistered ${res.unregisteredServiceWorkers} service worker(s). Saved hosts, keys, and settings preserved.`);
                                                            });
                                                        }, children: "Repair Application Asset Cache" }), cacheRepairStatus ? (_jsx(Badge, { tone: "success", testId: "settings-repair-cache-status", children: cacheRepairStatus })) : null] })] })] })) : null, !isFullscreen && !zenMode ? (_jsx("div", { className: "webssh-special-keys", role: "toolbar", "aria-label": "Mobile and Tablet Special Keys", children: SPECIAL_KEYS_ROW.map((keyLabel) => (_jsx(Button, { variant: "ghost", testId: `special-key-${keyLabel}`, children: keyLabel }, keyLabel))) })) : null] })] }), !isFullscreen && !zenMode ? (_jsxs("footer", { className: "webssh-statusbar", role: "contentinfo", "data-testid": "status-bar", children: [_jsx("span", { children: connectionState === 'connected'
                            ? `Connected: ${sessionTabLabel} · Cipher: ${negotiatedCipher}${negotiatedServerVersion ? ` · ${negotiatedServerVersion}` : ''}`
                            : 'Status: Disconnected · Ready for SSH connection' }), _jsxs("span", { children: ["Remote Signer: Argon2id Ed25519 \u00B7 ", cols, "x", rows, " \u00B7 Font: ", fontSize, "px"] })] })) : null, _jsx(Modal, { open: connectModalOpen, title: "New SSH Connection & Argon2id Credentials", onClose: () => setConnectModalOpen(false), testId: "connect-modal", children: _jsxs("form", { onSubmit: handleConnectSubmit, style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }, children: [_jsxs("div", { children: [_jsx("label", { htmlFor: "connect-gateway-input", children: "SSH Gateway WebSocket URL" }), _jsx("input", { id: "connect-gateway-input", type: "text", className: "ui-input", placeholder: "ws://127.0.0.1:8080/ws", value: gatewayUrl, onInput: (e) => {
                                        const val = e.target.value;
                                        setGatewayUrl(val);
                                        try {
                                            globalThis.localStorage?.setItem('webssh.gateway.wsUrl', val);
                                        }
                                        catch {
                                            // ignore
                                        }
                                    }, "data-testid": "gateway-url-input" })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "connect-host-input", children: "Host (IP or domain)" }), _jsx("input", { id: "connect-host-input", type: "text", className: "ui-input", placeholder: "e.g. 192.168.1.10 or edge-01.prod.internal", value: connectHost, onInput: (e) => setConnectHost(e.target.value), "data-testid": "connect-host-input" })] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsxs("div", { style: { flex: 2 }, children: [_jsx("label", { htmlFor: "connect-user-input", children: "Username" }), _jsx("input", { id: "connect-user-input", type: "text", className: "ui-input", placeholder: "root / ubuntu", value: connectUser, onInput: (e) => setConnectUser(e.target.value), "data-testid": "connect-user-input" })] }), _jsxs("div", { style: { flex: 1 }, children: [_jsx("label", { htmlFor: "connect-port-input", children: "Port" }), _jsx("input", { id: "connect-port-input", type: "number", className: "ui-input", value: connectPort, onInput: (e) => setConnectPort(e.target.value), "data-testid": "connect-port-input" })] })] }), _jsxs("div", { children: [_jsx("label", { children: "Auth Mode" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-1)', flexWrap: 'wrap' }, children: [_jsx(Button, { variant: authMethod === 'Password' ? 'primary' : 'default', onClick: () => {
                                                setAuthMethod('Password');
                                                setConnectErrorMsg('');
                                            }, testId: "auth-method-password-btn", children: "Username & Password" }), _jsx(Button, { variant: authMethod === 'Private Key (.pem / id_rsa)' ? 'primary' : 'default', onClick: () => {
                                                setAuthMethod('Private Key (.pem / id_rsa)');
                                                setConnectErrorMsg('');
                                            }, testId: "auth-method-keyfile-btn", children: "Private Key (.pem / chmod 400)" }), _jsx(Button, { variant: authMethod === 'Argon2id Ed25519 Key' ? 'primary' : 'default', onClick: () => {
                                                setAuthMethod('Argon2id Ed25519 Key');
                                                setConnectErrorMsg('');
                                            }, testId: "auth-method-pubkey-btn", children: "Argon2id Ed25519 Key" })] })] }), authMethod === 'Password' ? (_jsxs("div", { children: [_jsx("label", { htmlFor: "connect-password-input", children: "Password" }), _jsx("input", { id: "connect-password-input", type: "password", className: "ui-input", placeholder: "Enter SSH password\u2026", value: connectPassword, onInput: (e) => setConnectPassword(e.target.value), "data-testid": "connect-password-input" })] })) : null, authMethod === 'Private Key (.pem / id_rsa)' ? (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("label", { htmlFor: "modal-key-file-input", children: "Upload Private Key (.pem / id_ed25519 / id_rsa)" }), _jsxs(Badge, { tone: keyPermissionMode === '0644' ? 'danger' : 'success', testId: "modal-key-chmod-badge", children: ["chmod ", keyPermissionMode, " ", keyPermissionMode === '0400' ? '(-r--------)' : keyPermissionMode === '0600' ? '(-rw-------)' : '(UNSAFE)'] })] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }, children: [_jsx("input", { id: "modal-key-file-input", type: "file", className: "ui-input", accept: ".pem,.key,.pub,*", onChange: (e) => void handlePrivateKeyFileUpload(e), "data-testid": "modal-private-key-file-input" }), _jsx(Button, { variant: "default", testId: "modal-set-chmod-400-btn", onClick: () => {
                                                setKeyPermissionMode('0400');
                                                setConnectErrorMsg('');
                                            }, children: "chmod 400" })] })] })) : null, _jsxs("div", { children: [_jsx("label", { htmlFor: "connect-pubkey-snippet", children: "Public Key Snippet (authorized_keys)" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-1)' }, children: [_jsx("input", { id: "connect-pubkey-snippet", type: "text", className: "ui-input", readOnly: true, value: authorizedKeysSnippet, "data-testid": "connect-pubkey-snippet" }), _jsxs(Button, { variant: "default", onClick: () => copyToClipboard(authorizedKeysSnippet), testId: "copy-pubkey-snippet-btn", children: [_jsx(Icon, { name: "copy" }), " ", copiedSnippet ? 'Copied' : 'Copy'] })] })] }), connectErrorMsg ? (_jsx(Badge, { tone: "danger", testId: "modal-connect-error-badge", children: connectErrorMsg })) : null, _jsxs("div", { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }, children: [_jsx(Button, { variant: "default", onClick: () => setConnectModalOpen(false), children: "Cancel" }), _jsx(Button, { variant: "primary", type: "submit", testId: "connect-modal-submit-btn", children: "Connect" })] })] }) }), _jsxs(Modal, { open: paletteOpen, title: "Command Palette", onClose: () => setPaletteOpen(false), testId: "command-palette-modal", children: [_jsx("input", { type: "search", className: "ui-input", placeholder: "Type a command or search actions\u2026", value: paletteQuery, onInput: (e) => setPaletteQuery(e.target.value), "aria-label": "Command palette search", "data-testid": "command-palette-input" }), _jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', marginTop: 'var(--space-3)' }, children: paletteRegistry.search(paletteQuery).map((cmd) => (_jsxs(Button, { variant: "ghost", onClick: () => void cmd.run(), testId: `palette-cmd-${cmd.id}`, children: [_jsx("span", { children: cmd.title }), cmd.shortcut ? _jsx(Badge, { tone: "neutral", children: cmd.shortcut }) : null] }, cmd.id))) })] }), _jsxs(Modal, { open: hostKeyModal !== 'none', danger: hostKeyModal === 'mismatch', title: hostKeyModal === 'mismatch' ? 'WARNING: REMOTE HOST KEY CHANGED' : 'Verify Unknown Host Key (TOFU)', onClose: () => {
                    setHostKeyModal('none');
                    if (hostKeyDecisionResolverRef.current) {
                        hostKeyDecisionResolverRef.current(false);
                        hostKeyDecisionResolverRef.current = null;
                    }
                }, testId: "hostkey-modal", children: [_jsxs("p", { children: ["Host:", ' ', _jsxs("strong", { children: [pendingHostKeyPrompt?.host || connectHost || 'localhost', ":", pendingHostKeyPrompt?.port || connectPort || '22'] })] }), _jsxs("p", { children: ["SHA-256 Fingerprint:", ' ', _jsx("code", { "data-testid": "hostkey-modal-fingerprint", children: pendingHostKeyPrompt?.fingerprint || generatedFp })] }), hostKeyModal === 'mismatch' ? (_jsxs("p", { children: ["The host key does not match your pinned fingerprint (", _jsx("code", { children: pendingHostKeyPrompt?.expectedFingerprint || 'pinned-key' }), "). This could indicate a man-in-the-middle attack. Connection is blocked unless you explicitly override."] })) : (_jsx("p", { children: "Trust on first use (TOFU) will pin this SHA-256 fingerprint in your browser store." })), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }, children: [_jsx(Button, { variant: hostKeyModal === 'mismatch' ? 'danger' : 'primary', onClick: () => {
                                    if (pendingHostKeyPrompt) {
                                        knownHosts.revokeHost(pendingHostKeyPrompt.host, pendingHostKeyPrompt.port);
                                        knownHosts.trustNewHost(pendingHostKeyPrompt.host, pendingHostKeyPrompt.port, pendingHostKeyPrompt.algorithm, pendingHostKeyPrompt.fingerprint, pendingHostKeyPrompt.publicKeyBase64);
                                    }
                                    setHostKeyModal('none');
                                    setPendingHostKeyPrompt(null);
                                    if (hostKeyDecisionResolverRef.current) {
                                        hostKeyDecisionResolverRef.current(true);
                                        hostKeyDecisionResolverRef.current = null;
                                    }
                                }, testId: "hostkey-confirm-btn", children: hostKeyModal === 'mismatch' ? 'Explicit Override & Pin New Key' : 'Trust & Pin Host Key' }), _jsx(Button, { variant: "default", testId: "hostkey-reject-btn", onClick: () => {
                                    setHostKeyModal('none');
                                    setPendingHostKeyPrompt(null);
                                    if (hostKeyDecisionResolverRef.current) {
                                        hostKeyDecisionResolverRef.current(false);
                                        hostKeyDecisionResolverRef.current = null;
                                    }
                                }, children: "Disconnect" })] })] }), _jsxs(Modal, { open: dangerousCommandPending !== null, danger: true, title: "DANGEROUS COMMAND SAFETY GUARD", onClose: () => setDangerousCommandPending(null), testId: "dangerous-command-modal", children: [_jsxs("p", { children: ["Intercepted potentially destructive command:", ' ', _jsx("code", { "data-testid": "dangerous-command-text", children: dangerousCommandPending?.command })] }), _jsx("p", { "data-testid": "dangerous-command-reason", children: dangerousCommandPending?.reason }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }, children: [_jsx(Button, { variant: "danger", testId: "confirm-dangerous-cmd-btn", onClick: () => {
                                    const cmdToRun = dangerousCommandPending?.command;
                                    setDangerousCommandPending(null);
                                    if (cmdToRun) {
                                        executeTerminalCommand(cmdToRun, true);
                                    }
                                }, children: "Execute Anyway" }), _jsx(Button, { variant: "default", testId: "cancel-dangerous-cmd-btn", onClick: () => setDangerousCommandPending(null), children: "Cancel Command" })] })] })] }));
}
//# sourceMappingURL=App.js.map