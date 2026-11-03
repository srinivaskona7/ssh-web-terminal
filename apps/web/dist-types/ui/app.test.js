import { jsx as _jsx } from "preact/jsx-runtime";
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from 'preact';
import axe from 'axe-core';
import { App } from './App';
import { AppErrorBoundary, buildSafeDiagnosticReport, repairApplicationAssetCaches, sanitizeDiagnosticMessage } from './ErrorBoundary';
describe('App UI Shell Integration Suite (M4-M13)', () => {
    it('starts on clean minimal Welcome screen with zero mock data, exits Zen mode on Escape, supports simple Password & Private Key (chmod 0400) connection, and enables IDE mode on demand', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(_jsx(App, {}), container);
        // 1. Default screen is Welcome with minimal options and zero mock data
        const welcomeScreen = container.querySelector('[data-testid="screen-welcome"]');
        expect(welcomeScreen).toBeTruthy();
        const welcomeAxe = await axe.run(container, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
            rules: { 'color-contrast': { enabled: false } }
        });
        expect(welcomeAxe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.html).join(', ')})`)).toEqual([]);
        expect(welcomeScreen?.textContent).toContain('Welcome to WebSSH Studio');
        expect(container.querySelector('[data-testid="nav-features"]')).toBeNull();
        // 2. Enter Zen Mode and press Escape -> returns to Welcome screen with chrome restored
        const zenBtn = container.querySelector('[data-testid="toggle-zen-btn"]');
        zenBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="zen-mode-banner"]')?.textContent).toContain('Zen Mode Active — Press Esc to return');
        const rootEl = container.querySelector('[data-testid="workspace-root"]');
        rootEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="zen-mode-banner"]')).toBeNull();
        expect(container.querySelector('[data-testid="screen-welcome"]')).toBeTruthy();
        // 3. Test Private Key upload with chmod 0400 permission enforcement on Welcome screen
        const keyAuthBtn = container.querySelector('[data-testid="welcome-auth-keyfile-btn"]');
        keyAuthBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="private-key-chmod-badge"]')?.textContent).toContain('chmod 0400 (-r--------) Enforced');
        // Selecting 0644 blocks connection until Set chmod 400 is clicked
        const chmodSelect = container.querySelector('[data-testid="private-key-chmod-select"]');
        chmodSelect.value = '0644';
        chmodSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
        const welcomeConnectBtn = container.querySelector('[data-testid="welcome-connect-submit-btn"]');
        welcomeConnectBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="connect-error-badge"]')?.textContent).toContain('Permissions 0644 for private key are too open');
        // Click "Set chmod 400" to fix permissions to 0400
        const fixChmod400Btn = container.querySelector('[data-testid="apply-key-chmod-400-btn"]');
        fixChmod400Btn.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="private-key-chmod-badge"]')?.textContent).toContain('chmod 0400 (-r--------) Enforced');
        // 4. Switch to Terminal and test interactive shell, 17px default font size, and commands
        const navWorkspace = container.querySelector('[data-testid="nav-workspace"]');
        navWorkspace.click();
        await new Promise((r) => setTimeout(r, 10));
        const termViewport = container.querySelector('[data-testid="terminal-viewport"]');
        expect(termViewport.style.fontSize).toBe('17px');
        expect(termViewport.style.fontFamily).toContain('JetBrains Mono');
        const incBtn = container.querySelector('[data-testid="font-size-inc-btn"]');
        incBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(termViewport.style.fontSize).toBe('18px');
        const decBtn = container.querySelector('[data-testid="font-size-dec-btn"]');
        decBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(termViewport.style.fontSize).toBe('17px');
        // Type 'help' + Enter
        for (const ch of 'help') {
            termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        }
        termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
        expect(termViewport.textContent).toContain('Available local commands: connect <user@host>');
        // 5. Test 'connect root@10.0.0.5' command opening simple Connection modal
        for (const ch of 'connect root@10.0.0.5') {
            termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        }
        termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
        const connectModal = container.querySelector('[data-testid="connect-modal"]');
        expect(connectModal).toBeTruthy();
        expect(connectModal?.textContent).toContain('Username & Password');
        expect(connectModal?.textContent).toContain('Private Key (.pem / chmod 400)');
        const connectSubmit = container.querySelector('[data-testid="connect-modal-submit-btn"]');
        connectSubmit.click();
        await new Promise((r) => setTimeout(r, 10));
        const sessionTab = container.querySelector('[data-testid="tab-session-1"]');
        expect(sessionTab?.textContent).toContain('Terminal 1');
        expect(sessionTab?.textContent).toContain('root@10.0.0.5');
        // Verify Step 14 Studio Terminal UI, top bar controls, ASCII banner (zero copyrights), and colorful shell prompt
        expect(container.querySelector('[data-testid="terminal-studio-container"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="tab-separator"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="stop-red-square"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="popout-terminal-btn"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="more-options-menu-btn"]')).toBeTruthy();
        const asciiBanner = container.querySelector('[data-testid="terminal-ascii-banner"]');
        expect(asciiBanner?.textContent).toContain('Welcome to the WebSSH Studio Interactive Terminal.');
        expect(asciiBanner?.textContent).not.toContain('All rights reserved');
        expect(container.querySelector('[data-testid="prompt-username"]')?.textContent).toBe('root');
        expect(container.querySelector('[data-testid="prompt-hostname"]')?.textContent).toBe('10.0.0.5');
        expect(container.querySelector('[data-testid="prompt-directory"]')?.textContent).toBe('~');
        expect(container.querySelector('[data-testid="prompt-arrow"]')?.textContent).toContain('➜');
        const workspaceAxe = await axe.run(container, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
            rules: { 'color-contrast': { enabled: false } }
        });
        expect(workspaceAxe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
        const disconnectBtn = container.querySelector('[data-testid="disconnect-btn"]');
        disconnectBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        // 6. Enable IDE Mode to unlock the full navigation rail
        const enableIdeBtn = container.querySelector('[data-testid="toggle-ide-mode-btn"]');
        enableIdeBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(enableIdeBtn.textContent).toContain('IDE Mode: ON');
        const navFeatures = container.querySelector('[data-testid="nav-features"]');
        expect(navFeatures).toBeTruthy();
        navFeatures.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="screen-features"]')?.textContent).toContain('Capability matrix');
        expect(container.querySelector('[data-testid="capability-table"]')).toBeTruthy();
        document.body.removeChild(container);
    });
    it('exercises IDE Mode & Step 12 Advanced Feature Suite: Smart Shell (ghost autocomplete, safety guard, redaction, command blocks), Telemetry HUD, Port Tunnels, SFTP Chmod (0400), Diff, FIDO2/CA, and Fleet Playbooks', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(_jsx(App, {}), container);
        // Enable IDE Mode and switch to Terminal
        const toggleIdeBtn = container.querySelector('[data-testid="toggle-ide-mode-btn"]');
        toggleIdeBtn.click();
        const navWorkspace = container.querySelector('[data-testid="nav-workspace"]');
        navWorkspace.click();
        await new Promise((r) => setTimeout(r, 10));
        const viewport = container.querySelector('[data-testid="terminal-viewport"]');
        const sendKey = (key) => {
            viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        };
        // 1. Ghost-text autocomplete: type "tele" -> accept with Tab -> "telemetry"
        for (const ch of 'tele')
            sendKey(ch);
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="terminal-ghost-suggestion"]')?.textContent).toBe('metry');
        sendKey('Tab');
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="terminal-current-input"]')?.textContent).toBe('telemetry');
        for (let i = 0; i < 9; i++)
            sendKey('Backspace');
        // 2. Dangerous Command Safety Guard intercepts "rm -rf /"
        for (const ch of 'rm -rf /')
            sendKey(ch);
        sendKey('Enter');
        await new Promise((r) => setTimeout(r, 10));
        const dangerModal = container.querySelector('[data-testid="dangerous-command-modal"]');
        expect(dangerModal?.textContent).toContain('DANGEROUS COMMAND SAFETY GUARD');
        const cancelDangerBtn = container.querySelector('[data-testid="cancel-dangerous-cmd-btn"]');
        cancelDangerBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        // 3. Execute a safe command to create a Command Block and toggle Secret Redaction
        for (const ch of 'help')
            sendKey(ch);
        sendKey('Enter');
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="command-blocks-list"]')?.textContent).toContain('$ help');
        const redactBtn = container.querySelector('[data-testid="toggle-redaction-btn"]');
        redactBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(redactBtn.textContent).toContain('Redaction: ON');
        // 4. Port Tunnels & Custom Rule creation
        const navTunnels = container.querySelector('[data-testid="nav-tunnels"]');
        navTunnels.click();
        await new Promise((r) => setTimeout(r, 10));
        const addTunnelBtn = container.querySelector('[data-testid="add-tunnel-btn"]');
        addTunnelBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="screen-tunnels"]')?.textContent).toContain('Tunnel not started: connect to an SSH host first');
        // 5. SFTP Chmod Matrix (defaults to strict 0400 -r-------- for SSH keys) & Editor Side-by-Side Diff
        const navFiles = container.querySelector('[data-testid="nav-files"]');
        navFiles.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="chmod-octal-badge"]')?.textContent).toContain('0400 (-r--------)');
        const navEditor = container.querySelector('[data-testid="nav-editor"]');
        navEditor.click();
        await new Promise((r) => setTimeout(r, 10));
        const diffBtn = container.querySelector('[data-testid="toggle-diff-viewer-btn"]');
        diffBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="side-by-side-diff-card"]')?.textContent).toContain('Original Remote File');
        // 6. FIDO2 Hardware Key & SSH CA Certificate Viewer
        const navVault = container.querySelector('[data-testid="nav-vault"]');
        navVault.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="fido2-hardware-card"]')?.textContent).toContain('Browsers cannot create OpenSSH FIDO2 keys');
        document.body.removeChild(container);
    });
    it('keeps relay internals in administrator settings and asks for a product sign-in instead', async () => {
        localStorage.setItem('webssh.transport.mode', 'cloudflare-relay');
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(_jsx(App, {}), container);
        // Sign-in is the visible step; the endpoint, token and transport picker are not.
        const signIn = container.querySelector('[data-testid="product-sign-in"]');
        expect(signIn).toBeTruthy();
        expect(signIn?.textContent).toContain('Sign in');
        expect(container.querySelector('[data-testid="product-sign-in-user"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="product-sign-in-pass"]')).toBeTruthy();
        const admin = container.querySelector('[data-testid="admin-transport-settings"]');
        expect(admin).toBeTruthy();
        expect(admin.open).toBe(false);
        expect(admin.querySelector('[data-testid="welcome-gateway-url-input"]')).toBeTruthy();
        expect(admin.querySelector('[data-testid="welcome-transport-mode-select"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="welcome-gateway-url-input"]')).toBe(admin.querySelector('[data-testid="welcome-gateway-url-input"]'));
        // Connecting without a session is refused locally with an actionable message.
        const host = container.querySelector('[data-testid="welcome-host-input"]');
        host.value = '10.0.0.5';
        host.dispatchEvent(new Event('input', { bubbles: true }));
        const form = container.querySelector('[data-testid="welcome-quick-connect-card"] form');
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 10));
        expect(container.textContent).toContain('Sign in to WebSSH Studio first');
        document.body.removeChild(container);
        localStorage.removeItem('webssh.transport.mode');
        sessionStorage.clear();
    });
    it('renders AppErrorBoundary fallback with Retry, targeted cache repair, and secret-safe diagnostics while preserving localStorage', async () => {
        localStorage.setItem('webssh.hosts.v1', JSON.stringify([{ id: 'h-keep', alias: 'keep-host', host: '10.0.0.9', port: 22, user: 'ubuntu', tags: [], favorite: true, jumpHops: [] }]));
        localStorage.setItem('webssh.preferences.v2', JSON.stringify({
            schemaVersion: 2,
            activeThemeId: 'non-existent-corrupted-theme',
            typography: { fontFamily: 'JetBrains Mono', fontSize: null }
        }));
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(_jsx(App, {}), container);
        // Verify shell renders even with invalid activeThemeId in localStorage and preserves saved host
        expect(container.querySelector('[data-testid="workspace-root"]')).toBeTruthy();
        const toggleIdeBtn = container.querySelector('[data-testid="toggle-ide-mode-btn"]');
        toggleIdeBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        const navHosts = container.querySelector('[data-testid="nav-hosts"]');
        navHosts.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="screen-hosts"]')?.textContent).toContain('keep-host');
        // Verify secret-safe diagnostic sanitizer strips private keys, tokens, and passwords
        const unsafeMsg = 'Startup failed with token=ghp_1234567890abcdefghijklmnopqrstuvwx and -----BEGIN OPENSSH PRIVATE KEY----- AAAA secret=my-secret-pass';
        const sanitized = sanitizeDiagnosticMessage(unsafeMsg);
        expect(sanitized).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwx');
        expect(sanitized).not.toContain('my-secret-pass');
        expect(sanitized).not.toContain('BEGIN OPENSSH PRIVATE KEY');
        const report = buildSafeDiagnosticReport(new Error(unsafeMsg));
        expect(report.reason).not.toContain('my-secret-pass');
        // Verify repairApplicationAssetCaches preserves localStorage
        await repairApplicationAssetCaches();
        expect(localStorage.getItem('webssh.hosts.v1')).toContain('keep-host');
        // Verify AppErrorBoundary catches render errors and recovers on Retry
        let shouldThrow = true;
        function FlakyChild() {
            if (shouldThrow) {
                throw new Error('Simulated transient component error password=supersecret');
            }
            return _jsx("div", { "data-testid": "recovered-child", children: "Recovered Content" });
        }
        const boundaryContainer = document.createElement('div');
        document.body.appendChild(boundaryContainer);
        render(_jsx(AppErrorBoundary, { children: _jsx(FlakyChild, {}) }), boundaryContainer);
        await new Promise((r) => setTimeout(r, 10));
        const fallback = boundaryContainer.querySelector('[data-testid="error-boundary-fallback"]');
        expect(fallback).toBeTruthy();
        expect(fallback?.textContent).not.toContain('supersecret');
        shouldThrow = false;
        const retryBtn = boundaryContainer.querySelector('[data-testid="error-boundary-retry-btn"]');
        retryBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(boundaryContainer.querySelector('[data-testid="recovered-child"]')?.textContent).toBe('Recovered Content');
        document.body.removeChild(container);
        document.body.removeChild(boundaryContainer);
    });
    it('executes real SSH commands over WebSocket when connected and rejects fake execution when disconnected', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(_jsx(App, {}), container);
        // 1. Switch to terminal while disconnected and run uname -s -> must NOT fake success
        const openTermBtn = container.querySelector('[data-testid="welcome-open-terminal-btn"]');
        openTermBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        const viewport = container.querySelector('[data-testid="terminal-viewport"]');
        for (const ch of 'uname -s') {
            viewport.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        }
        viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 15));
        expect(viewport.textContent).toContain('Not connected to an SSH server');
        expect(viewport.textContent).not.toContain('Executed remote/shell command');
        // 2. Connect via New Connection modal with GitHub Pages URL -> must reject immediately
        const newConnBtn = container.querySelector('[data-testid="new-connection-btn"]');
        newConnBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        const gwInput = container.querySelector('[data-testid="gateway-url-input"]');
        gwInput.value = 'wss://srinivaskona7.github.io/ws';
        gwInput.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
        const submitBtn = container.querySelector('[data-testid="connect-modal-submit-btn"]');
        submitBtn.click();
        await new Promise((r) => setTimeout(r, 15));
        expect(container.querySelector('[data-testid="modal-connect-error-badge"]')?.textContent).toContain('GitHub Pages');
        // Restore valid local gateway URL and test wrong password -> must stay Disconnected without false tab title
        gwInput.value = 'ws://127.0.0.1:8080/ws';
        gwInput.dispatchEvent(new Event('input', { bubbles: true }));
        const passInput = container.querySelector('[data-testid="connect-password-input"]');
        passInput.value = 'wrong-password';
        passInput.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
        submitBtn.click();
        await new Promise((r) => setTimeout(r, 25));
        expect(container.querySelector('[data-testid="modal-connect-error-badge"]')?.textContent).toContain('SSH_CONNECT_FAILED');
        expect(container.querySelector('[data-testid="tab-session-1"]')?.textContent).not.toContain('ubuntu@127.0.0.1');
        // 3. Connect with valid credentials -> transitions to Connected and runs real uname -s -> Linux
        passInput.value = 'testpass123';
        passInput.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
        submitBtn.click();
        await new Promise((r) => setTimeout(r, 30));
        expect(container.querySelector('[data-testid="tab-session-1"]')?.textContent).toContain('ubuntu@127.0.0.1');
        const termViewport = container.querySelector('[data-testid="terminal-viewport"]');
        for (const ch of 'uname -s') {
            termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        }
        termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 25));
        expect(termViewport.textContent).toContain('Linux');
        // 4. Open second tab while connected -> allocates secondary PTY channel
        const addTabBtn = container.querySelector('[data-testid="add-tab-btn"]');
        addTabBtn.click();
        await new Promise((r) => setTimeout(r, 20));
        expect(container.querySelector('[data-testid="tab-session-2"]')?.textContent).toContain('Terminal 2 (ubuntu@127.0.0.1)');
        document.body.removeChild(container);
    });
});
//# sourceMappingURL=app.test.js.map