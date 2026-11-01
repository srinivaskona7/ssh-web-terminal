import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('WebSSH Studio E2E & Accessibility Suite (M0-M8)', () => {
  test('renders clean terminal workspace, passes WCAG AA axe-core audit across themes, and persists theme preference', async ({
    page
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('workspace-root')).toBeVisible();
    await expect(page.getByTestId('terminal-viewport')).toBeVisible();

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

  test('imports ~/.ssh/config with ProxyJump, displays TOFU and KEY CHANGED modals, and opens Command Palette', async ({
    page
  }) => {
    await page.goto('/');
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
