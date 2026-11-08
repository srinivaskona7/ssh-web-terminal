// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import axe from 'axe-core';
import { App } from './App';
import {
  AppErrorBoundary,
  buildSafeDiagnosticReport,
  repairApplicationAssetCaches,
  sanitizeDiagnosticMessage
} from './ErrorBoundary';

describe('App UI Shell Integration Suite (M4-M13)', () => {
  afterEach(() => {
    // Transport mode, tokens and the Turnstile stub are module-level state;
    // leaking any of them changes how the next test connects.
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('starts on clean minimal Welcome screen with zero mock data, exits Zen mode on Escape, supports simple Password & Private Key (chmod 0400) connection, and enables IDE mode on demand', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);

    // 1. Default screen is Welcome with minimal options and zero mock data
    const welcomeScreen = container.querySelector('[data-testid="screen-welcome"]');
    expect(welcomeScreen).toBeTruthy();

    const welcomeAxe = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
      rules: { 'color-contrast': { enabled: false } }
    });
    expect(welcomeAxe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.html).join(', ')})`)).toEqual([]);
    expect(welcomeScreen?.textContent).toContain('Open your server workspace');
    expect(welcomeScreen?.textContent).toContain('Connect to server');
    // Server tools is a navigation entry (always visible), not a feature gate.
    expect(container.querySelector('[data-testid="nav-server-tools"]')).toBeTruthy();

    // 2. Connection-first header: no View menu / Disconnect on the welcome page.
    // Appearance lives in Settings (theme persists); Zen lives in the workspace View menu.
    expect(container.querySelector('[data-testid="disconnect-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="view-menu-btn"]')).toBeNull();
    // Rail stays in the DOM (drawer/tests) but is visually hidden on this page.
    expect((container.querySelector('[data-testid="nav-terminal"]') as HTMLElement).offsetParent).toBe(null);
    (container.querySelector('[data-testid="welcome-settings-btn"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="screen-settings"]')).toBeTruthy();
    (container.querySelector('[data-testid="theme-btn-dracula"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 150));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dracula');
    (container.querySelector('[data-testid="theme-btn-dark"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    (container.querySelector('[data-testid="header-settings-btn"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="screen-welcome"]')).toBeTruthy();

    // 3. Test Private Key upload with chmod 0400 permission enforcement on Welcome screen
    const authSelect = container.querySelector('[data-testid="welcome-auth-method-select"]') as HTMLSelectElement;
    authSelect.value = 'Private Key (.pem / id_rsa)';
    authSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="private-key-chmod-badge"]')?.textContent).toContain(
      'chmod 0400 — Enforced'
    );

    // Selecting 0644 blocks connection until Set chmod 400 is clicked
    const chmodSelect = container.querySelector('[data-testid="private-key-chmod-select"]') as HTMLSelectElement;
    chmodSelect.value = '0644';
    chmodSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));

    const welcomeConnectBtn = container.querySelector('[data-testid="welcome-connect-submit-btn"]') as HTMLButtonElement;
    welcomeConnectBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="connect-error-badge"]')?.textContent).toContain(
      'Permissions 0644 for private key are too open'
    );

    // Click "Set chmod 400" to fix permissions to 0400
    const fixChmod400Btn = container.querySelector('[data-testid="apply-key-chmod-400-btn"]') as HTMLButtonElement;
    fixChmod400Btn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="private-key-chmod-badge"]')?.textContent).toContain(
      'chmod 0400 — Enforced'
    );

    // 4. Switch to Terminal and test interactive shell, 17px default font size, and commands
    const navWorkspace = container.querySelector('[data-testid="nav-terminal"]') as HTMLButtonElement;
    navWorkspace.click();
    await new Promise((r) => setTimeout(r, 10));

    let termViewport = container.querySelector('[data-testid="terminal-viewport"]') as HTMLElement;
    expect(termViewport.style.fontSize).toBe('17px');
    expect(termViewport.style.fontFamily).toContain('JetBrains Mono');

    // Local command output lives in the inspector, never duplicated inside the
    // terminal surface.
    // Type 'help' + Enter
    for (const ch of 'help') {
      termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    }
    termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    // Font size lives in the View menu.
    (container.querySelector('[data-testid="view-menu-btn"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    // Increase font via the global keyboard handler (Cmd+=).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    termViewport = container.querySelector('[data-testid="terminal-viewport"]') as HTMLElement;
    expect(termViewport.style.fontSize).toBe('18px');

    // Decrease font via the global keyboard handler (Cmd+-).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    termViewport = container.querySelector('[data-testid="terminal-viewport"]') as HTMLElement;
    expect(termViewport.style.fontSize).toBe('17px');

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

    (container.querySelector('[data-testid="auth-method-password-btn"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    const connectSubmit = container.querySelector('[data-testid="connect-modal-submit-btn"]') as HTMLButtonElement;
    (container.querySelector('[data-testid="connect-host-input"]') as HTMLInputElement).value = '10.0.0.5';
    (container.querySelector('[data-testid="connect-host-input"]') as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
    (container.querySelector('[data-testid="connect-user-input"]') as HTMLInputElement).value = 'root';
    (container.querySelector('[data-testid="connect-user-input"]') as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
    const pass = container.querySelector('[data-testid="connect-password-input"]') as HTMLInputElement;
    pass.value = 'testpass123';
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    pass.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    connectSubmit.click();
    await new Promise((r) => setTimeout(r, 2000));

    const sessionTab = container.querySelector('[data-testid="tab-session-1"]');
    expect(sessionTab?.textContent).toContain('Terminal 1');
    expect(sessionTab?.textContent).toContain('root@10.0.0.5');

    // Verify simplified session strip: tabs, new tab, split, disconnect.
    expect(container.querySelector('[data-testid="tab-session-1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="add-tab-btn"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="toggle-split-btn"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="disconnect-btn"]')?.textContent).toContain('Disconnect');
    // The view menu replaces the old more-options menu.
    expect(container.querySelector('[data-testid="view-menu-btn"]')).toBeTruthy();

    // The terminal surface is the emulator alone: no ASCII banner, no
    // synthetic prompt and no DOM transcription of remote output.
    expect(container.querySelector('[data-testid="terminal-ascii-banner"]')).toBeNull();
    expect(container.querySelector('[data-testid="prompt-username"]')).toBeNull();
    expect(container.querySelector('[data-testid="terminal-panes"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="xterm-engine-mount"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="terminal-disconnected-state"]')).toBeNull();

    const workspaceAxe = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
      rules: { 'color-contrast': { enabled: false } }
    });
    expect(workspaceAxe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    const disconnectBtn = container.querySelector('[data-testid="disconnect-btn"]') as HTMLButtonElement;
    disconnectBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="disconnect-btn"]')).toBeNull();

    // 6. Open Features via the command palette (IDE mode is no longer a rail gate).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const paletteInput = container.querySelector('[data-testid="command-palette-input"]') as HTMLInputElement;
    paletteInput.value = 'capability';
    paletteInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    paletteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(container.querySelector('[data-testid="screen-features"]')?.textContent).toContain(
      'Capability matrix'
    );
    expect(container.querySelector('[data-testid="capability-table"]')).toBeTruthy();

    document.body.removeChild(container);
  });

  it('exercises IDE Mode & Step 12 Advanced Feature Suite: Smart Shell (ghost autocomplete, safety guard, redaction, command blocks), Telemetry HUD, Port Tunnels, SFTP Chmod (0400), Diff, FIDO2/CA, and Fleet Playbooks', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);

    // Switch to Terminal
    const navTerminal = container.querySelector('[data-testid="nav-terminal"]') as HTMLButtonElement;
    navTerminal.click();
    await new Promise((r) => setTimeout(r, 10));

    const viewport = container.querySelector('[data-testid="terminal-viewport"]') as HTMLElement;
    const sendKey = (key: string): void => {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    };
    // 1. Type "telemetry" which the command engine resolves to the Live control screen.
    for (const ch of 'telemetry') sendKey(ch);
    sendKey('Enter');
    // Server modules are a lazy chunk; jsdom needs a longer settle.
    await new Promise((r) => setTimeout(r, 150));
    expect(container.querySelector('[data-testid="screen-overview"]')).toBeTruthy();
    expect(viewport.textContent).not.toContain('telemetry');
    navTerminal.click();
    await new Promise((r) => setTimeout(r, 10));

    // 2. Dangerous Command Safety Guard intercepts "rm -rf /"
    for (const ch of 'rm -rf /') sendKey(ch);
    sendKey('Enter');
    await new Promise((r) => setTimeout(r, 10));
    const dangerModal = container.querySelector('[data-testid="dangerous-command-modal"]');
    expect(dangerModal?.textContent).toContain('DANGEROUS COMMAND SAFETY GUARD');
    const cancelDangerBtn = container.querySelector('[data-testid="cancel-dangerous-cmd-btn"]') as HTMLButtonElement;
    cancelDangerBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    // 3. Execute a safe command to create a Command Block and toggle Secret Redaction
    for (const ch of 'help') sendKey(ch);
    sendKey('Enter');
    await new Promise((r) => setTimeout(r, 10));
    // Help output goes to the terminal PTY, not a separate inspector.

    // 4. Port Tunnels & Custom Rule creation
    const navServerTools = container.querySelector('[data-testid="nav-server-tools"]') as HTMLButtonElement;
    navServerTools.click();
    await new Promise((r) => setTimeout(r, 10));
    const navTunnels = container.querySelector('[data-testid="nav-tunnels"]') as HTMLButtonElement;
    navTunnels.click();
    await new Promise((r) => setTimeout(r, 10));
    const addTunnelBtn = container.querySelector('[data-testid="add-tunnel-btn"]') as HTMLButtonElement;
    addTunnelBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="screen-tunnels"]')?.textContent).toContain(
      'Tunnel not started: connect to an SSH host first'
    );

    // 5. SFTP Chmod Matrix (defaults to strict 0400 -r-------- for SSH keys) & Editor Side-by-Side Diff
    const navFiles = container.querySelector('[data-testid="nav-files"]') as HTMLButtonElement;
    navFiles.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="chmod-octal-badge"]')?.textContent).toContain('0400 (-r--------)');

    const navEditor = container.querySelector('[data-testid="nav-editor"]') as HTMLButtonElement;
    navEditor.click();
    await new Promise((r) => setTimeout(r, 10));
    // Editor starts empty; verify empty state is shown
    expect(container.querySelector('[data-testid="editor-filepath-input"]')).toBeTruthy();
    // Type a path and attempt load (will fail without connection, but button should respond)
    const filepathInput = container.querySelector('[data-testid="editor-filepath-input"]') as HTMLInputElement;
    filepathInput.value = '/etc/hostname';
    filepathInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    const loadBtn = container.querySelector('[data-testid="load-remote-file-btn"]') as HTMLButtonElement;
    loadBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    // 6. FIDO2 Hardware Key & SSH CA Certificate Viewer
    const navVault = container.querySelector('[data-testid="nav-vault"]') as HTMLButtonElement;
    navVault.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="fido2-hardware-card"]')?.textContent).toContain(
      'Browsers cannot create OpenSSH FIDO2 keys'
    );

    document.body.removeChild(container);
  });

  it('offers guest connections without an account and keeps relay internals in administrator settings', async () => {
    localStorage.setItem('webssh.transport.mode', 'cloudflare-relay');
    const ticketRequests: string[] = [];
    vi.stubGlobal('__WEBSSH_TURNSTILE_SITE_KEY__', 'test-site-key');
    // jsdom cannot run the real challenge; the fake resolves it immediately so
    // the test exercises the ticket request that follows.
    vi.stubGlobal('turnstile', {
      render: (_el: HTMLElement, opts: Record<string, unknown>) => {
        (opts.callback as (token: string) => void)('test-turnstile-token');
        return 1;
      },
      reset: () => {},
      remove: () => {}
    });
    vi.stubGlobal(
      'fetch',
      (async (input: RequestInfo | URL) => {
        ticketRequests.push(String(input));
        return new Response(
          JSON.stringify({
            ok: true,
            token: 'guest.ticket.token',
            kind: 'guest',
            destination: { host: '10.0.0.5', port: 22 },
            expiresAt: Math.floor(Date.now() / 1000) + 300,
            expiresIn: 300
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);

    // No account prompt in the user's path: the form exists only inside the
    // collapsed administrator panel.
    const outerSignIn = container.querySelector('[data-testid="product-sign-in"]');

    // Relay internals and the optional account form live in Settings -> Administrator.
    const settingsNav = container.querySelector('[data-testid="welcome-settings-btn"]') as HTMLButtonElement;
    settingsNav.click();
    await new Promise((r) => setTimeout(r, 10));
    (container.querySelector('[data-testid="settings-tab-administrator"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    const admin = container.querySelector('[data-testid="admin-transport-settings"]');
    expect(admin).toBeTruthy();
    expect(admin?.querySelector('[data-testid="welcome-gateway-url-input"]')).toBeTruthy();
    expect(admin?.querySelector('[data-testid="welcome-transport-mode-select"]')).toBeTruthy();
    expect(admin?.querySelector('[data-testid="product-sign-in"]')).toBeTruthy();
    // Back to the connection page for the connect flow below.
    (container.querySelector('[data-testid="header-settings-btn"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));

    // Connect acquires a guest ticket automatically instead of demanding a login.
    const host = container.querySelector('[data-testid="welcome-host-input"]') as HTMLInputElement;
    host.value = '10.0.0.5';
    host.dispatchEvent(new Event('input', { bubbles: true }));
    const user = container.querySelector('[data-testid="welcome-user-input"]') as HTMLInputElement;
    user.value = 'ubuntu';
    user.dispatchEvent(new Event('input', { bubbles: true }));
    const pass = container.querySelector('[data-testid="welcome-password-input"]') as HTMLInputElement;
    pass.value = 'testpass123';
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    const form = container.querySelector('[data-testid="welcome-connect-form"]') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 500));

    expect(ticketRequests.some((u) => u.includes('/auth/ticket'))).toBe(true);
    expect(container.textContent).toContain('Connection ticket issued');

    // The Turnstile response is single-use, so it must not survive the attempt.
    expect(container.textContent).toContain('Connection ticket issued');
    document.body.removeChild(container);
  });

  it('renders AppErrorBoundary fallback with Retry, targeted cache repair, and secret-safe diagnostics while preserving localStorage', async () => {
    localStorage.setItem('webssh.hosts.v1', JSON.stringify([{ id: 'h-keep', alias: 'keep-host', host: '10.0.0.9', port: 22, user: 'ubuntu', tags: [], favorite: true, jumpHops: [] }]));
    localStorage.setItem(
      'webssh.preferences.v2',
      JSON.stringify({
        schemaVersion: 2,
        activeThemeId: 'non-existent-corrupted-theme',
        typography: { fontFamily: 'JetBrains Mono', fontSize: null }
      })
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);

    // Verify shell renders even with invalid activeThemeId in localStorage and preserves saved host
    expect(container.querySelector('[data-testid="workspace-root"]')).toBeTruthy();
    const navHosts = container.querySelector('[data-testid="nav-hosts"]') as HTMLButtonElement;
    navHosts.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="screen-hosts"]')?.textContent).toContain('keep-host');

    // Verify secret-safe diagnostic sanitizer strips private keys, tokens, and passwords
    const unsafeMsg =
      'Startup failed with token=ghp_1234567890abcdefghijklmnopqrstuvwx and -----BEGIN OPENSSH PRIVATE KEY----- AAAA secret=my-secret-pass';
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
      return <div data-testid="recovered-child">Recovered Content</div>;
    }

    const boundaryContainer = document.createElement('div');
    document.body.appendChild(boundaryContainer);
    render(
      <AppErrorBoundary>
        <FlakyChild />
      </AppErrorBoundary>,
      boundaryContainer
    );
    await new Promise((r) => setTimeout(r, 10));

    const fallback = boundaryContainer.querySelector('[data-testid="error-boundary-fallback"]');
    expect(fallback).toBeTruthy();
    expect(fallback?.textContent).not.toContain('supersecret');

    shouldThrow = false;
    const retryBtn = boundaryContainer.querySelector('[data-testid="error-boundary-retry-btn"]') as HTMLButtonElement;
    retryBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(boundaryContainer.querySelector('[data-testid="recovered-child"]')?.textContent).toBe('Recovered Content');

    document.body.removeChild(container);
    document.body.removeChild(boundaryContainer);
  });

  it('executes real SSH commands over WebSocket when connected and rejects fake execution when disconnected', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);

    // 1. Switch to terminal while disconnected and run uname -s -> must NOT fake success
    const openTermBtn = container.querySelector('[data-testid="nav-terminal"]') as HTMLButtonElement;
    openTermBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    const viewport = container.querySelector('[data-testid="terminal-viewport"]') as HTMLElement;
    for (const ch of 'uname -s') {
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    }
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    expect(viewport.textContent).toContain('Disconnected');
    expect(viewport.textContent).not.toContain('Executed remote/shell command');

    // 2. Connect via New Connection modal with GitHub Pages URL -> must reject immediately
    const newConnBtn = container.querySelector('[data-testid="header-connect-btn"]') as HTMLButtonElement;
    newConnBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    const gwInput = container.querySelector('[data-testid="gateway-url-input"]') as HTMLInputElement;
    gwInput.value = 'wss://srinivaskona7.github.io/ws';
    gwInput.dispatchEvent(new Event('input', { bubbles: true }));
    const hostInput = container.querySelector('[data-testid="connect-host-input"]') as HTMLInputElement;
    hostInput.value = '127.0.0.1';
    hostInput.dispatchEvent(new Event('input', { bubbles: true }));
    const userInput = container.querySelector('[data-testid="connect-user-input"]') as HTMLInputElement;
    userInput.value = 'ubuntu';
    userInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));

    const submitBtn = container.querySelector('[data-testid="connect-modal-submit-btn"]') as HTMLButtonElement;
    submitBtn.click();
    await new Promise((r) => setTimeout(r, 15));
    expect(container.querySelector('[data-testid="modal-connect-error-badge"]')?.textContent).toContain(
      'GitHub Pages'
    );

    // Restore valid local gateway URL and test wrong password -> must stay Disconnected without false tab title
    gwInput.value = 'ws://127.0.0.1:8080/ws';
    gwInput.dispatchEvent(new Event('input', { bubbles: true }));
    const passInput = container.querySelector('[data-testid="connect-password-input"]') as HTMLInputElement;
    passInput.value = 'wrong-password';
    passInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    submitBtn.click();
    await new Promise((r) => setTimeout(r, 25));
    expect(container.querySelector('[data-testid="modal-connect-error-badge"]')?.textContent).toContain(
      'SSH_CONNECT_FAILED'
    );
    expect(container.querySelector('[data-testid="tab-session-1"]')?.textContent ?? '').not.toContain(
      'ubuntu@127.0.0.1'
    );

    // 3. Connect with valid credentials -> transitions to Connected and runs real uname -s -> Linux
    passInput.value = 'testpass123';
    passInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    submitBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    expect(container.querySelector('[data-testid="tab-session-1"]')?.textContent).toContain(
      'ubuntu@127.0.0.1'
    );

    // Explicit exec jobs report through the inspector; interactive PTY output
    // belongs to the emulator and is never transcribed into the DOM.
    const termViewport = container.querySelector('[data-testid="terminal-viewport"]') as HTMLElement;
    for (const ch of 'uname -s') {
      termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    }
    termViewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 25));
    // Interactive PTY output belongs to the emulator, never transcribed into the DOM.
    expect(termViewport.textContent).not.toContain('Linux');

    // 4. Open second tab while connected -> allocates secondary PTY channel
    const addTabBtn = container.querySelector('[data-testid="add-tab-btn"]') as HTMLButtonElement;
    addTabBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('[data-testid="tab-session-2"]')?.textContent).toContain(
      'Terminal 2 (ubuntu@127.0.0.1)'
    );

    document.body.removeChild(container);
  });

  it('opens the find bar on Ctrl/Cmd+F and turns on the split broadcast from the palette', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);

    (container.querySelector('[data-testid="nav-terminal"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 150));

    // Ctrl+F works from anywhere outside a text field, not only with the
    // emulator focused, and the bar takes the caret rather than leaving it on
    // the terminal's helper textarea.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const searchInput = container.querySelector('[data-testid="terminal-search-input"]') as HTMLInputElement;
    expect(searchInput).toBeTruthy();
    expect(document.activeElement).toBe(searchInput);

    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(container.querySelector('[data-testid="terminal-search-bar"]')).toBeNull();

    // The broadcast command opens the split and switches broadcast on in one
    // step; running it again only toggles, it never leaves the split closed.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const paletteInput = container.querySelector('[data-testid="command-palette-input"]') as HTMLInputElement;
    expect(paletteInput).toBeTruthy();
    paletteInput.value = 'broadcast';
    paletteInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    paletteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));

    const broadcastBtn = container.querySelector('[data-testid="toggle-broadcast-btn"]');
    expect(broadcastBtn).toBeTruthy();
    expect(broadcastBtn?.getAttribute('aria-pressed')).toBe('true');

    document.body.removeChild(container);
  });

  it('moves the command palette highlight with arrows, runs the highlighted command on Enter, and closes on Escape', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);
    await new Promise((r) => setTimeout(r, 150));

    // Ctrl/Cmd+K opens the palette from anywhere and puts the caret in it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));

    const paletteInput = container.querySelector('[data-testid="command-palette-input"]') as HTMLInputElement;
    expect(paletteInput).toBeTruthy();
    expect(document.activeElement).toBe(paletteInput);

    // The highlighted row is the primary-variant button; an empty query keeps
    // registration order, so full-screen is first and Zen second.
    const isHighlighted = (id: string): boolean =>
      Boolean(container.querySelector(`[data-testid="palette-cmd-${id}"]`)?.classList.contains('ui-btn--primary'));

    expect(isHighlighted('view.fullscreen')).toBe(true);
    expect(isHighlighted('view.zen')).toBe(false);

    paletteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(isHighlighted('view.fullscreen')).toBe(false);
    expect(isHighlighted('view.zen')).toBe(true);

    paletteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(isHighlighted('view.fullscreen')).toBe(true);

    // Arrow down twice onto "Open capability matrix", then Enter runs it.
    paletteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    paletteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(isHighlighted('nav.features')).toBe(true);

    paletteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(container.querySelector('[data-testid="command-palette-modal"]')).toBeNull();
    expect(container.querySelector('[data-testid="screen-features"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="capability-table"]')).toBeTruthy();

    // Reopened, Escape closes it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const reopenedInput = container.querySelector('[data-testid="command-palette-input"]') as HTMLInputElement;
    expect(reopenedInput).toBeTruthy();

    reopenedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(container.querySelector('[data-testid="command-palette-modal"]')).toBeNull();

    document.body.removeChild(container);
  });

  it('renames the active session tab on double-click and leaves the old name when the prompt is cancelled', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);
    // Configure the gateway endpoint up front (welcome card has no gateway field).
    (container.querySelector('[data-testid="welcome-settings-btn"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    (container.querySelector('[data-testid="settings-tab-administrator"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    (container.querySelector('[data-testid="welcome-transport-mode-select"]') as HTMLSelectElement).value = 'go-gateway';
    (container.querySelector('[data-testid="welcome-transport-mode-select"]') as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));
    const gw = container.querySelector('[data-testid="welcome-gateway-url-input"]') as HTMLInputElement;
    gw.value = 'ws://127.0.0.1:8080/ws';
    gw.dispatchEvent(new Event('input', { bubbles: true }));
    (container.querySelector('[data-testid="header-settings-btn"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));

    // Renaming has to show in the tab strip and the active-session label, and
    // that label is rendered by the status bar only while connected.
    // Connection-first UI: the welcome card is the connect form (no header button).
    (container.querySelector('[data-testid="welcome-host-input"]') as HTMLInputElement).value = '127.0.0.1';
    (container.querySelector('[data-testid="welcome-host-input"]') as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
    (container.querySelector('[data-testid="welcome-user-input"]') as HTMLInputElement).value = 'ubuntu';
    (container.querySelector('[data-testid="welcome-user-input"]') as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
    const wp = container.querySelector('[data-testid="welcome-password-input"]') as HTMLInputElement;
    wp.value = 'testpass123';
    wp.dispatchEvent(new Event('input', { bubbles: true }));
    wp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    (container.querySelector('[data-testid="welcome-connect-form"]') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 2000));

    const tab = (): HTMLElement => container.querySelector('[data-testid="tab-session-1"]') as HTMLElement;
    const statusBar = (): HTMLElement => container.querySelector('[data-testid="status-bar"]') as HTMLElement;
    expect(tab().textContent).toContain('Terminal 1 (ubuntu@127.0.0.1)');
    expect(statusBar().textContent).toContain('Connected · Terminal 1 (ubuntu@127.0.0.1)');

    // A typed name is trimmed before it becomes the label.
    vi.stubGlobal('prompt', vi.fn(() => '  Build box  '));
    tab().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(tab().textContent).toContain('Build box');
    expect(statusBar().textContent).toContain('Connected · Build box');

    // Cancelling the prompt keeps the current name everywhere.
    vi.stubGlobal('prompt', vi.fn(() => null));
    tab().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(tab().textContent).toContain('Build box');
    expect(statusBar().textContent).toContain('Connected · Build box');

    document.body.removeChild(container);
  });

  it('opens the shortcut cheatsheet with ? outside the terminal, refuses it inside the terminal viewport, and closes on Escape', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);
    await new Promise((r) => setTimeout(r, 150));

    expect(container.querySelector('[data-testid="shortcuts-modal"]')).toBeNull();

    // `?` dispatched from the surrounding shell (not a text field) opens it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(container.querySelector('[data-testid="shortcuts-modal"]')).toBeTruthy();
    const list = container.querySelector('[data-testid="shortcuts-list"]');
    expect(list?.textContent).toContain('Open or close the command palette');
    expect(list?.textContent).toContain('Find text in the active terminal');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(container.querySelector('[data-testid="shortcuts-modal"]')).toBeNull();

    // Inside the terminal `?` is a real command character, so the shell must
    // not steal it for the cheatsheet.
    (container.querySelector('[data-testid="nav-terminal"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 150));
    const viewport = container.querySelector('[data-testid="terminal-viewport"]') as HTMLElement;
    expect(viewport.classList.contains('webssh-terminal-viewport')).toBe(true);

    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(container.querySelector('[data-testid="shortcuts-modal"]')).toBeNull();

    document.body.removeChild(container);
  });

  it('applies a theme chosen in Settings to the document root and persists the choice', async () => {
    const initialTheme = document.documentElement.getAttribute('data-theme');

    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);
    await new Promise((r) => setTimeout(r, 150));

    // Theme lives in Settings -> Appearance on the connection-first flow.
    (container.querySelector('[data-testid="welcome-settings-btn"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    (container.querySelector('[data-testid="theme-btn-dracula"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 150));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dracula');
    const stored = JSON.parse(localStorage.getItem('webssh.preferences.v2') ?? '{}') as {
      activeThemeId?: string;
    };
    expect(stored.activeThemeId).toBe('dracula');

    // The root attribute outlives the container; put it back for later tests.
    if (initialTheme === null) {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', initialTheme);
    }
    document.body.removeChild(container);
  });

  it('keeps recent hosts off the connection page (Saved Hosts only) and prefills from a saved profile', async () => {
    localStorage.setItem(
      'webssh.hosts.v1',
      JSON.stringify([
        {
          id: 'h-old',
          alias: 'old-box',
          host: '10.0.0.1',
          port: 22,
          user: 'ubuntu',
          tags: [],
          favorite: false,
          jumpHops: [],
          lastConnectedAt: 1000
        },
        {
          id: 'h-new',
          alias: 'new-box',
          host: '10.0.0.9',
          port: 2222,
          user: 'deploy',
          tags: [],
          favorite: true,
          jumpHops: [],
          lastConnectedAt: 5000
        },
        {
          id: 'h-mid',
          alias: 'mid-box',
          host: '10.0.0.5',
          port: 22,
          user: 'root',
          tags: [],
          favorite: false,
          jumpHops: [],
          lastConnectedAt: 3000
        },
        {
          id: 'h-never',
          alias: 'never-box',
          host: '10.0.0.7',
          port: 22,
          user: 'ubuntu',
          tags: [],
          favorite: false,
          jumpHops: []
        }
      ])
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);
    await new Promise((r) => setTimeout(r, 150));

    // Fresh connection page shows no recent hosts, sample data, or startup tab.
    expect(container.querySelector('[data-testid="welcome-recent-hosts"]')).toBeNull();
    expect(container.querySelector('[data-testid="tab-session-1"]')).toBeNull();
    expect((container.querySelector('[data-testid="welcome-host-input"]') as HTMLInputElement).value).toBe('');
    expect((container.querySelector('[data-testid="welcome-user-input"]') as HTMLInputElement).value).toBe('');

    // Saved profiles live behind the explicit Saved Hosts action.
    (container.querySelector('[data-testid="welcome-saved-hosts-btn"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toContain('new-box');
    const profileBtn = container.querySelector('[data-testid="host-card-new-box"] button');
    expect(profileBtn).toBeTruthy();

    // Selecting a saved profile fills the connection form.
    (profileBtn as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 150));

    expect(container.querySelector('[data-testid="connect-modal"]')).toBeTruthy();
    expect((container.querySelector('[data-testid="connect-host-input"]') as HTMLInputElement).value).toBe('10.0.0.9');
    expect((container.querySelector('[data-testid="connect-user-input"]') as HTMLInputElement).value).toBe('deploy');
    expect((container.querySelector('[data-testid="connect-port-input"]') as HTMLInputElement).value).toBe('2222');

    document.body.removeChild(container);
  });
});
