import { test, expect } from '@playwright/test';

interface GatewayHealthInfo {
  status: string;
  activeSessions: number;
  testSshdHost?: string;
  testSshdPort?: number;
}

test.describe('Workspace IDE', () => {
  test('opens from the rail, lists real SFTP files, and hands the pane to Monaco', async ({ page, request }) => {
    const healthResp = await request.get('http://127.0.0.1:8080/healthz');
    expect(healthResp.ok()).toBe(true);
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

    // The Workspace IDE is reachable from the rail, not only from dead code.
    await page.getByTestId('nav-ide').click();
    await expect(page.getByTestId('screen-ide')).toBeVisible();

    // The file tree is the real SFTP listing of the remote root, not a fixture.
    await expect(page.getByTestId('ide-entry-README.md')).toBeVisible();

    // Opening a file reads it over SFTP and shows its path.
    await page.getByTestId('ide-entry-README.md').click();
    await expect(page.getByTestId('ide-active-path')).toHaveText('./README.md');

    // Monaco is lazy-loaded and takes over the pane; the textarea fallback steps aside.
    const toggle = page.getByTestId('ide-monaco-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(page.getByTestId('monaco-editor')).toBeVisible();
    await expect(page.getByTestId('ide-editor')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // Toggling back restores the textarea editor.
    await toggle.click();
    await expect(page.getByTestId('ide-editor')).toBeVisible();
    await expect(page.getByTestId('monaco-editor')).toHaveCount(0);
  });
});
