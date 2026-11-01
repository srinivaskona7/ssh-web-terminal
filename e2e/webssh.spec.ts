import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('WebSSH Studio E2E & Accessibility Suite (M0-M8)', () => {
  test('renders clean terminal workspace at 17px default font size, passes WCAG AA axe-core audit across themes, and persists theme preference', async ({
    page
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('workspace-root')).toBeVisible();
    await expect(page.getByTestId('terminal-viewport')).toBeVisible();
    await expect(page.getByTestId('terminal-viewport')).toContainText('WebSSH Studio v1.0.0');
    await expect(page.getByTestId('font-size-badge')).toHaveText('17px');

    // Run axe-core WCAG 2.1 AA audit on dark theme
    const darkAxe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(darkAxe.violations).toEqual([]);

    // Switch to Settings -> Light theme and verify persistence across reload
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('theme-btn-light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    const lightAxe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(lightAxe.violations).toEqual([]);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('toggles immersive full-screen mode, shows entry toast, reveals top hover overlay bar, and exits cleanly', async ({
    page
  }) => {
    await page.goto('/');
    await page.getByTestId('toggle-fullscreen-btn').click();

    await expect(page.getByTestId('fullscreen-toast')).toContainText('Press F11 or Esc to exit');
    await expect(page.getByTestId('fullscreen-top-hover-zone')).toBeVisible();

    // Reveal auto-hiding overlay bar on top-edge hover
    await page.getByTestId('fullscreen-top-hover-zone').hover();
    await expect(page.getByTestId('fullscreen-overlay-bar')).toBeVisible();

    // Exit full screen via overlay button and verify chrome returns
    await page.getByTestId('overlay-exit-fullscreen-btn').click();
    await expect(page.getByTestId('status-bar')).toBeVisible();
  });

  test('executes interactive terminal commands, opens New Connection modal, connects and disconnects, and imports ~/.ssh/config', async ({
    page
  }) => {
    await page.goto('/');
    const viewport = page.getByTestId('terminal-viewport');
    await viewport.focus();
    await page.keyboard.type('help');
    await page.keyboard.press('Enter');
    await expect(viewport).toContainText('Available local commands: connect <user@host>, pubkey, font <size>, clear, vault');

    // Open New Connection modal via topbar button
    await page.getByTestId('new-connection-btn').click();
    await expect(page.getByTestId('connect-modal')).toBeVisible();
    await page.getByTestId('connect-host-input').fill('edge-01.prod.internal');
    await page.getByTestId('connect-user-input').fill('ubuntu');
    await page.getByTestId('connect-modal-submit-btn').click();

    await expect(page.getByTestId('tab-session-1')).toContainText('ubuntu@edge-01.prod.internal');
    await expect(page.getByTestId('disconnect-btn')).toBeVisible();

    // Disconnect and verify New Connection button returns
    await page.getByTestId('disconnect-btn').click();
    await expect(page.getByTestId('new-connection-btn')).toBeVisible();

    await page.getByTestId('nav-hosts').click();
    await page.getByTestId('import-ssh-config-btn').click();
    await expect(page.getByTestId('host-card-staging-web')).toBeVisible();

    // Trigger red blocking KEY CHANGED modal
    await page.getByTestId('trigger-mismatch-modal-btn').click();
    await expect(page.getByTestId('hostkey-modal')).toContainText('WARNING: REMOTE HOST KEY CHANGED');
    await page.getByTestId('hostkey-confirm-btn').click();

    // Open Command Palette
    await page.getByTestId('open-palette-btn').click();
    await expect(page.getByTestId('command-palette-modal')).toBeVisible();
    await page.getByTestId('command-palette-input').fill('SFTP');
    await page.getByTestId('palette-cmd-nav.files').click();
    await expect(page.getByTestId('screen-files')).toBeVisible();
  });
});
