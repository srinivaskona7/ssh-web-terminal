import { describe, expect, it } from 'vitest';
import { THEMES, THEME_IDS, TOKENS } from './generated/tokens.js';
import { auditThemeContrast, getContrastRatio, meetsWcagAA } from './contrast.js';

describe('@webssh/ui-kit design tokens and WCAG AA contrast', () => {
  it('includes all 9 required themes with complete 16-color ANSI palettes', () => {
    expect(THEME_IDS).toEqual([
      'dark',
      'light',
      'high-contrast',
      'solarized',
      'dracula',
      'nord',
      'gruvbox',
      'tokyo-night',
      'one-dark'
    ]);
    for (const id of THEME_IDS) {
      const theme = THEMES[id];
      expect(theme).toBeDefined();
      expect(Object.keys(theme.ansi)).toHaveLength(16);
    }
  });

  it('enforces 8px grid, 12px panel radius, and max 200ms motion tokens', () => {
    expect(TOKENS.spacing['2']).toBe('8px');
    expect(TOKENS.spacing.terminalInset).toBe('8px');
    expect(TOKENS.radius.panel).toBe('12px');
    expect(TOKENS.motion.max.startsWith('200ms')).toBe(true);
  });

  it('passes WCAG AA contrast (>= 4.5:1) across every built-in theme', () => {
    for (const id of THEME_IDS) {
      const audit = auditThemeContrast(THEMES[id]);
      expect(audit.passesAA, `Theme ${id} failed WCAG AA contrast: ${JSON.stringify(audit)}`).toBe(true);
      expect(meetsWcagAA(THEMES[id].fgPrimary, THEMES[id].bgSurface)).toBe(true);
    }
    expect(getContrastRatio('#ffffff', '#000000')).toBe(21);
  });
});
