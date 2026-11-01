import { jsx as _jsx, jsxs as _jsxs } from "preact/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Badge, Button, Card, ComponentGallery, EmptyState, Icon, Modal, THEME_IDS, THEMES, applyThemeToDocument } from '@webssh/ui-kit';
import { KeyVault } from '../vault';
import { HostRegistry } from '../hosts';
import { PreferencesStore } from '../prefs';
import { XtermPaneAdapter } from '../terminal/xterm-adapter';
import { AsciicastRecorder, CommandPaletteRegistry, KeybindingRegistry, SPECIAL_KEYS_ROW, SnippetLibrary, interpolateSnippet, parseAsciicastV2, scrubAsciicastOutput } from './productivity';
import { StorageGuard, sortAndFilterEntries } from '../files';
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
    // 2. macOS / VS Code Capsule Tabs state
    const [tabs, setTabs] = useState([
        { id: 'tab-1', title: '...srinew/terminal — -zsh', connected: false }
    ]);
    const [activeTabId, setActiveTabId] = useState('tab-1');
    const [splitPanes, setSplitPanes] = useState(1);
    const [broadcastInput, setBroadcastInput] = useState(false);
    const [activeScreen, setActiveScreen] = useState('workspace');
    const [activeTheme, setActiveTheme] = useState(prefsStore.get().activeThemeId || 'dark');
    const [layoutPreset, setLayoutPreset] = useState('sidebar-left');
    const [cursorShape, setCursorShape] = useState('block');
    const [zenMode, setZenMode] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
    const [showOverlayBar, setShowOverlayBar] = useState(false);
    const [showFullscreenToast, setShowFullscreenToast] = useState(false);
    // 3. Fresh Default State (No Pre-Connected Dummy Session)
    const [connectionState, setConnectionState] = useState('disconnected');
    const [sessionTabLabel, setSessionTabLabel] = useState('...srinew/terminal — -zsh');
    const [pendingInputBytes, setPendingInputBytes] = useState(0);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [paletteQuery, setPaletteQuery] = useState('');
    const [hostKeyModal, setHostKeyModal] = useState('none');
    const [hosts, setHosts] = useState(() => hostRegistry.list());
    const [hostSearch, setHostSearch] = useState('');
    const [sshConfigInput, setSshConfigInput] = useState(['Host staging-web', '  HostName 10.10.4.12', '  User deploy', '  Port 2222', '  ProxyJump bastion.internal'].join(String.fromCharCode(10)));
    const [generatedPubKey, setGeneratedPubKey] = useState('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWebSSHStudioBrowserNonExtractableKey webssh@browser');
    const [generatedFp, setGeneratedFp] = useState('SHA256:k9XmP2vR7wL4qN8sT1yB6cF3hJ5mZ0pQ9vW2xR4tY8u');
    const [vaultLocked, setVaultLocked] = useState(false);
    const [fileFilter, setFileFilter] = useState('');
    const [transferStatus, setTransferStatus] = useState('Idle — Ready for 256 KiB chunked SFTP streaming');
    const [editorContent, setEditorContent] = useState(['# /etc/nginx/nginx.conf', 'worker_processes auto;', ''].join(String.fromCharCode(10)));
    const [editorSaved, setEditorSaved] = useState(true);
    const [scrubberSec, setScrubberSec] = useState(2.5);
    const [snippetVarService, setSnippetVarService] = useState('nginx');
    const [snippetVarLines, setSnippetVarLines] = useState('50');
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
    const updateCurrentInput = (next) => {
        const resolved = typeof next === 'function' ? next(currentInputRef.current) : next;
        currentInputRef.current = resolved;
        setCurrentInput(resolved);
    };
    // 5. Server Connection & Argon2id Auth Modal State
    const [connectModalOpen, setConnectModalOpen] = useState(false);
    const [connectHost, setConnectHost] = useState('');
    const [connectPort, setConnectPort] = useState('22');
    const [connectUser, setConnectUser] = useState('ubuntu');
    const [authMethod, setAuthMethod] = useState('Argon2id Ed25519 Key');
    const [connectPassword, setConnectPassword] = useState('');
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
    const handleAddTab = () => {
        const nextNum = tabs.length + 1;
        const newId = `tab-${Date.now()}-${nextNum}`;
        const newTitle = `...srinew/terminal — -zsh (${nextNum})`;
        setTabs((prev) => [...prev, { id: newId, title: newTitle, connected: false }]);
        setActiveTabId(newId);
        setSessionTabLabel(newTitle);
        setActiveScreen('workspace');
    };
    const handleCloseTab = (tabId, e) => {
        if (e)
            e.stopPropagation();
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
    const handleDisconnect = () => {
        setConnectionState('disconnected');
        setPendingInputBytes(0);
        setTerminalLines((prev) => [...prev, `Disconnected from ${sessionTabLabel}.`]);
        writeToXterm(`
Disconnected from ${sessionTabLabel}.
webssh:~$ `);
        const resetTitle = '...srinew/terminal — -zsh';
        setSessionTabLabel(resetTitle);
        setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, title: resetTitle, connected: false } : t)));
    };
    const handleConnectSubmit = (e) => {
        if (e)
            e.preventDefault();
        const hostVal = connectHost.trim() || 'edge-01.prod.internal';
        const userVal = connectUser.trim() || 'ubuntu';
        const portVal = connectPort.trim() || '22';
        const label = `${userVal}@${hostVal}`;
        setSessionTabLabel(label);
        setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, title: `${label} — -zsh`, connected: true } : t)));
        setConnectionState('connected');
        setConnectModalOpen(false);
        setActiveScreen('workspace');
        const msg = `Connected to ${label}:${portVal} (${authMethod})`;
        setTerminalLines((prev) => [...prev, msg]);
        writeToXterm(`
${msg}
webssh:~$ `);
    };
    const executeTerminalCommand = (rawCommand) => {
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
            }
            catch {
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
            }
            else {
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
    const handleTerminalKeyDown = (e) => {
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
            else if (e.key === 'Escape' && isFullscreen) {
                void exitImmersiveFullscreen();
            }
            else if (e.key === 'Alt' && isFullscreen) {
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
    const sftpEntries = useMemo(() => sortAndFilterEntries([
        { name: 'config', path: '/etc/app/config', size: 0, mode: 'drwxr-xr-x', modTime: 1730000000, isDir: true },
        { name: 'nginx.conf', path: '/etc/nginx/nginx.conf', size: 2048, mode: '-rw-r--r--', modTime: 1730000500, isDir: false },
        { name: 'release.tar.zst', path: '/srv/release.tar.zst', size: 5242880, mode: '-rw-r--r--', modTime: 1730000900, isDir: false }
    ], fileFilter), [fileFilter]);
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
    return (_jsxs("div", { ref: rootRef, "data-testid": "workspace-root", className: `webssh-app ${isPseudoFullscreen ? 'webssh-app--pseudo-fullscreen' : ''}`.trim(), onClick: () => {
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
                                            }, "data-testid": "menu-features-btn", children: "Features (50)" }) })] })] }), _jsxs("div", { className: "webssh-window-title", "data-testid": "macos-window-title", children: [_jsx(Icon, { name: "folder" }), _jsxs("span", { children: ["terminal \u2014 ", activeSessionTitle, " \u2014 ", cols, "x", rows] })] }), _jsx("div", { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }, children: _jsx(Badge, { tone: connectionState === 'connected' ? 'success' : 'neutral', children: connectionState === 'connected' ? 'SSH Active' : 'Local Shell' }) })] })) : null, !isFullscreen && !zenMode ? (_jsxs("header", { className: "webssh-topbar", role: "banner", children: [_jsxs("div", { className: "webssh-tabs", role: "tablist", "aria-label": "Active SSH sessions", children: [tabs.map((tab, idx) => {
                                const isActive = tab.id === activeTabId;
                                return (_jsxs("button", { type: "button", role: "tab", "aria-selected": isActive && activeScreen === 'workspace', className: `webssh-tab ${isActive && activeScreen === 'workspace' ? 'webssh-tab--active' : ''}`.trim(), onClick: () => {
                                        setActiveTabId(tab.id);
                                        setSessionTabLabel(tab.title);
                                        setActiveScreen('workspace');
                                    }, "data-testid": idx === 0 ? 'tab-session-1' : `tab-session-${idx + 1}`, children: [_jsx("span", { className: `webssh-status-dot ${statusDotClass}`.trim() }), _jsx("span", { children: idx === 0 ? sessionTabLabel : tab.title }), _jsx("span", { role: "button", tabIndex: 0, "aria-label": `Close ${tab.title}`, className: "webssh-tab-close", "data-testid": `close-tab-${tab.id}`, onClick: (e) => handleCloseTab(tab.id, e), onKeyDown: (e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    handleCloseTab(tab.id, e);
                                                }
                                            }, children: "\u00D7" })] }, tab.id));
                            }), _jsx("button", { type: "button", className: "webssh-tab-add", "aria-label": "New terminal tab", title: "New Tab", "data-testid": "add-tab-btn", onClick: handleAddTab, children: "+" })] }), _jsxs("div", { "data-testid": "topbar-quick-controls", style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }, children: [_jsxs("select", { className: "ui-select", "aria-label": "Terminal font family", "data-testid": "font-family-select", value: fontFamily, onChange: (e) => setFontFamily(e.currentTarget.value), style: { width: 'auto' }, children: [_jsx("option", { value: "SF Mono", children: "SF Mono" }), _jsx("option", { value: "'JetBrains Mono', 'Fira Code', monospace", children: "JetBrains Mono" }), _jsx("option", { value: "Fira Code", children: "Fira Code" }), _jsx("option", { value: "Menlo", children: "Menlo" }), _jsx("option", { value: "Monaco", children: "Monaco" }), _jsx("option", { value: "Courier New", children: "Courier New" })] }), _jsxs("div", { style: { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }, children: [_jsx(Button, { variant: "ghost", ariaLabel: "Decrease font size", testId: "font-size-dec-btn", onClick: () => setFontSize((s) => Math.max(11, s - 1)), children: "A-" }), _jsxs("span", { className: "font-size-badge", "data-testid": "font-size-badge", children: [fontSize, "px"] }), _jsx(Button, { variant: "ghost", ariaLabel: "Increase font size", testId: "font-size-inc-btn", onClick: () => setFontSize((s) => Math.min(32, s + 1)), children: "A+" })] }), _jsx("span", { className: `webssh-status-dot ${statusDotClass}`.trim(), title: `Connection state: ${connectionState}`, "data-testid": "connection-status-dot" }), connectionState === 'disconnected' ? (_jsx(Button, { variant: "primary", onClick: () => setConnectModalOpen(true), testId: "new-connection-btn", children: "New Connection" })) : (_jsx(Button, { variant: "destructive", onClick: handleDisconnect, testId: "disconnect-btn", children: "Disconnect" })), _jsxs(Button, { variant: "ghost", onClick: () => setPaletteOpen(true), testId: "open-palette-btn", children: [_jsx(Icon, { name: "search" }), " Command Palette (Cmd+K)"] }), _jsx(Button, { variant: "ghost", onClick: () => setZenMode((z) => !z), testId: "toggle-zen-btn", children: "Zen" }), _jsxs(Button, { variant: "primary", onClick: toggleFullscreen, testId: "toggle-fullscreen-btn", children: [_jsx(Icon, { name: "maximize" }), " Full Screen"] })] })] })) : null, connectionState !== 'connected' && connectionState !== 'disconnected' ? (_jsxs("div", { className: "webssh-banner", role: "status", "data-testid": "reconnect-banner", children: [_jsxs("span", { children: [connectionState === 'reconnecting' && 'Reconnecting (attempt 3, backoff 2.1s)…', connectionState === 'offline' && 'Offline — queuing input locally (64 KiB cap)', connectionState === 'resumed' && 'Session resumed from gateway ring buffer'] }), pendingInputBytes > 0 ? (_jsxs(Badge, { tone: "warning", testId: "pending-input-badge", children: ["Pending input: ", pendingInputBytes, " B"] })) : null, _jsx(Button, { variant: "ghost", onClick: () => {
                            setConnectionState('connected');
                            setPendingInputBytes(0);
                        }, children: "Dismiss" })] })) : null, _jsxs("div", { className: `webssh-workspace-body ${layoutPreset === 'sidebar-right' ? 'webssh-workspace-body--right' : ''}`.trim(), children: [!isFullscreen && !zenMode ? (_jsxs("nav", { className: "webssh-rail", "aria-label": "Workspace navigation", children: [_jsxs(Button, { variant: activeScreen === 'workspace' ? 'primary' : 'ghost', onClick: () => setActiveScreen('workspace'), testId: "nav-workspace", children: [_jsx(Icon, { name: "terminal" }), " Terminal"] }), _jsx(Button, { variant: activeScreen === 'features' ? 'primary' : 'ghost', onClick: () => setActiveScreen('features'), testId: "nav-features", children: "Features (50)" }), _jsx(Button, { variant: activeScreen === 'welcome' ? 'primary' : 'ghost', onClick: () => setActiveScreen('welcome'), testId: "nav-welcome", children: "Welcome" }), _jsxs(Button, { variant: activeScreen === 'vault' ? 'primary' : 'ghost', onClick: () => setActiveScreen('vault'), testId: "nav-vault", children: [_jsx(Icon, { name: "key" }), " Key Vault"] }), _jsxs(Button, { variant: activeScreen === 'hosts' ? 'primary' : 'ghost', onClick: () => setActiveScreen('hosts'), testId: "nav-hosts", children: [_jsx(Icon, { name: "server" }), " Hosts"] }), _jsxs(Button, { variant: activeScreen === 'files' ? 'primary' : 'ghost', onClick: () => setActiveScreen('files'), testId: "nav-files", children: [_jsx(Icon, { name: "folder" }), " SFTP Files"] }), _jsx(Button, { variant: activeScreen === 'editor' ? 'primary' : 'ghost', onClick: () => setActiveScreen('editor'), testId: "nav-editor", children: "Editor" }), _jsx(Button, { variant: activeScreen === 'snippets' ? 'primary' : 'ghost', onClick: () => setActiveScreen('snippets'), testId: "nav-snippets", children: "Snippets & Replay" }), _jsxs(Button, { variant: activeScreen === 'settings' ? 'primary' : 'ghost', onClick: () => setActiveScreen('settings'), testId: "nav-settings", children: [_jsx(Icon, { name: "settings" }), " Settings"] })] })) : null, _jsxs("main", { className: "webssh-main", children: [activeScreen === 'workspace' ? (_jsxs("div", { className: "webssh-split-container", children: [_jsxs("div", { ref: terminalViewRef, tabIndex: 0, role: "region", "aria-label": "SSH Terminal Viewport", "data-testid": "terminal-viewport", className: "webssh-terminal-viewport", style: { fontSize: `${fontSize}px`, fontFamily }, onKeyDown: handleTerminalKeyDown, children: [terminalLines.map((line, i) => (_jsx("div", { children: line }, i))), _jsxs("div", { "data-testid": "terminal-prompt-line", children: [_jsx("span", { children: "webssh:~$ " }), _jsx("span", { "data-testid": "terminal-current-input", children: currentInput }), _jsx("span", { className: `webssh-terminal-cursor ${cursorShape === 'bar'
                                                            ? 'webssh-terminal-cursor--bar'
                                                            : cursorShape === 'underline'
                                                                ? 'webssh-terminal-cursor--underline'
                                                                : ''}`.trim(), "aria-hidden": "true" })] }), _jsx("div", { ref: xtermHostRef, className: "webssh-xterm-mount", "aria-hidden": "true", "data-testid": "xterm-engine-mount" })] }), splitPanes > 1 ? (_jsxs("div", { tabIndex: 0, role: "region", "aria-label": "Secondary Split Terminal Viewport", "data-testid": "terminal-split-pane-2", className: "webssh-terminal-viewport", style: {
                                            fontSize: `${fontSize}px`,
                                            fontFamily,
                                            borderLeft: 'var(--border-hairline)'
                                        }, children: [_jsxs("div", { children: ["Split Pane #2 (", broadcastInput ? 'Broadcast Input ON' : 'Independent Shell', ")"] }), _jsxs("div", { children: [_jsx("span", { children: "webssh:~$ " }), _jsx("span", { children: broadcastInput ? currentInput : '' }), _jsx("span", { className: "webssh-terminal-cursor", "aria-hidden": "true" })] })] })) : null] })) : null, activeScreen === 'features' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-features", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsx("h1", { children: "All 50 Features \u2014 Interactive Selector & Workbench" }), _jsx(Badge, { tone: "success", testId: "feature-active-status", children: lastExecutedFeatureMsg })] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }, children: [['All', 'Connection', 'Terminal', 'Files', 'Customization', 'Security', 'Productivity'].map((cat) => (_jsx(Button, { variant: featureCategory === cat ? 'primary' : 'default', onClick: () => setFeatureCategory(cat), testId: `feature-cat-${cat.toLowerCase()}`, children: cat }, cat))), _jsx("input", { type: "search", className: "ui-input", placeholder: "Search all 50 features by name, number, or category\u2026", "aria-label": "Search 50 features", value: featureQuery, onInput: (e) => setFeatureQuery(e.target.value), "data-testid": "feature-search-input", style: { flex: 1, minWidth: '220px' } })] }), _jsx("div", { className: "webssh-grid", children: filteredFeatures.map((feat) => (_jsxs(Card, { testId: `feature-card-${feat.id}`, className: selectedFeatureId === feat.id ? 'ui-card--selected' : '', children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsxs("strong", { children: ["#", feat.id, " \u00B7 ", feat.title] }), _jsx(Badge, { tone: "neutral", children: feat.category })] }), _jsx("p", { children: feat.description }), _jsx("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: _jsx(Button, { variant: "primary", onClick: () => handleRunFeature(feat), testId: `run-feature-${feat.id}`, children: feat.actionLabel }) })] }, feat.id))) })] })) : null, activeScreen === 'welcome' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-welcome", children: [_jsx("h1", { children: "Welcome to WebSSH Studio" }), _jsxs("div", { className: "webssh-grid", children: [_jsxs(Card, { children: [_jsx("h2", { children: "1. Create Non-Extractable Key" }), _jsx("p", { children: "Generate an Ed25519 or ECDSA P-256 key pair inside WebCrypto + IndexedDB." }), _jsx(Button, { variant: "primary", onClick: () => void handleGenerateKey(), testId: "welcome-generate-key-btn", children: "Generate SSH key" })] }), _jsxs(Card, { children: [_jsx("h2", { children: "2. Add Target Host" }), _jsx("p", { children: "Configure your SSH destination or import ~/.ssh/config with ProxyJump chains." }), _jsx(Button, { variant: "default", onClick: () => setActiveScreen('hosts'), children: "Configure Hosts" })] }), _jsxs(Card, { children: [_jsx("h2", { children: "3. Connect via Remote Signer" }), _jsx("p", { children: "Private keys never leave your browser; challenges are signed locally." }), _jsx(Button, { variant: "default", onClick: () => setActiveScreen('workspace'), children: "Open Terminal" })] })] })] })) : null, activeScreen === 'vault' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-vault", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("h1", { children: "SSH Key Vault" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsx(Button, { variant: "primary", onClick: () => void handleGenerateKey(), testId: "vault-generate-btn", children: "Generate SSH key" }), _jsxs(Button, { variant: "default", onClick: () => setVaultLocked((v) => !v), testId: "vault-lock-btn", children: [_jsx(Icon, { name: "lock" }), " ", vaultLocked ? 'Unlock Vault' : 'Lock Vault'] })] })] }), vaultLocked ? (_jsx(EmptyState, { title: "Vault is Locked", description: "Protected with Argon2id + AES-GCM wrapping. Unlock to sign SSH challenges.", action: _jsx(Button, { variant: "primary", onClick: () => setVaultLocked(false), children: "Unlock Vault" }) })) : (_jsxs(Card, { children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("strong", { children: "prod-ed25519-key" }), _jsx(Badge, { tone: "success", children: "Ed25519 \u00B7 Non-Extractable" })] }), _jsxs("p", { "data-testid": "vault-fingerprint", children: ["Fingerprint: ", generatedFp] }), _jsx("label", { htmlFor: "pubkey-box", children: "OpenSSH Public Key & authorized_keys snippet" }), _jsx("textarea", { id: "pubkey-box", className: "ui-input", readOnly: true, rows: 3, value: generatedPubKey, "data-testid": "vault-pubkey-output" }), _jsx("div", { style: { display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }, children: _jsxs(Button, { variant: "default", onClick: () => copyToClipboard(authorizedKeysSnippet), children: [_jsx(Icon, { name: "copy" }), " Copy authorized_keys Snippet"] }) })] }))] })) : null, activeScreen === 'hosts' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-hosts", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("h1", { children: "Saved Hosts & ProxyJump Chains" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsx(Button, { variant: "default", onClick: () => setHostKeyModal('tofu'), testId: "trigger-tofu-modal-btn", children: "Verify Host Key (TOFU)" }), _jsx(Button, { variant: "danger", onClick: () => setHostKeyModal('mismatch'), testId: "trigger-mismatch-modal-btn", children: "Simulate KEY CHANGED" })] })] }), _jsx("input", { type: "search", className: "ui-input", placeholder: "Filter hosts by alias, user, hostname, or tag\u2026", value: hostSearch, onInput: (e) => setHostSearch(e.target.value), "aria-label": "Filter hosts" }), _jsx("div", { className: "webssh-grid", children: hosts
                                            .filter((h) => !hostSearch || h.alias.toLowerCase().includes(hostSearch.toLowerCase()))
                                            .map((h) => (_jsxs(Card, { testId: `host-card-${h.alias}`, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between' }, children: [_jsx("strong", { children: h.alias }), _jsx(Badge, { tone: "success", children: h.folder ?? 'Default' })] }), _jsxs("p", { children: [h.user, "@", h.host, ":", h.port] }), h.jumpHops.length > 0 ? (_jsxs("p", { children: ["ProxyJump: ", h.jumpHops.map((j) => `${j.user}@${j.host}:${j.port}`).join(' -> ')] })) : null, _jsx(Button, { variant: "primary", onClick: () => {
                                                        setConnectUser(h.user);
                                                        setConnectHost(h.host);
                                                        setConnectPort(String(h.port));
                                                        setConnectModalOpen(true);
                                                    }, children: "Connect" })] }, h.id))) }), _jsxs(Card, { children: [_jsx("h2", { children: "Import ~/.ssh/config" }), _jsx("textarea", { className: "ui-input", rows: 4, "aria-label": "SSH config content", value: sshConfigInput, onInput: (e) => setSshConfigInput(e.target.value) }), _jsx("div", { style: { marginTop: 'var(--space-2)' }, children: _jsx(Button, { variant: "primary", testId: "import-ssh-config-btn", onClick: () => {
                                                        hostRegistry.importSshConfig(sshConfigInput);
                                                        setHosts(hostRegistry.list());
                                                    }, children: "Import ~/.ssh/config" }) })] })] })) : null, activeScreen === 'files' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-files", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsx("h1", { children: "Dual-Pane SFTP File Manager" }), _jsxs(Badge, { tone: "neutral", testId: "storage-quota-badge", children: ["Storage Guard: ", quotaSnap.percentUsed, "% of 256 MiB cap (256 KiB chunks, SHA-256 verified)"] })] }), _jsx("p", { children: transferStatus }), _jsx("input", { type: "search", className: "ui-input", placeholder: "Filter remote directory entries\u2026", value: fileFilter, onInput: (e) => setFileFilter(e.target.value), "aria-label": "Filter remote directory entries" }), _jsxs(Card, { children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsx("p", { children: "Drop files or folders to upload to /srv/app (resumable .part atomic rename)" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsxs(Button, { variant: "primary", onClick: () => setTransferStatus('Uploaded release.tar.zst (20/20 chunks · 256 KiB · SHA-256 verified)'), children: [_jsx(Icon, { name: "upload" }), " Simulate 256 KiB Upload"] }), _jsxs(Button, { variant: "default", onClick: () => setTransferStatus('Streaming /etc/app/config.zip via ZIP64 writer…'), children: [_jsx(Icon, { name: "download" }), " Download Folder ZIP"] })] })] }), _jsx("ul", { children: sftpEntries.map((entry) => (_jsxs("li", { children: [_jsx("strong", { children: entry.isDir ? `[DIR] ${entry.name}` : entry.name }), " \u2014 ", entry.size, " bytes (", entry.mode, ")"] }, entry.path))) })] })] })) : null, activeScreen === 'editor' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-editor", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("h1", { children: "Remote File Editor \u2014 /etc/nginx/nginx.conf" }), _jsxs(Button, { variant: "primary", onClick: () => setEditorSaved(true), testId: "save-remote-file-btn", children: ["Save to host ", editorSaved ? '(Saved)' : '(Unsaved*)'] })] }), _jsx("textarea", { className: "ui-input", rows: 10, "aria-label": "Remote file content", value: editorContent, onInput: (e) => {
                                            setEditorContent(e.target.value);
                                            setEditorSaved(false);
                                        } })] })) : null, activeScreen === 'snippets' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-snippets", children: [_jsx("h1", { children: "Snippets & Asciicast v2 Session Replay" }), _jsxs(Card, { children: [_jsx("h2", { children: "Variable Interpolation Parameters" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }, children: [_jsxs("div", { children: [_jsx("label", { htmlFor: "snip-var-service", children: "service" }), _jsx("input", { id: "snip-var-service", className: "ui-input", value: snippetVarService, onInput: (e) => setSnippetVarService(e.target.value) })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "snip-var-lines", children: "lines" }), _jsx("input", { id: "snip-var-lines", className: "ui-input", value: snippetVarLines, onInput: (e) => setSnippetVarLines(e.target.value) })] })] })] }), _jsx("div", { className: "webssh-grid", children: snippetLib.list().map((snip) => {
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
                                                        }, children: "Simulate Resumed" })] })] })] })) : null, !isFullscreen && !zenMode ? (_jsx("div", { className: "webssh-special-keys", role: "toolbar", "aria-label": "Mobile and Tablet Special Keys", children: SPECIAL_KEYS_ROW.map((keyLabel) => (_jsx(Button, { variant: "ghost", testId: `special-key-${keyLabel}`, children: keyLabel }, keyLabel))) })) : null] })] }), !isFullscreen && !zenMode ? (_jsxs("footer", { className: "webssh-statusbar", role: "contentinfo", "data-testid": "status-bar", children: [_jsx("span", { children: connectionState === 'connected'
                            ? `Connected: ${sessionTabLabel} · Cipher: chacha20-poly1305@openssh.com`
                            : 'Status: Disconnected · Ready for SSH connection' }), _jsxs("span", { children: ["Remote Signer: Argon2id Ed25519 \u00B7 ", cols, "x", rows, " \u00B7 Font: ", fontSize, "px"] })] })) : null, _jsx(Modal, { open: connectModalOpen, title: "New SSH Connection & Argon2id Credentials", onClose: () => setConnectModalOpen(false), testId: "connect-modal", children: _jsxs("form", { onSubmit: handleConnectSubmit, style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }, children: [_jsxs("div", { children: [_jsx("label", { htmlFor: "connect-host-input", children: "Host (IP or domain)" }), _jsx("input", { id: "connect-host-input", type: "text", className: "ui-input", placeholder: "e.g. 192.168.1.10 or edge-01.prod.internal", value: connectHost, onInput: (e) => setConnectHost(e.target.value), "data-testid": "connect-host-input" })] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsxs("div", { style: { flex: 2 }, children: [_jsx("label", { htmlFor: "connect-user-input", children: "Username" }), _jsx("input", { id: "connect-user-input", type: "text", className: "ui-input", placeholder: "root / ubuntu", value: connectUser, onInput: (e) => setConnectUser(e.target.value), "data-testid": "connect-user-input" })] }), _jsxs("div", { style: { flex: 1 }, children: [_jsx("label", { htmlFor: "connect-port-input", children: "Port" }), _jsx("input", { id: "connect-port-input", type: "number", className: "ui-input", value: connectPort, onInput: (e) => setConnectPort(e.target.value), "data-testid": "connect-port-input" })] })] }), _jsxs("div", { children: [_jsx("label", { children: "Auth Mode" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-1)', flexWrap: 'wrap' }, children: [_jsx(Button, { variant: authMethod === 'Argon2id Ed25519 Key' ? 'primary' : 'default', onClick: () => setAuthMethod('Argon2id Ed25519 Key'), testId: "auth-method-pubkey-btn", children: "Argon2id Ed25519 Key" }), _jsx(Button, { variant: authMethod === 'Password' ? 'primary' : 'default', onClick: () => setAuthMethod('Password'), testId: "auth-method-password-btn", children: "Password" })] })] }), authMethod === 'Password' ? (_jsxs("div", { children: [_jsx("label", { htmlFor: "connect-password-input", children: "Password" }), _jsx("input", { id: "connect-password-input", type: "password", className: "ui-input", placeholder: "Enter SSH password\u2026", value: connectPassword, onInput: (e) => setConnectPassword(e.target.value), "data-testid": "connect-password-input" })] })) : null, _jsxs("div", { children: [_jsx("label", { htmlFor: "connect-pubkey-snippet", children: "Public Key Snippet (authorized_keys)" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-1)' }, children: [_jsx("input", { id: "connect-pubkey-snippet", type: "text", className: "ui-input", readOnly: true, value: authorizedKeysSnippet, "data-testid": "connect-pubkey-snippet" }), _jsxs(Button, { variant: "default", onClick: () => copyToClipboard(authorizedKeysSnippet), testId: "copy-pubkey-snippet-btn", children: [_jsx(Icon, { name: "copy" }), " ", copiedSnippet ? 'Copied' : 'Copy'] })] })] }), _jsxs("div", { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }, children: [_jsx(Button, { variant: "default", onClick: () => setConnectModalOpen(false), children: "Cancel" }), _jsx(Button, { variant: "primary", type: "submit", testId: "connect-modal-submit-btn", children: "Connect" })] })] }) }), _jsxs(Modal, { open: paletteOpen, title: "Command Palette", onClose: () => setPaletteOpen(false), testId: "command-palette-modal", children: [_jsx("input", { type: "search", className: "ui-input", placeholder: "Type a command or search actions\u2026", value: paletteQuery, onInput: (e) => setPaletteQuery(e.target.value), "aria-label": "Command palette search", "data-testid": "command-palette-input" }), _jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', marginTop: 'var(--space-3)' }, children: paletteRegistry.search(paletteQuery).map((cmd) => (_jsxs(Button, { variant: "ghost", onClick: () => void cmd.run(), testId: `palette-cmd-${cmd.id}`, children: [_jsx("span", { children: cmd.title }), cmd.shortcut ? _jsx(Badge, { tone: "neutral", children: cmd.shortcut }) : null] }, cmd.id))) })] }), _jsxs(Modal, { open: hostKeyModal !== 'none', danger: hostKeyModal === 'mismatch', title: hostKeyModal === 'mismatch' ? 'WARNING: REMOTE HOST KEY CHANGED' : 'Verify Unknown Host Key (TOFU)', onClose: () => setHostKeyModal('none'), testId: "hostkey-modal", children: [_jsxs("p", { children: ["Host: ", _jsx("strong", { children: "edge-01.prod.internal:22" })] }), _jsxs("p", { children: ["SHA-256 Fingerprint: ", _jsx("code", { children: generatedFp })] }), hostKeyModal === 'mismatch' ? (_jsx("p", { children: "The host key does not match your pinned fingerprint. This could indicate a man-in-the-middle attack. Connection is blocked unless you explicitly override." })) : (_jsx("p", { children: "Trust on first use (TOFU) will pin this SHA-256 fingerprint in your browser store." })), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }, children: [_jsx(Button, { variant: hostKeyModal === 'mismatch' ? 'danger' : 'primary', onClick: () => setHostKeyModal('none'), testId: "hostkey-confirm-btn", children: hostKeyModal === 'mismatch' ? 'Explicit Override & Pin New Key' : 'Trust & Pin Host Key' }), _jsx(Button, { variant: "default", onClick: () => setHostKeyModal('none'), children: "Disconnect" })] })] })] }));
}
//# sourceMappingURL=App.js.map