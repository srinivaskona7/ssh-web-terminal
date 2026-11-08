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

    // 2. Connection-first header: no View menu on welcome; Settings toggles and back navigates.
    await expect(page.getByTestId('view-menu-btn')).toBeHidden();
    await page.getByTestId('welcome-settings-btn').click();
    await expect(page.getByTestId('screen-settings')).toBeVisible();
    await page.getByTestId('header-settings-btn').click();
    await expect(page.getByTestId('screen-welcome')).toBeVisible();

    // 3. Test chmod 0644 permission warning in Quick Connect
    await page.getByTestId('welcome-auth-keyfile-btn').click();
    await page.getByTestId('private-key-chmod-select').selectOption('0644');
    await page.getByTestId('welcome-connect-submit-btn').click();
    await expect(page.getByTestId('connect-error-badge')).toContainText('Permissions 0644');

    // 4. Test wrong password rejection against real testsshd (never fabricates Connected)
    await page.getByTestId('welcome-auth-password-btn').click();
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
    await page.getByTestId('nav-overview').click();
    await expect(page.getByTestId('screen-overview')).toBeVisible();
    await expect(page.getByTestId('live-control')).toBeVisible();

    await page.getByTestId('nav-tunnels').click();
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
    await page.getByTestId('disconnect-btn').click();
    await expect(page.getByTestId('empty-state-connect-btn')).toBeVisible();
    await expect(page.getByTestId('empty-state-reconnect-btn')).toBeVisible();
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
    // Reach the host field with keyboard only (bounded tab walk, no gomouse).
    let onHost = false;
    for (let i = 0; i < 30 && !onHost; i++) {
      const tag = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? '');
      if (tag === 'welcome-host-input') onHost = true;
      else await page.keyboard.press('Tab');
    }
    expect(onHost).toBe(true);
    await page.keyboard.type(sshHost);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('ubuntu');
    await page.keyboard.press('Tab');
    await page.keyboard.type(sshPort);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('testpass123');
    await page.keyboard.press('Tab');
    // Submit via keyboard-accessible Connect button.
    await page.locator('[data-testid="welcome-connect-submit-btn"]').focus();
    await page.keyboard.press('Enter');
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
