import { jsx as _jsx, jsxs as _jsxs } from "preact/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Badge, Button, Card, ComponentGallery, EmptyState, Icon, Modal, THEME_IDS, applyThemeToDocument } from '@webssh/ui-kit';
import { KeyVault } from '../vault';
import { HostRegistry } from '../hosts';
import { PreferencesStore } from '../prefs';
import { AsciicastRecorder, CommandPaletteRegistry, KeybindingRegistry, SPECIAL_KEYS_ROW, SnippetLibrary, parseAsciicastV2, scrubAsciicastOutput } from './productivity';
import { StorageGuard, sortAndFilterEntries } from '../files';
export function App() {
    const rootRef = useRef(null);
    const terminalViewRef = useRef(null);
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
    const [activeScreen, setActiveScreen] = useState('workspace');
    const [activeTheme, setActiveTheme] = useState(prefsStore.get().activeThemeId || 'dark');
    const [zenMode, setZenMode] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
    const [showOverlayBar, setShowOverlayBar] = useState(false);
    const [showFullscreenToast, setShowFullscreenToast] = useState(false);
    const [connectionState, setConnectionState] = useState('connected');
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
    const [editorContent, setEditorContent] = useState(['# /etc/nginx/nginx.conf', 'worker_processes auto;', ''].join(String.fromCharCode(10)));
    const [editorSaved, setEditorSaved] = useState(true);
    const [scrubberSec, setScrubberSec] = useState(2.5);
    const [terminalLines, setTerminalLines] = useState([
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
    const sftpEntries = useMemo(() => sortAndFilterEntries([
        { name: 'config', path: '/etc/app/config', size: 0, mode: 'drwxr-xr-x', modTime: 1730000000, isDir: true },
        { name: 'nginx.conf', path: '/etc/nginx/nginx.conf', size: 2048, mode: '-rw-r--r--', modTime: 1730000500, isDir: false },
        { name: 'release.tar.zst', path: '/srv/release.tar.zst', size: 5242880, mode: '-rw-r--r--', modTime: 1730000900, isDir: false }
    ], fileFilter), [fileFilter]);
    const quotaSnap = storageGuard.snapshot();
    return (_jsxs("div", { ref: rootRef, "data-testid": "workspace-root", className: `webssh-app ${isPseudoFullscreen ? 'webssh-app--pseudo-fullscreen' : ''}`.trim(), children: [isFullscreen ? (_jsx("div", { "data-testid": "fullscreen-top-hover-zone", className: "webssh-fullscreen-hover-zone", onMouseEnter: () => setShowOverlayBar(true) })) : null, isFullscreen && showOverlayBar ? (_jsxs("div", { "data-testid": "fullscreen-overlay-bar", className: "webssh-fullscreen-overlay-bar", onMouseLeave: () => setShowOverlayBar(false), children: [_jsx(Badge, { tone: "success", children: "edge-01.prod.internal" }), _jsx(Button, { variant: "ghost", onClick: () => setActiveScreen('settings'), testId: "overlay-settings-btn", children: "Settings" }), _jsx(Button, { variant: "primary", onClick: () => void exitImmersiveFullscreen(), testId: "overlay-exit-fullscreen-btn", children: "Exit Full Screen" })] })) : null, showFullscreenToast ? (_jsx("div", { role: "status", "data-testid": "fullscreen-toast", className: "webssh-fullscreen-toast", children: "Press F11 or Esc to exit" })) : null, !isFullscreen && !zenMode ? (_jsxs("header", { className: "webssh-topbar", role: "banner", children: [_jsx("div", { className: "webssh-tabs", role: "tablist", "aria-label": "Active SSH sessions", children: _jsxs("button", { type: "button", role: "tab", "aria-selected": activeScreen === 'workspace', className: `webssh-tab ${activeScreen === 'workspace' ? 'webssh-tab--active' : ''}`.trim(), onClick: () => setActiveScreen('workspace'), "data-testid": "tab-session-1", children: [_jsx("span", { className: `webssh-status-dot ${connectionState === 'reconnecting'
                                        ? 'webssh-status-dot--reconnecting'
                                        : connectionState === 'offline'
                                            ? 'webssh-status-dot--offline'
                                            : ''}`.trim() }), _jsx("span", { children: "sre@edge-01.prod.internal" })] }) }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }, children: [_jsxs(Button, { variant: "ghost", onClick: () => setPaletteOpen(true), testId: "open-palette-btn", children: [_jsx(Icon, { name: "search" }), " Command Palette (Cmd+K)"] }), _jsx(Button, { variant: "ghost", onClick: () => setZenMode((z) => !z), testId: "toggle-zen-btn", children: "Zen" }), _jsxs(Button, { variant: "primary", onClick: toggleFullscreen, testId: "toggle-fullscreen-btn", children: [_jsx(Icon, { name: "maximize" }), " Full Screen"] })] })] })) : null, connectionState !== 'connected' ? (_jsxs("div", { className: "webssh-banner", role: "status", "data-testid": "reconnect-banner", children: [_jsxs("span", { children: [connectionState === 'reconnecting' && 'Reconnecting (attempt 3, backoff 2.1s)…', connectionState === 'offline' && 'Offline — queuing input locally (64 KiB cap)', connectionState === 'resumed' && 'Session resumed from gateway ring buffer'] }), pendingInputBytes > 0 ? (_jsxs(Badge, { tone: "warning", testId: "pending-input-badge", children: ["Pending input: ", pendingInputBytes, " B"] })) : null, _jsx(Button, { variant: "ghost", onClick: () => {
                            setConnectionState('connected');
                            setPendingInputBytes(0);
                        }, children: "Dismiss" })] })) : null, _jsxs("div", { className: "webssh-workspace-body", children: [!isFullscreen && !zenMode ? (_jsxs("nav", { className: "webssh-rail", "aria-label": "Workspace navigation", children: [_jsxs(Button, { variant: activeScreen === 'workspace' ? 'primary' : 'ghost', onClick: () => setActiveScreen('workspace'), testId: "nav-workspace", children: [_jsx(Icon, { name: "terminal" }), " Terminal"] }), _jsx(Button, { variant: activeScreen === 'welcome' ? 'primary' : 'ghost', onClick: () => setActiveScreen('welcome'), testId: "nav-welcome", children: "Welcome" }), _jsxs(Button, { variant: activeScreen === 'vault' ? 'primary' : 'ghost', onClick: () => setActiveScreen('vault'), testId: "nav-vault", children: [_jsx(Icon, { name: "key" }), " Key Vault"] }), _jsxs(Button, { variant: activeScreen === 'hosts' ? 'primary' : 'ghost', onClick: () => setActiveScreen('hosts'), testId: "nav-hosts", children: [_jsx(Icon, { name: "server" }), " Hosts"] }), _jsxs(Button, { variant: activeScreen === 'files' ? 'primary' : 'ghost', onClick: () => setActiveScreen('files'), testId: "nav-files", children: [_jsx(Icon, { name: "folder" }), " SFTP Files"] }), _jsx(Button, { variant: activeScreen === 'editor' ? 'primary' : 'ghost', onClick: () => setActiveScreen('editor'), testId: "nav-editor", children: "Editor" }), _jsx(Button, { variant: activeScreen === 'snippets' ? 'primary' : 'ghost', onClick: () => setActiveScreen('snippets'), testId: "nav-snippets", children: "Snippets & Replay" }), _jsxs(Button, { variant: activeScreen === 'settings' ? 'primary' : 'ghost', onClick: () => setActiveScreen('settings'), testId: "nav-settings", children: [_jsx(Icon, { name: "settings" }), " Settings"] })] })) : null, _jsxs("main", { className: "webssh-main", children: [activeScreen === 'workspace' ? (_jsxs("div", { ref: terminalViewRef, tabIndex: 0, role: "region", "aria-label": "SSH Terminal Viewport", "data-testid": "terminal-viewport", className: "webssh-terminal-viewport", children: [terminalLines.map((line, i) => (_jsx("div", { children: line }, i))), _jsxs("div", { children: [_jsx("span", { children: "sre@edge-01:~$ " }), _jsx("span", { className: "webssh-terminal-cursor", "aria-hidden": "true" })] })] })) : null, activeScreen === 'welcome' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-welcome", children: [_jsx("h1", { children: "Welcome to WebSSH Studio" }), _jsxs("div", { className: "webssh-grid", children: [_jsxs(Card, { children: [_jsx("h2", { children: "1. Create Non-Extractable Key" }), _jsx("p", { children: "Generate an Ed25519 or ECDSA P-256 key pair inside WebCrypto + IndexedDB." }), _jsx(Button, { variant: "primary", onClick: () => void handleGenerateKey(), testId: "welcome-generate-key-btn", children: "Generate SSH key" })] }), _jsxs(Card, { children: [_jsx("h2", { children: "2. Add Target Host" }), _jsx("p", { children: "Configure your SSH destination or import ~/.ssh/config with ProxyJump chains." }), _jsx(Button, { variant: "default", onClick: () => setActiveScreen('hosts'), children: "Configure Hosts" })] }), _jsxs(Card, { children: [_jsx("h2", { children: "3. Connect via Remote Signer" }), _jsx("p", { children: "Private keys never leave your browser; challenges are signed locally." }), _jsx(Button, { variant: "default", onClick: () => setActiveScreen('workspace'), children: "Open Terminal" })] })] })] })) : null, activeScreen === 'vault' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-vault", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("h1", { children: "SSH Key Vault" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsx(Button, { variant: "primary", onClick: () => void handleGenerateKey(), testId: "vault-generate-btn", children: "Generate SSH key" }), _jsxs(Button, { variant: "default", onClick: () => setVaultLocked((v) => !v), testId: "vault-lock-btn", children: [_jsx(Icon, { name: "lock" }), " ", vaultLocked ? 'Unlock Vault' : 'Lock Vault'] })] })] }), vaultLocked ? (_jsx(EmptyState, { title: "Vault is Locked", description: "Protected with Argon2id + AES-GCM wrapping. Unlock to sign SSH challenges.", action: _jsx(Button, { variant: "primary", onClick: () => setVaultLocked(false), children: "Unlock Vault" }) })) : (_jsxs(Card, { children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("strong", { children: "prod-ed25519-key" }), _jsx(Badge, { tone: "success", children: "Ed25519 \u00B7 Non-Extractable" })] }), _jsxs("p", { "data-testid": "vault-fingerprint", children: ["Fingerprint: ", generatedFp] }), _jsx("label", { htmlFor: "pubkey-box", children: "OpenSSH Public Key & authorized_keys snippet" }), _jsx("textarea", { id: "pubkey-box", className: "ui-input", readOnly: true, rows: 3, value: generatedPubKey, "data-testid": "vault-pubkey-output" })] }))] })) : null, activeScreen === 'hosts' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-hosts", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("h1", { children: "Saved Hosts & ProxyJump Chains" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsx(Button, { variant: "default", onClick: () => setHostKeyModal('tofu'), testId: "trigger-tofu-modal-btn", children: "Verify Host Key (TOFU)" }), _jsx(Button, { variant: "danger", onClick: () => setHostKeyModal('mismatch'), testId: "trigger-mismatch-modal-btn", children: "Simulate KEY CHANGED" })] })] }), _jsx("input", { type: "search", className: "ui-input", placeholder: "Filter hosts by alias, user, hostname, or tag\u2026", value: hostSearch, onInput: (e) => setHostSearch(e.target.value), "aria-label": "Filter hosts" }), _jsx("div", { className: "webssh-grid", children: hosts
                                            .filter((h) => !hostSearch || h.alias.toLowerCase().includes(hostSearch.toLowerCase()))
                                            .map((h) => (_jsxs(Card, { testId: `host-card-${h.alias}`, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between' }, children: [_jsx("strong", { children: h.alias }), _jsx(Badge, { tone: "success", children: h.folder ?? 'Default' })] }), _jsxs("p", { children: [h.user, "@", h.host, ":", h.port] }), h.jumpHops.length > 0 ? (_jsxs("p", { children: ["ProxyJump: ", h.jumpHops.map((j) => `${j.user}@${j.host}:${j.port}`).join(' -> ')] })) : null, _jsx(Button, { variant: "primary", onClick: () => setActiveScreen('workspace'), children: "Connect" })] }, h.id))) }), _jsxs(Card, { children: [_jsx("h2", { children: "Import ~/.ssh/config" }), _jsx("textarea", { className: "ui-input", rows: 4, "aria-label": "SSH config content", value: sshConfigInput, onInput: (e) => setSshConfigInput(e.target.value) }), _jsx("div", { style: { marginTop: 'var(--space-2)' }, children: _jsx(Button, { variant: "primary", testId: "import-ssh-config-btn", onClick: () => {
                                                        hostRegistry.importSshConfig(sshConfigInput);
                                                        setHosts(hostRegistry.list());
                                                    }, children: "Import ~/.ssh/config" }) })] })] })) : null, activeScreen === 'files' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-files", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("h1", { children: "Dual-Pane SFTP File Manager" }), _jsxs(Badge, { tone: "neutral", testId: "storage-quota-badge", children: ["Storage Guard: ", quotaSnap.percentUsed, "% of 256 MiB cap (256 KiB chunks, SHA-256 verified)"] })] }), _jsx("input", { type: "search", className: "ui-input", placeholder: "Filter remote directory entries\u2026", value: fileFilter, onInput: (e) => setFileFilter(e.target.value), "aria-label": "Filter remote directory entries" }), _jsxs(Card, { children: [_jsx("p", { children: "Drop files or folders to upload to /srv/app (resumable .part atomic rename)" }), _jsx("ul", { children: sftpEntries.map((entry) => (_jsxs("li", { children: [_jsx("strong", { children: entry.isDir ? `[DIR] ${entry.name}` : entry.name }), " \u2014 ", entry.size, " bytes (", entry.mode, ")"] }, entry.path))) })] })] })) : null, activeScreen === 'editor' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-editor", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsx("h1", { children: "Remote File Editor \u2014 /etc/nginx/nginx.conf" }), _jsxs(Button, { variant: "primary", onClick: () => setEditorSaved(true), testId: "save-remote-file-btn", children: ["Save to host ", editorSaved ? '(Saved)' : '(Unsaved*)'] })] }), _jsx("textarea", { className: "ui-input", rows: 10, "aria-label": "Remote file content", value: editorContent, onInput: (e) => {
                                            setEditorContent(e.target.value);
                                            setEditorSaved(false);
                                        } })] })) : null, activeScreen === 'snippets' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-snippets", children: [_jsx("h1", { children: "Snippets & Asciicast v2 Session Replay" }), _jsx("div", { className: "webssh-grid", children: snippetLib.list().map((snip) => (_jsxs(Card, { children: [_jsx("strong", { children: snip.name }), _jsx("code", { children: snip.command }), _jsx(Button, { variant: "default", onClick: () => {
                                                        setTerminalLines((prev) => [...prev, `sre@edge-01:~$ ${snip.command}`]);
                                                        setActiveScreen('workspace');
                                                    }, children: "Run Snippet" })] }, snip.id))) }), _jsxs(Card, { children: [_jsxs("h2", { children: ["Session Replay Scrubber (", scrubberSec.toFixed(1), "s)"] }), _jsx("input", { type: "range", min: 0, max: 3, step: 0.5, value: scrubberSec, "aria-label": "Replay timeline scrubber", onInput: (e) => setScrubberSec(Number(e.target.value)) }), _jsx("pre", { children: scrubAsciicastOutput(demoCast.events, scrubberSec) })] })] })) : null, activeScreen === 'settings' ? (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-settings", children: [_jsx("h1", { children: "Preferences, Theme Gallery & Keybindings" }), _jsx(ComponentGallery, { activeTheme: activeTheme, onSelectTheme: (t) => setActiveTheme(t) }), _jsxs(Card, { children: [_jsx("h2", { children: "Theme Selector" }), _jsx("div", { style: { display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }, children: THEME_IDS.map((id) => (_jsx(Button, { variant: id === activeTheme ? 'primary' : 'default', onClick: () => setActiveTheme(id), testId: `theme-btn-${id}`, children: id }, id))) })] }), _jsxs(Card, { children: [_jsx("h2", { children: "Keybindings" }), _jsx("ul", { children: keybindings.list().map((kb) => (_jsxs("li", { children: [_jsxs("strong", { children: [kb.description, ":"] }), " ", _jsx("code", { children: kb.shortcut })] }, kb.actionId))) })] }), _jsxs(Card, { children: [_jsx("h2", { children: "Simulate Reconnect / Resilience States" }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)' }, children: [_jsx(Button, { variant: "default", testId: "sim-reconnecting-btn", onClick: () => {
                                                            setConnectionState('reconnecting');
                                                            setPendingInputBytes(128);
                                                        }, children: "Simulate Reconnecting" }), _jsx(Button, { variant: "default", testId: "sim-resumed-btn", onClick: () => {
                                                            setConnectionState('resumed');
                                                            setPendingInputBytes(0);
                                                        }, children: "Simulate Resumed" })] })] })] })) : null, !isFullscreen && !zenMode ? (_jsx("div", { className: "webssh-special-keys", role: "toolbar", "aria-label": "Mobile and Tablet Special Keys", children: SPECIAL_KEYS_ROW.map((keyLabel) => (_jsx(Button, { variant: "ghost", testId: `special-key-${keyLabel}`, children: keyLabel }, keyLabel))) })) : null] })] }), !isFullscreen && !zenMode ? (_jsxs("footer", { className: "webssh-statusbar", role: "contentinfo", "data-testid": "status-bar", children: [_jsx("span", { children: "RTT: 14 ms \u00B7 Throughput: 1.2 MB/s \u00B7 Cipher: chacha20-poly1305@openssh.com" }), _jsx("span", { children: "Remote Signer: WebCrypto Ed25519 \u00B7 Auto-attach tmux: main" })] })) : null, _jsxs(Modal, { open: paletteOpen, title: "Command Palette", onClose: () => setPaletteOpen(false), testId: "command-palette-modal", children: [_jsx("input", { type: "search", className: "ui-input", placeholder: "Type a command or search actions\u2026", value: paletteQuery, onInput: (e) => setPaletteQuery(e.target.value), "aria-label": "Command palette search", "data-testid": "command-palette-input" }), _jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', marginTop: 'var(--space-3)' }, children: paletteRegistry.search(paletteQuery).map((cmd) => (_jsxs(Button, { variant: "ghost", onClick: () => void cmd.run(), testId: `palette-cmd-${cmd.id}`, children: [_jsx("span", { children: cmd.title }), cmd.shortcut ? _jsx(Badge, { tone: "neutral", children: cmd.shortcut }) : null] }, cmd.id))) })] }), _jsxs(Modal, { open: hostKeyModal !== 'none', danger: hostKeyModal === 'mismatch', title: hostKeyModal === 'mismatch' ? 'WARNING: REMOTE HOST KEY CHANGED' : 'Verify Unknown Host Key (TOFU)', onClose: () => setHostKeyModal('none'), testId: "hostkey-modal", children: [_jsxs("p", { children: ["Host: ", _jsx("strong", { children: "edge-01.prod.internal:22" })] }), _jsxs("p", { children: ["SHA-256 Fingerprint: ", _jsx("code", { children: generatedFp })] }), hostKeyModal === 'mismatch' ? (_jsx("p", { children: "The host key does not match your pinned fingerprint. This could indicate a man-in-the-middle attack. Connection is blocked unless you explicitly override." })) : (_jsx("p", { children: "Trust on first use (TOFU) will pin this SHA-256 fingerprint in your browser store." })), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }, children: [_jsx(Button, { variant: hostKeyModal === 'mismatch' ? 'danger' : 'primary', onClick: () => setHostKeyModal('none'), testId: "hostkey-confirm-btn", children: hostKeyModal === 'mismatch' ? 'Explicit Override & Pin New Key' : 'Trust & Pin Host Key' }), _jsx(Button, { variant: "default", onClick: () => setHostKeyModal('none'), children: "Disconnect" })] })] })] }));
}
//# sourceMappingURL=App.js.map