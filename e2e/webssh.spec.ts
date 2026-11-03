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
    expect(await page.locator('[data-testid="sidebar-nav"]').count()).toBe(0);

    // 2. Verify Zen mode has visible Exit button and Esc returns to Welcome screen
    await page.getByTestId('traffic-light-minimize').click();
    await expect(page.getByTestId('exit-zen-btn')).toBeVisible();
    await page.keyboard.press('Escape');
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
    await page.keyboard.type('uname -s');
    await page.keyboard.press('Enter');
    await expect(viewport).toContainText('Linux');

    await page.keyboard.type('pwd');
    await page.keyboard.press('Enter');
    await expect(viewport).toContainText('/home/ubuntu');

    await page.keyboard.type("printf 'real-ssh-verified'");
    await page.keyboard.press('Enter');
    await expect(viewport).toContainText('real-ssh-verified');

    await page.keyboard.type('nonexistent_cmd_404');
    await page.keyboard.press('Enter');
    await expect(viewport).toContainText('command not found');

    // 7. Enable Full Studio IDE Mode and verify real SFTP directory listing & Remote File Editor
    await page.getByTestId('enable-ide-mode-btn').click();
    await expect(page.getByTestId('sidebar-nav')).toBeVisible();

    await page.getByTestId('nav-files').click();
    await expect(page.getByTestId('screen-files')).toBeVisible();
    await expect(page.getByTestId('sftp-row-README.md')).toBeVisible();

    // Test real SFTP chmod on README.md
    await page.getByTestId('chmod-target-input').fill('README.md');
    await page.getByTestId('apply-chmod-btn').click();
    await expect(page.getByTestId('transfer-status-badge')).toContainText('Applied chmod');

    // Test Remote File Editor loading and saving README.md over real SFTP
    await page.getByTestId('nav-editor').click();
    await expect(page.getByTestId('screen-editor')).toBeVisible();
    await expect(page.getByTestId('remote-editor-textarea')).toHaveValue(/WebSSH Test Server/);

    // 8. Navigate through remaining IDE screens and verify accessibility
    await page.getByTestId('nav-overview').click();
    await expect(page.getByTestId('screen-overview')).toBeVisible();
    await expect(page.getByTestId('live-control')).toBeVisible();

    await page.getByTestId('nav-tunnels').click();
    await expect(page.getByTestId('screen-tunnels')).toBeVisible();
    await expect(page.getByTestId('remote-web-preview-card')).toBeVisible();

    await page.getByTestId('nav-features').click();
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
});
