import { describe, expect, it } from 'vitest';
import {
  PreferencesStore,
  migratePreferences,
  validateCustomThemeContrast,
  type CustomThemeDefinition
} from './index';

const sampleCustomTheme: CustomThemeDefinition = {
  id: 'custom-midnight',
  name: 'Custom Midnight',
  background: '#0B0F17',
  foreground: '#E5E7EB',
  cursor: '#38BDF8',
  selection: '#1E293B',
  ansi: {
    black: '#111827',
    red: '#F87171',
    green: '#4ADE80',
    yellow: '#FACC15',
    blue: '#60A5FA',
    magenta: '#C084FC',
    cyan: '#22D3EE',
    white: '#F3F4F6',
    brightBlack: '#4B5563',
    brightRed: '#FCA5A5',
    brightGreen: '#86EFAC',
    brightYellow: '#FDE047',
    brightBlue: '#93C5FD',
    brightMagenta: '#D8B4FE',
    brightCyan: '#67E8F9',
    brightWhite: '#FFFFFF'
  }
};

describe('PreferencesStore, theme editor, per-host overrides, and v1->v2 migration (M6)', () => {
  it('migrates v1 preferences to schemaVersion 2 and clamps hard limits', () => {
    const migrated = migratePreferences({
      schemaVersion: 1,
      theme: 'dracula',
      fontSize: 42,
      fontFamily: 'Fira Code',
      layout: 'zen'
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.activeThemeId).toBe('dracula');
    expect(migrated.typography.fontSize).toBe(28); // Clamped to hard max
    expect(migrated.typography.fontFamily).toBe('Fira Code');
    expect(migrated.layoutPreset).toBe('zen');
  });

  it('validates WCAG AA contrast on custom themes and persists across reload', () => {
    const store = new PreferencesStore('webssh.test.prefs');
    const check = store.saveCustomTheme(sampleCustomTheme);
    expect(check.passesAA).toBe(true);
    expect(check.ratio).toBeGreaterThanOrEqual(4.5);

    store.setHostOverride({
      hostId: 'prod-1',
      themeId: 'custom-midnight',
      fontSize: 15,
      layoutPreset: 'compact'
    });

    const resolved = store.resolveForHost('prod-1');
    expect(resolved.themeId).toBe('custom-midnight');
    expect(resolved.fontSize).toBe(15);
    expect(resolved.layoutPreset).toBe('compact');

    const exported = store.exportJson();
    const reloaded = new PreferencesStore('webssh.test.prefs.reload');
    reloaded.importJson(exported);
    expect(reloaded.resolveForHost('prod-1').themeId).toBe('custom-midnight');
    expect(reloaded.listThemeIds()).toContain('custom-midnight');
  });

  it('flags low-contrast custom themes', () => {
    const lowContrast: CustomThemeDefinition = {
      ...sampleCustomTheme,
      background: '#1E293B',
      foreground: '#334155'
    };
    const res = validateCustomThemeContrast(lowContrast);
    expect(res.passesAA).toBe(false);
  });

  it('recovers only malformed preference fields while preserving valid user settings', () => {
    const recovered = migratePreferences({
      schemaVersion: 2,
      activeThemeId: 'deleted-nonexistent-theme',
      layoutPreset: 'invalid-layout',
      typography: {
        fontFamily: 'Fira Code',
        fontSize: Number.NaN,
        lineHeight: null
      },
      surface: null,
      storageLimits: 'corrupted'
    });
    expect(recovered.activeThemeId).toBe('light');
    expect(recovered.layoutPreset).toBe('sidebar-left');
    expect(recovered.typography.fontFamily).toBe('Fira Code');
    expect(recovered.typography.fontSize).toBe(13);
    expect(recovered.typography.lineHeight).toBe(1.45);
    expect(recovered.surface.cursorShape).toBe('block');
    expect(recovered.storageLimits.maxScrollbackLines).toBe(10_000);
  });
});
