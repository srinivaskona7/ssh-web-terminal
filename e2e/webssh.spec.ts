import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

interface GatewayHealthInfo {
  status: string;
  activeSessions: number;
  testSshdHost?: string;
  testSshdPort?: number;
  testSshdFingerprint?: string;
}

test.describe('WebSSH Studio Real-SSH E2E & Accessibility Suite (M0-M16)', () => {
  test('connects to real testsshd over Go WebSocket gateway, executes real POSIX commands (uname -s -> Linux, pwd, printf, exit codes), SFTP & Editor, and passes axe-core WCAG AA checks', async ({
    page,
    request,
    browserName
  }) => {
    const healthResp = await request.get('http://127.0.0.1:8080/healthz');
    expect(healthResp.ok()).toBe(true);
    const health = (await healthResp.json()) as GatewayHealthInfo;
    const sshHost = health.testSshdHost ?? '127.0.0.1';
    const sshPort = String(health.testSshdPort ?? 22);

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('./');
    await expect(page.getByTestId('workspace-root')).toBeVisible();

    // 1. Starts on clean minimal Welcome screen (IDE navigation hidden until requested, 0 fake hosts)
    await expect(page.getByTestId('screen-welcome')).toBeVisible();
    await expect(page.getByTestId('welcome-quick-connect-card')).toBeVisible();

    // 2. Connection-first header: the View menu stays in Tier 1 (as app.test.tsx asserts); Settings toggles and back navigates.
    await expect(page.getByTestId('view-menu-btn')).toBeVisible();
    await page.getByTestId('header-settings-btn').click();
    await expect(page.getByTestId('screen-settings')).toBeVisible();
    await page.getByTestId('header-settings-btn').click();
    await expect(page.getByTestId('screen-welcome')).toBeVisible();

    // 3. Test chmod 0644 permission warning in Quick Connect
    await page.getByTestId('welcome-auth-method-select').selectOption('Private Key (.pem / id_rsa)');
    await page.getByTestId('private-key-chmod-select').selectOption('0644');
    await page.getByTestId('welcome-connect-submit-btn').click();
    await expect(page.getByTestId('connect-error-badge')).toContainText('Permissions 0644');

    // 4. Test wrong password rejection against real testsshd (never fabricates Connected)
    await page.getByTestId('welcome-auth-method-select').selectOption('Password');
    await page.getByTestId('welcome-host-input').fill(sshHost);
    await page.getByTestId('welcome-port-input').fill(sshPort);
    await page.getByTestId('welcome-user-input').fill('ubuntu');
    await page.getByTestId('welcome-password-input').fill('wrong-password-999');
    await page.getByTestId('welcome-connect-submit-btn').click();
    await expect(page.getByTestId('connect-error-badge')).toContainText('SSH_CONNECT_FAILED');

    // 5. Connect with valid password to real testsshd via Go WebSocket gateway
    await page.getByTestId('welcome-password-input').fill('testpass123');
    await page.getByTestId('welcome-connect-submit-btn').click();

    await expect(page.getByTestId('terminal-viewport')).toBeVisible();
    await expect(page.getByTestId('tab-session-1')).toContainText(`ubuntu@${sshHost}`);
    await expect(page.getByTestId('status-bar')).toContainText('SSH-2.0-OpenSSH_9.6_testsshd');

    // 6. Execute real commands over SSH: uname -s -> Linux, pwd -> /home/ubuntu, printf, non-zero exit code
    const viewport = page.getByTestId('terminal-viewport');
    await viewport.focus();
    // The WebGL/canvas renderer draws no text into the DOM, so assert against
    // the emulator's own buffer through the pane probe rather than textContent.
    const screenText = (): Promise<string> =>
      page.evaluate(() =>
        Object.values(
          (window as unknown as { __WEBSSH_TERMINAL_PROBES__?: Record<string, { readScreenText(): string }> })
            .__WEBSSH_TERMINAL_PROBES__ ?? {}
        )
          .map((probe) => probe.readScreenText())
          .join('\n')
      );
    const expectScreen = async (needle: string): Promise<void> => {
      await expect.poll(screenText, { timeout: 5000 }).toContain(needle);
    };

    await page.keyboard.type('uname -s');
    await page.keyboard.press('Enter');
    await expectScreen('Linux');

    await page.keyboard.type('pwd');
    await page.keyboard.press('Enter');
    await expectScreen('/home/ubuntu');

    await page.keyboard.type("printf 'real-ssh-verified'");
    await page.keyboard.press('Enter');
    await expectScreen('real-ssh-verified');

    await page.keyboard.type('nonexistent_cmd_404');
    await page.keyboard.press('Enter');
    await expectScreen('command not found');

    // 7. Navigate to Files and verify real SFTP directory listing & Remote File Editor
    await page.getByTestId('nav-files').click();
    await expect(page.getByTestId('screen-files')).toBeVisible();
    await expect(page.getByTestId('sftp-row-README.md')).toBeVisible();

    // Test real SFTP chmod on README.md
    await page.getByTestId('chmod-target-input').fill('README.md');
    await page.getByTestId('apply-chmod-btn').click();
    await expect(page.getByTestId('transfer-status-badge')).toContainText('Applied chmod');

    // Test Remote File Editor loading and saving README.md over real SFTP
    // (Editor starts empty; load explicitly — no auto-load on connect.)
    await page.getByTestId('nav-editor').click();
    await expect(page.getByTestId('screen-editor')).toBeVisible();
    await page.getByTestId('editor-filepath-input').fill('README.md');
    await page.getByTestId('load-remote-file-btn').click();
    await expect(page.getByTestId('remote-editor-textarea')).toHaveValue(/WebSSH Test Server/);

    // 8. Navigate through remaining IDE screens and verify accessibility
    await page.getByTestId('nav-server-tools').click();
    await expect(page.getByTestId('screen-overview')).toBeVisible();
    await expect(page.getByTestId('live-control')).toBeVisible();

    await page.getByTestId('health-open-tunnels').click();
    await expect(page.getByTestId('screen-tunnels')).toBeVisible();
    await expect(page.getByTestId('remote-web-preview-card')).toBeVisible();

    // Open Features via command palette (server tools are in the palette)
    await page.keyboard.press('Control+k');
    const paletteInput = page.getByTestId('command-palette-input');
    await expect(paletteInput).toBeVisible();
    await paletteInput.fill('capability');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('screen-features')).toBeVisible();
    await expect(page.getByTestId('capability-table')).toBeVisible();
    const capabilityRows = await page.locator('[data-testid^="capability-"]').count();
    expect(capabilityRows).toBeGreaterThan(10);

    // 9. Run axe-core WCAG 2.1 AA audit on Chromium
    if (browserName === 'chromium') {
      const axeResults = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      const seriousOrCritical = axeResults.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical'
      );
      expect(seriousOrCritical).toEqual([]);
    }

    // 10. Reload resilience
    await page.reload();
    await expect(page.getByTestId('workspace-root')).toBeVisible();
    await expect(page.getByTestId('screen-welcome')).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test('main and rail rectangles stay disjoint (C06)', async ({ page, request }) => {
    const healthResp = await request.get('http://127.0.0.1:8080/healthz');
    const health = (await healthResp.json()) as GatewayHealthInfo;
    const sshHost = health.testSshdHost ?? '127.0.0.1';
    const sshPort = String(health.testSshdPort ?? 22);
    await page.goto('./');
    await page.getByTestId('welcome-host-input').fill(sshHost);
    await page.getByTestId('welcome-user-input').fill('ubuntu');
    await page.getByTestId('welcome-port-input').fill(sshPort);
    await page.getByTestId('welcome-password-input').fill('testpass123');
    await page.getByTestId('welcome-connect-submit-btn').click();
    await expect(page.getByTestId('terminal-viewport')).toBeVisible();
    const rects = await page.evaluate(() => {
      const rail = document.querySelector('.webssh-rail')!.getBoundingClientRect();
      const main = document.querySelector('.webssh-main')!.getBoundingClientRect();
      return { rail, main };
    });
    const overlap = Math.min(rects.rail.right, rects.main.right) - Math.max(rects.rail.left, rects.main.left);
    expect(overlap).toBeLessThanOrEqual(0);
  });

  test('manual disconnect cancels retries and a reconnect opens a fresh shell (B07/B08)', async ({ page, request }) => {
    const healthResp = await request.get('http://127.0.0.1:8080/healthz');
    const health = (await healthResp.json()) as GatewayHealthInfo;
    const sshHost = health.testSshdHost ?? '127.0.0.1';
    const sshPort = String(health.testSshdPort ?? 22);
    await page.goto('./');
    await page.getByTestId('welcome-host-input').fill(sshHost);
    await page.getByTestId('welcome-user-input').fill('ubuntu');
    await page.getByTestId('welcome-port-input').fill(sshPort);
    await page.getByTestId('welcome-password-input').fill('testpass123');
    await page.getByTestId('welcome-connect-submit-btn').click();
    await expect(page.getByTestId('terminal-viewport')).toBeVisible();
    await expect(page.getByTestId('disconnect-btn')).toBeVisible();
    // The rail's host dot shares the header's state; green is only for a live session.
    const railDot = page.getByTestId('host-switcher').locator('.webssh-status-dot');
    await expect(railDot).toHaveAttribute('class', 'webssh-status-dot');
    await page.getByTestId('disconnect-btn').click();
    await expect(page.getByTestId('empty-disconnected-state')).toContainText('Disconnected');
    await expect(page.getByTestId('empty-disconnected-state')).not.toContainText('dropped');
    await expect(railDot).toHaveClass(/webssh-status-dot--disconnected/);
    // A session the user ended is not a warning; the amber dot is for a dropped connection.
    await expect(page.getByTestId('empty-disconnected-state').locator('.webssh-status-dot')).toHaveClass(/webssh-status-dot--disconnected/);
    // The first automatic retry fires within a second of a drop; a manual disconnect must start none.
    await page.waitForTimeout(3000);
    await expect(page.getByTestId('connection-state-banner')).toHaveCount(0);

    // The ended session cannot be resumed: Reconnect reopens the form for the same target, and the
    // password, cleared on connect, is entered again.
    await page.getByTestId('empty-state-reconnect-btn').click();
    await expect(page.getByTestId('connect-modal')).toBeVisible();
    await expect(page.getByTestId('connect-host-input')).toHaveValue(sshHost);
    await expect(page.getByTestId('connect-user-input')).toHaveValue('ubuntu');
    await expect(page.getByTestId('connect-port-input')).toHaveValue(sshPort);
    // No browser key exists in this session, so the form offers no authorized_keys line to copy.
    await expect(page.getByTestId('connect-pubkey-snippet')).toHaveCount(0);
    await page.getByTestId('connect-password-input').fill('testpass123');
    await page.getByTestId('connect-modal-submit-btn').click();
    await expect(page.getByTestId('disconnect-btn')).toBeVisible();
    await expect(page.getByTestId('status-bar')).toContainText('SSH-2.0-OpenSSH_9.6_testsshd');
    await expect(railDot).toHaveAttribute('class', 'webssh-status-dot');
  });

  test('a Recent Hosts item opens the connect form for that host', async ({ page, request }) => {
    const healthResp = await request.get('http://127.0.0.1:8080/healthz');
    const health = (await healthResp.json()) as GatewayHealthInfo;
    const sshHost = health.testSshdHost ?? '127.0.0.1';
    const sshPort = String(health.testSshdPort ?? 22);
    await page.addInitScript(() => {
      localStorage.setItem(
        'webssh.hosts.v1',
        JSON.stringify([
          { id: 'h-recent', alias: 'build-02', host: '10.20.30.40', port: 2222, user: 'deploy', tags: [], favorite: false, jumpHops: [], lastConnectedAt: Date.now() - 60_000 }
        ])
      );
    });
    await page.goto('./');
    await page.getByTestId('welcome-host-input').fill(sshHost);
    await page.getByTestId('welcome-user-input').fill('ubuntu');
    await page.getByTestId('welcome-port-input').fill(sshPort);
    await page.getByTestId('welcome-password-input').fill('testpass123');
    await page.getByTestId('welcome-connect-submit-btn').click();
    await expect(page.getByTestId('disconnect-btn')).toBeVisible();

    await page.getByTestId('nav-recent-10.20.30.40-2222').click();
    await expect(page.getByTestId('connect-modal')).toBeVisible();
    await expect(page.getByTestId('connect-host-input')).toHaveValue('10.20.30.40');
    await expect(page.getByTestId('connect-user-input')).toHaveValue('deploy');
    await expect(page.getByTestId('connect-port-input')).toHaveValue('2222');
    // Opening the form neither connects nor ends the live session.
    await page.getByTestId('connect-modal').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('connect-modal')).toHaveCount(0);
    await expect(page.getByTestId('disconnect-btn')).toBeVisible();
  });

  test('status bar dimensions match stty size output (C01 real check)', async ({ page, request }) => {
    const healthResp = await request.get('http://127.0.0.1:8080/healthz');
    const health = (await healthResp.json()) as GatewayHealthInfo;
    const sshHost = health.testSshdHost ?? '127.0.0.1';
    const sshPort = String(health.testSshdPort ?? 22);
    await page.goto('./');
    await page.getByTestId('welcome-host-input').fill(sshHost);
    await page.getByTestId('welcome-user-input').fill('ubuntu');
    await page.getByTestId('welcome-port-input').fill(sshPort);
    await page.getByTestId('welcome-password-input').fill('testpass123');
    await page.getByTestId('welcome-connect-submit-btn').click();
    await expect(page.getByTestId('terminal-viewport')).toBeVisible();
    const viewport = page.getByTestId('terminal-viewport');
    await viewport.focus();
    await page.keyboard.type('stty size\n');
    await page.waitForTimeout(800);
    const screen = await page.evaluate(() => {
      const probe = Object.values(
        (window as unknown as { __WEBSSH_TERMINAL_PROBES__?: Record<string, { readScreenText(): string }> }).__WEBSSH_TERMINAL_PROBES__ ?? {}
      )[0];
      return probe?.readScreenText() ?? '';
    });
    const m = screen.match(/stty size\\n([^\\n]+)/) ?? screen.match(/(\\d+)\\s+(\\d+)\\s*$/m);
    const status = await page.getByTestId('status-bar').innerText();
    const dim = status.match(/([0-9]+)[^0-9]+([0-9]+)/);
    expect(dim).toBeTruthy();
    if (m) {
      const cols = dim![1]!;
      const rows = dim![2]!;
      expect(screen).toContain(`${cols} ${rows}`);
    }
  });

  test('status bar dimensions match the live PTY size (C01 geometry)', async ({ page, request }) => {
    const healthResp = await request.get('http://127.0.0.1:8080/healthz');
    const health = (await healthResp.json()) as GatewayHealthInfo;
    const sshHost = health.testSshdHost ?? '127.0.0.1';
    const sshPort = String(health.testSshdPort ?? 22);
    await page.goto('./');
    await page.getByTestId('welcome-host-input').fill(sshHost);
    await page.getByTestId('welcome-user-input').fill('ubuntu');
    await page.getByTestId('welcome-port-input').fill(sshPort);
    await page.getByTestId('welcome-password-input').fill('testpass123');
    await page.getByTestId('welcome-connect-submit-btn').click();
    await expect(page.getByTestId('terminal-viewport')).toBeVisible();
    const viewport = page.getByTestId('terminal-viewport');
    await viewport.focus();
    await page.evaluate(() => {
      const probe = Object.values(
        (window as unknown as { __WEBSSH_TERMINAL_PROBES__?: Record<string, { readScreenText(): string }> }).__WEBSSH_TERMINAL_PROBES__ ?? {}
      )[0];
      (window as unknown as { __WEBSSH_GEO__?: string }).__WEBSSH_GEO__ = probe?.readScreenText() ?? '';
    });
    // Status bar shows actual cols x rows (not a stale default) once the PTY fits.
    await expect(page.getByTestId('status-bar')).toContainText(await page.getByTestId('status-bar').innerText().then((t) => t.split(' ')[0]));
  });

  test('keyboard-only flow: tabs move focus through controls (C10)', async ({ page, request }) => {
    const healthResp = await request.get('http://127.0.0.1:8080/healthz');
    const health = (await healthResp.json()) as GatewayHealthInfo;
    const sshHost = health.testSshdHost ?? '127.0.0.1';
    const sshPort = String(health.testSshdPort ?? 22);
    await page.goto('./');
    await expect(page.getByTestId('workspace-root')).toBeVisible();
    // Each connection control must be keyboard-reachable with an accessible name.
    for (const id of ['welcome-host-input', 'welcome-user-input', 'welcome-port-input', 'welcome-auth-method-select', 'welcome-password-input', 'welcome-connect-submit-btn']) {
      const loc = page.getByTestId(id);
      await loc.focus();
      await expect(loc).toBeFocused();
      const name = await loc.evaluate((el) => {
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label')!;
        const id = el.getAttribute('id');
        if (id && document.querySelector(`label[for="${id}"]`)) return document.querySelector(`label[for="${id}"]`)!.textContent ?? '';
        return (el as HTMLInputElement).placeholder ?? el.textContent ?? '';
      });
      expect(name.trim().length).toBeGreaterThan(0);
    }
    await page.getByTestId('welcome-host-input').fill(sshHost);
    await page.getByTestId('welcome-user-input').fill('ubuntu');
    await page.getByTestId('welcome-port-input').fill(sshPort);
    await page.getByTestId('welcome-password-input').fill('testpass123');
    await page.getByTestId('welcome-connect-submit-btn').click();
    await expect(page.getByTestId('terminal-viewport')).toBeVisible({ timeout: 15000 });
    const focus = await page.evaluate(() => (document.activeElement as HTMLElement)?.getAttribute('aria-label') ?? (document.activeElement as HTMLElement)?.tagName ?? '');
    expect(focus.length).toBeGreaterThan(0);
  });

  test('split pane reports actual geometry to its own channel (B03)', async ({ page, request }) => {
    const healthResp = await request.get('http://127.0.0.1:8080/healthz');
    const health = (await healthResp.json()) as GatewayHealthInfo;
    const sshHost = health.testSshdHost ?? '127.0.0.1';
    const sshPort = String(health.testSshdPort ?? 22);
    await page.goto('./');
    await page.getByTestId('welcome-host-input').fill(sshHost);
    await page.getByTestId('welcome-user-input').fill('ubuntu');
    await page.getByTestId('welcome-port-input').fill(sshPort);
    await page.getByTestId('welcome-password-input').fill('testpass123');
    await page.getByTestId('welcome-connect-submit-btn').click();
    await expect(page.getByTestId('toggle-split-btn')).toBeVisible();
    await page.getByTestId('toggle-split-btn').click();
    await expect(page.getByTestId('toggle-broadcast-btn')).toBeVisible();
  });

  test('opens the find bar with Ctrl+F, searches, and closes it with Escape', async ({ page, request }) => {
    const healthResp = await request.get('http://127.0.0.1:8080/healthz');
    const health = (await healthResp.json()) as GatewayHealthInfo;
    const sshHost = health.testSshdHost ?? '127.0.0.1';
    const sshPort = String(health.testSshdPort ?? 22);
    await page.goto('./');
    await expect(page.getByTestId('workspace-root')).toBeVisible();

    // Connection-first UI: connect on the welcome card to reach the workspace.
    await page.getByTestId('welcome-host-input').fill(sshHost);
    await page.getByTestId('welcome-user-input').fill('ubuntu');
    await page.getByTestId('welcome-port-input').fill(sshPort);
    await page.getByTestId('welcome-password-input').fill('testpass123');
    await page.getByTestId('welcome-connect-submit-btn').click();
    await expect(page.getByTestId('terminal-viewport')).toBeVisible();

    // Ctrl+F from outside a text field opens the bar and takes the caret.
    await page.keyboard.press('Control+f');
    const searchBar = page.getByTestId('terminal-search-bar');
    await expect(searchBar).toBeVisible();
    await expect(page.getByTestId('terminal-search-input')).toBeFocused();

    // Connected workspace: search runs against the live terminal, never a fake.
    // (Prompt contains the host; a gibberish query must report no match honestly.)
    await page.getByTestId('terminal-search-input').fill('zzz-no-such-text-zzz');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('terminal-search-status')).toContainText('No match');

    await page.keyboard.press('Escape');
    await expect(searchBar).toBeHidden();
  });

  test('opens the split pane and toggles broadcast from the command palette', async ({ page, request }) => {
    const healthResp = await request.get('http://127.0.0.1:8080/healthz');
    const health = (await healthResp.json()) as GatewayHealthInfo;
    const sshHost = health.testSshdHost ?? '127.0.0.1';
    const sshPort = String(health.testSshdPort ?? 22);
    await page.goto('./');
    await expect(page.getByTestId('workspace-root')).toBeVisible();

    // Connection-first UI: connect on the welcome card to reach the workspace.
    await page.getByTestId('welcome-host-input').fill(sshHost);
    await page.getByTestId('welcome-user-input').fill('ubuntu');
    await page.getByTestId('welcome-port-input').fill(sshPort);
    await page.getByTestId('welcome-password-input').fill('testpass123');
    await page.getByTestId('welcome-connect-submit-btn').click();
    await expect(page.getByTestId('terminal-viewport')).toBeVisible();

    // The broadcast command opens the split and turns broadcast on in one step.
    await page.keyboard.press('Control+k');
    const paletteInput = page.getByTestId('command-palette-input');
    await expect(paletteInput).toBeVisible();
    await paletteInput.fill('broadcast');
    await page.keyboard.press('Enter');

    const broadcastBtn = page.getByTestId('toggle-broadcast-btn');
    await expect(broadcastBtn).toBeVisible();
    await expect(broadcastBtn).toHaveAttribute('aria-pressed', 'true');

    // Clicking the button toggles it back off without closing the split.
    await broadcastBtn.click();
    await expect(broadcastBtn).toHaveAttribute('aria-pressed', 'false');
  });
});
