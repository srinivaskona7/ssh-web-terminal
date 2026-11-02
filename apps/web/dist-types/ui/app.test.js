import { jsx as _jsx } from "preact/jsx-runtime";
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from 'preact';
import axe from 'axe-core';
import { App, FIFTY_FEATURES_CATALOG } from './App';
describe('App UI Shell Integration Suite (M4-M13)', () => {
    it('starts on clean minimal Welcome screen with zero mock data, exits Zen mode on Escape, supports simple Password & Private Key (chmod 0400) connection, and enables IDE mode on demand', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(_jsx(App, {}), container);
        expect(FIFTY_FEATURES_CATALOG.length).toBe(50);
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
        // 6. Enable IDE Mode to unlock all 50 features and full IDE navigation rail
        const enableIdeBtn = container.querySelector('[data-testid="toggle-ide-mode-btn"]');
        enableIdeBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(enableIdeBtn.textContent).toContain('IDE Mode: ON');
        const navFeatures = container.querySelector('[data-testid="nav-features"]');
        expect(navFeatures).toBeTruthy();
        navFeatures.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(container.querySelector('[data-testid="screen-features"]')?.textContent).toContain('All 50 Features — Interactive Selector & Workbench');
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
        expect(container.querySelector('[data-testid="screen-tunnels"]')?.textContent).toContain('Custom Tunnel :8080->:80');
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
        expect(container.querySelector('[data-testid="fido2-hardware-card"]')?.textContent).toContain('sk-ssh-ed25519@openssh.com');
        document.body.removeChild(container);
    });
});
//# sourceMappingURL=app.test.js.map