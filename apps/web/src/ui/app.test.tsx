// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from 'preact';
import { App, FIFTY_FEATURES_CATALOG } from './App';

describe('App UI Shell Integration Suite (M4-M8)', () => {
  it('renders macOS title bar & menu bar, capsule tabs, 17px default font size, interactive terminal, Argon2id modal, and 50-feature workbench', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);

    expect(FIFTY_FEATURES_CATALOG.length).toBe(50);

    const workspaceRoot = container.querySelector('[data-testid="workspace-root"]');
    expect(workspaceRoot).toBeTruthy();

    // 1. Verify macOS Window Title Bar & Native Menu Bar
    const titlebar = container.querySelector('[data-testid="macos-titlebar"]');
    expect(titlebar).toBeTruthy();
    expect(container.querySelector('[data-testid="traffic-light-close"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="traffic-light-minimize"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="traffic-light-fullscreen"]')).toBeTruthy();

    const winTitle = container.querySelector('[data-testid="macos-window-title"]');
    expect(winTitle?.textContent).toContain('terminal — ...srinew/terminal — -zsh — 80x24');

    // Open Terminal menu and click Split Terminal
    const menuTerminalBtn = container.querySelector('[data-testid="menu-terminal-btn"]') as HTMLButtonElement;
    menuTerminalBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    const menuDropdown = container.querySelector('[data-testid="menu-terminal-dropdown"]');
    expect(menuDropdown?.textContent).toContain('New Tab');
    expect(menuDropdown?.textContent).toContain('Split Terminal');
    expect(menuDropdown?.textContent).toContain('Disconnect');

    // 2. Verify macOS / VS Code Capsule Tab Strip (+ and ×)
    const addTabBtn = container.querySelector('[data-testid="add-tab-btn"]') as HTMLButtonElement;
    addTabBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    const secondTab = container.querySelector('[data-testid="tab-session-2"]');
    expect(secondTab?.textContent).toContain('...srinew/terminal — -zsh (2)');

    // 3. Verify Top-Right Quick Customization Toolbar (Font Family & 17px A-/A+)
    const fontSelect = container.querySelector('[data-testid="font-family-select"]') as HTMLSelectElement;
    expect(fontSelect.textContent).toContain('SF Mono');
    expect(fontSelect.textContent).toContain('JetBrains Mono');
    expect(fontSelect.textContent).toContain('Fira Code');
    expect(fontSelect.textContent).toContain('Menlo');
    expect(fontSelect.textContent).toContain('Monaco');

    const termViewport = container.querySelector('[data-testid="terminal-viewport"]') as HTMLElement;
    expect(termViewport.textContent).toContain('WebSSH Studio v1.0.0');
    expect(termViewport.textContent).toContain("Type 'help' for local commands or click 'New Connection' to authenticate.");
    expect(termViewport.textContent).toContain('webssh:~$ ');
    expect(termViewport.style.fontSize).toBe('17px');
    expect(termViewport.style.fontFamily).toContain('JetBrains Mono');

    const fontBadge = container.querySelector('.font-size-badge');
    expect(fontBadge?.textContent).toBe('17px');

    const incBtn = container.querySelector('[data-testid="font-size-inc-btn"]') as HTMLButtonElement;
    expect(incBtn.textContent).toBe('A+');
    incBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(fontBadge?.textContent).toBe('18px');
    expect(termViewport.style.fontSize).toBe('18px');

    const decBtn = container.querySelector('[data-testid="font-size-dec-btn"]') as HTMLButtonElement;
    expect(decBtn.textContent).toBe('A-');
    decBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(fontBadge?.textContent).toBe('17px');

    // 4. Interactive terminal keyboard input: type 'help' + Backspace + 'p' + Enter
    for (const ch of ['h', 'e', 'l', 'x']) {
      termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    }
    termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="terminal-current-input"]')?.textContent).toBe('help');

    termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(termViewport.textContent).toContain('Available local commands: connect <user@host>, pubkey, font <size>, clear, vault');

    // Test command history ArrowUp / ArrowDown
    termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="terminal-current-input"]')?.textContent).toBe('help');
    termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="terminal-current-input"]')?.textContent).toBe('');

    // Test 'font 20' command
    for (const ch of 'font 20') {
      termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    }
    termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(termViewport.style.fontSize).toBe('20px');

    // Test 'pubkey' command
    for (const ch of 'pubkey') {
      termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    }
    termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(termViewport.textContent).toContain('ssh-ed25519');

    // Test 'clear' command
    for (const ch of 'clear') {
      termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    }
    termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(termViewport.textContent).not.toContain('WebSSH Studio v1.0.0');

    // 5. Test 'connect root@10.0.0.5' command opening Argon2id Auth modal with pre-filled credentials
    for (const ch of 'connect root@10.0.0.5') {
      termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    }
    termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));

    const connectModal = container.querySelector('[data-testid="connect-modal"]');
    expect(connectModal).toBeTruthy();
    expect(connectModal?.textContent).toContain('Argon2id Ed25519 Key');
    expect(connectModal?.textContent).toContain('Password');

    const hostInput = container.querySelector('[data-testid="connect-host-input"]') as HTMLInputElement;
    const userInput = container.querySelector('[data-testid="connect-user-input"]') as HTMLInputElement;
    const portInput = container.querySelector('[data-testid="connect-port-input"]') as HTMLInputElement;
    expect(hostInput.value).toBe('10.0.0.5');
    expect(userInput.value).toBe('root');
    expect(portInput.value).toBe('22');

    // Submit connection modal and verify tab updates to root@10.0.0.5 and Disconnect button is rendered
    const connectSubmit = container.querySelector('[data-testid="connect-modal-submit-btn"]') as HTMLButtonElement;
    connectSubmit.click();
    await new Promise((r) => setTimeout(r, 10));

    const sessionTab = container.querySelector('[data-testid="tab-session-1"]');
    expect(sessionTab?.textContent).toContain('root@10.0.0.5');

    const disconnectBtn = container.querySelector('[data-testid="disconnect-btn"]') as HTMLButtonElement;
    expect(disconnectBtn).toBeTruthy();
    disconnectBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="new-connection-btn"]')).toBeTruthy();

    // Open 50-Feature Workbench and execute a feature interactively
    const navFeatures = container.querySelector('[data-testid="nav-features"]') as HTMLButtonElement;
    navFeatures.click();
    await new Promise((r) => setTimeout(r, 10));

    const featuresScreen = container.querySelector('[data-testid="screen-features"]');
    expect(featuresScreen?.textContent).toContain('All 50 Features — Interactive Selector & Workbench');

    const runFeature10 = container.querySelector('[data-testid="run-feature-10"]') as HTMLButtonElement;
    runFeature10.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="terminal-split-pane-2"]')).toBeTruthy();

    // Toggle immersive full-screen mode (uses 100dvh pseudo-fullscreen fallback in jsdom)
    const fsBtn = container.querySelector('[data-testid="toggle-fullscreen-btn"]') as HTMLButtonElement;
    fsBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    const toast = container.querySelector('[data-testid="fullscreen-toast"]');
    expect(toast?.textContent).toContain('Press F11 or Esc to exit');

    // Hover top zone to reveal auto-hiding overlay bar
    const hoverZone = container.querySelector('[data-testid="fullscreen-top-hover-zone"]') as HTMLElement;
    expect(hoverZone).toBeTruthy();
    hoverZone.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));

    const exitBtn = container.querySelector('[data-testid="overlay-exit-fullscreen-btn"]') as HTMLButtonElement;
    expect(exitBtn).toBeTruthy();
    exitBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    // Navigate to Hosts screen and import ~/.ssh/config
    const navHosts = container.querySelector('[data-testid="nav-hosts"]') as HTMLButtonElement;
    navHosts.click();
    await new Promise((r) => setTimeout(r, 10));

    const importBtn = container.querySelector('[data-testid="import-ssh-config-btn"]') as HTMLButtonElement;
    importBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    const importedHostCard = container.querySelector('[data-testid="host-card-staging-web"]');
    expect(importedHostCard?.textContent).toContain('deploy@10.10.4.12:2222');

    // Trigger red blocking KEY CHANGED modal
    const mismatchBtn = container.querySelector('[data-testid="trigger-mismatch-modal-btn"]') as HTMLButtonElement;
    mismatchBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    const hostKeyModal = container.querySelector('[data-testid="hostkey-modal"]');
    expect(hostKeyModal?.textContent).toContain('WARNING: REMOTE HOST KEY CHANGED');

    const confirmHostKey = container.querySelector('[data-testid="hostkey-confirm-btn"]') as HTMLButtonElement;
    confirmHostKey.click();
    await new Promise((r) => setTimeout(r, 10));

    // Open Command Palette and navigate to SFTP Files
    const openPaletteBtn = container.querySelector('[data-testid="open-palette-btn"]') as HTMLButtonElement;
    openPaletteBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    const filesCmd = container.querySelector('[data-testid="palette-cmd-nav.files"]') as HTMLButtonElement;
    filesCmd.click();
    await new Promise((r) => setTimeout(r, 10));

    const filesScreen = container.querySelector('[data-testid="screen-files"]');
    expect(filesScreen?.textContent).toContain('Dual-Pane SFTP File Manager');

    document.body.removeChild(container);
  });
});
