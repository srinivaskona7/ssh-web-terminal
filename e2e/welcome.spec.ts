import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { THEME_IDS } from '../packages/ui-kit/src/generated/tokens';

// The welcome page is the first screen in whichever theme the user saved, so every built-in theme
// is audited: at rest, with a field error, with the success badge, and with the danger badge and connect error.
async function audit(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .include('[data-testid="screen-welcome"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test.describe('Welcome connect page accessibility', () => {
  for (const themeId of THEME_IDS) {
    test(`passes axe WCAG 2.2 AA in the ${themeId} theme, error states included`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'axe-core runs on Chromium, as in webssh.spec.ts');
      await page.addInitScript((id) => {
        localStorage.setItem('webssh.preferences.v2', JSON.stringify({ schemaVersion: 2, activeThemeId: id }));
      }, themeId);

      await page.goto('./');
      await expect(page.getByTestId('screen-welcome')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', themeId);
      expect(await audit(page)).toEqual([]);

      await page.getByTestId('welcome-host-input').fill('example.org');
      await page.getByTestId('welcome-user-input').fill('');
      await page.getByTestId('welcome-connect-submit-btn').click();
      await expect(page.locator('#welcome-user-error')).toHaveText('Username is required.');
      expect(await audit(page)).toEqual([]);

      await page.getByTestId('welcome-user-input').fill('deploy');
      await page.getByTestId('welcome-auth-method-select').selectOption('Private Key (.pem / id_rsa)');
      await page.getByText('Paste key instead').click();
      await expect(page.getByTestId('private-key-chmod-badge')).toContainText('Enforced');
      expect(await audit(page)).toEqual([]);

      await page.getByTestId('private-key-chmod-select').selectOption('0644');
      await page.getByTestId('welcome-connect-submit-btn').click();
      await expect(page.getByTestId('connect-error-badge')).toContainText('Permissions 0644');
      await expect(page.getByTestId('private-key-chmod-badge')).toContainText('UNPROTECTED');
      expect(await audit(page)).toEqual([]);

      await page.getByTestId('welcome-auth-method-select').selectOption('Argon2id Ed25519 Key');
      await page.getByTestId('welcome-connect-submit-btn').click();
      await expect(page.locator('#welcome-browserKey-error')).toHaveText('Generate a browser key first.');
      expect(await audit(page)).toEqual([]);

      await page.getByTestId('welcome-generate-key-btn').click();
      await expect(page.getByTestId('welcome-browser-key-line')).toHaveValue(/^(ssh-ed25519|ecdsa-sha2-nistp256) /);
      await expect(page.getByTestId('welcome-browser-key-fingerprint')).toContainText('SHA256:');
      expect(await audit(page)).toEqual([]);
    });
  }
});

// Layout at the widths the redesign was built for. Phones get touch emulation, so the
// `pointer: coarse` rules apply: 44px targets and 16px text in fields that take typing (iOS zooms on focus otherwise).
const AUTH_METHODS = ['Password', 'Private Key (.pem / id_rsa)', 'Argon2id Ed25519 Key'] as const;

for (const width of [1440, 1024, 768, 390, 320]) {
  const touch = width <= 390;
  test.describe(`Welcome connect page at ${width}px`, () => {
    test.use({ viewport: { width, height: touch ? 740 : 900 }, hasTouch: touch, isMobile: touch });
    test.skip(({ browserName }) => touch && browserName === 'firefox', 'Firefox has no isMobile emulation');

    test(`fits without overflow${touch ? ' and keeps touch targets at 44px' : ''} in every auth mode`, async ({ page }) => {
      await page.goto('./');
      await expect(page.getByTestId('screen-welcome')).toBeVisible();
      for (const auth of AUTH_METHODS) {
        await page.getByTestId('welcome-auth-method-select').selectOption(auth);
        if (auth.startsWith('Private Key')) await page.getByText('Paste key instead').click();
        // The generated key is the longest unbroken line on the page, so it is measured too.
        if (auth.startsWith('Argon2id')) {
          await page.getByTestId('welcome-generate-key-btn').click();
          await expect(page.getByTestId('welcome-browser-key-fingerprint')).toContainText('SHA256:');
        }
        const m = await page.evaluate(() => {
          const root = document.querySelector('[data-testid="screen-welcome"]');
          if (!root) throw new Error('welcome screen missing');
          const vw = document.documentElement.clientWidth;
          const name = (el: Element): string => (el as HTMLElement).dataset.testid || el.id || `${el.tagName}.${el.className}`;
          const shown = [...root.querySelectorAll('*')].filter((el) => (el as HTMLElement).offsetParent !== null);
          return {
            coarse: matchMedia('(pointer: coarse)').matches,
            pageOverflow: document.documentElement.scrollWidth > vw,
            outside: shown.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5); }).map(name),
            short: shown.filter((el) => el.matches('input, select, button, summary') && el.getBoundingClientRect().height < 43.5).map((el) => `${name(el)} ${Math.round(el.getBoundingClientRect().height)}px`),
            smallText: shown.filter((el) => el.matches('input:not([type=file]), select, textarea') && parseFloat(getComputedStyle(el).fontSize) < 16).map(name)
          };
        });
        expect(m.pageOverflow, auth).toBe(false);
        expect(m.outside, auth).toEqual([]);
        expect(m.coarse, auth).toBe(touch);
        if (touch) {
          expect(m.short, auth).toEqual([]);
          expect(m.smallText, auth).toEqual([]);
        }
      }
    });
  });
}
