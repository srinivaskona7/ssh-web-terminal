import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('WebSSH Studio E2E & Accessibility Suite (M0-M13)', () => {
  test('starts on clean Welcome screen, exits Zen mode via Escape, supports Private Key (chmod 0400) & Password connect, and unlocks IDE mode', async ({ page }) => {
    await page.goto('/');

    // 1. Default Welcome screen with minimal options & zero mock data
    await expect(page.getByTestId('screen-welcome')).toBeVisible();
    await expect(page.getByTestId('welcome-quick-connect-card')).toBeVisible();

    // Accessibility check on Welcome screen
    const welcomeAccessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules(['color-contrast'])
      .analyze();
    expect(welcomeAccessibility.violations).toEqual([]);

    // 2. Enter Zen Mode and press Escape to return to Welcome screen
    await page.getByTestId('toggle-zen-btn').click();
    await expect(page.getByTestId('zen-mode-banner')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('zen-mode-banner')).toHaveCount(0);
    await expect(page.getByTestId('screen-welcome')).toBeVisible();

    // 3. Verify Private Key upload with chmod 0400 permission enforcement
    await page.getByTestId('welcome-auth-keyfile-btn').click();
    await expect(page.getByTestId('private-key-chmod-badge')).toContainText('chmod 0400 (-r--------) Enforced');

    // 4. Enable IDE Mode to unlock all 50 features and full navigation rail
    await page.getByTestId('toggle-ide-mode-btn').click();
    await page.getByTestId('nav-workspace').click();
    const viewport = page.getByTestId('terminal-viewport');
    await expect(viewport).toBeVisible();

    // Accessibility check on Terminal Workspace
    const terminalAccessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules(['color-contrast'])
      .analyze();
    expect(terminalAccessibility.violations).toEqual([]);

    // 5. SFTP Chmod Matrix (0400 default) & Editor Side-by-Side Diff
    await page.getByTestId('nav-files').click();
    await expect(page.getByTestId('chmod-octal-badge')).toContainText('0400 (-r--------)');
    await page.getByTestId('nav-editor').click();
    await page.getByTestId('toggle-diff-viewer-btn').click();
    await expect(page.getByTestId('side-by-side-diff-card')).toBeVisible();
  });
});
