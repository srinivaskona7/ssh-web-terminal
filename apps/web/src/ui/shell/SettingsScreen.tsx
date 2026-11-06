import type { JSX } from 'preact';
import { Badge, Button, Card, THEME_IDS, type ThemeId } from '@webssh/ui-kit';
import type { CursorShape, LayoutPreset, PreferencesStore } from '../../prefs';
import { repairApplicationAssetCaches } from '../ErrorBoundary';
import type { KeybindingRegistry } from '../productivity';
import type { Setter } from './types';

export type SettingsSection = 'appearance' | 'keyboard' | 'maintenance';

/** Font, theme, layout and cursor; the layout buttons also write the preference store. */
export interface SettingsAppearance {
  fontFamily: string;
  setFontFamily: Setter<string>;
  fontSize: number;
  setFontSize: Setter<number>;
  activeTheme: ThemeId;
  setActiveTheme: Setter<ThemeId>;
  layoutPreset: LayoutPreset;
  setLayoutPreset: Setter<LayoutPreset>;
  cursorShape: CursorShape;
  setCursorShape: Setter<CursorShape>;
  prefsStore: PreferencesStore;
}

export interface SettingsScreenProps {
  settingsSection: SettingsSection;
  setSettingsSection: Setter<SettingsSection>;
  appearance: SettingsAppearance;
  keybindings: KeybindingRegistry;
  cacheRepairStatus: string;
  setCacheRepairStatus: Setter<string>;
}

/**
 * Settings: appearance, keyboard and maintenance sections. App keeps the
 * selected section, so returning to Settings reopens the same one.
 */
export function SettingsScreen({
  settingsSection,
  setSettingsSection,
  appearance,
  keybindings,
  cacheRepairStatus,
  setCacheRepairStatus
}: SettingsScreenProps): JSX.Element {
  const {
    fontFamily,
    setFontFamily,
    fontSize,
    setFontSize,
    activeTheme,
    setActiveTheme,
    layoutPreset,
    setLayoutPreset,
    cursorShape,
    setCursorShape,
    prefsStore
  } = appearance;

  return (
    <div className="webssh-panel-content" data-testid="screen-settings">
      <h1>Settings</h1>
      <p className="ws-mod-muted">
        Appearance, shortcuts and maintenance. Connection and terminal behaviour live in
        their own screens.
      </p>
      <div className="ws-mod-filters" role="group" aria-label="Settings sections">
        {([
          ['appearance', 'Appearance'],
          ['keyboard', 'Keyboard'],
          ['maintenance', 'Maintenance']
        ] as const).map(([id, label]) => (
          <Button
            key={id}
            variant={settingsSection === id ? 'primary' : 'default'}
            ariaPressed={settingsSection === id}
            testId={`settings-tab-${id}`}
            onClick={() => setSettingsSection(id)}
          >
            {label}
          </Button>
        ))}
      </div>
      {settingsSection === 'appearance' ? (
        <>
      <Card>
        <h2>Terminal Font</h2>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
    <select
        className="ui-select"
        aria-label="Terminal font family"
        data-testid="font-family-select"
        value={fontFamily}
        onChange={(e) => setFontFamily((e.currentTarget as HTMLSelectElement).value)}
        style={{ width: 'auto' }}
      >
        <option value="'DejaVu Sans Mono', Menlo, monospace">DejaVu Sans Mono</option>
        <option value="SF Mono">SF Mono</option>
        <option value="'JetBrains Mono', 'Fira Code', monospace">JetBrains Mono</option>
        <option value="Fira Code">Fira Code</option>
        <option value="Menlo">Menlo</option>
        <option value="Monaco">Monaco</option>
        <option value="Courier New">Courier New</option>
      </select>

      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
        <Button
          variant="ghost"
          ariaLabel="Decrease font size"
          testId="font-size-dec-btn"
          onClick={() => setFontSize((s) => Math.max(11, s - 1))}
        >
          A-
        </Button>
        <span className="font-size-badge" data-testid="font-size-badge">
          {fontSize}px
        </span>
        <Button
          variant="ghost"
          ariaLabel="Increase font size"
          testId="font-size-inc-btn"
          onClick={() => setFontSize((s) => Math.min(32, s + 1))}
        >
          A+
        </Button>
      </div>
        </div>
      </Card>
      <Card>
        <h2>Theme Selector</h2>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {THEME_IDS.map((id) => (
            <Button
              key={id}
              variant={id === activeTheme ? 'primary' : 'default'}
              onClick={() => setActiveTheme(id)}
              testId={`theme-btn-${id}`}
            >
              {id}
            </Button>
          ))}
        </div>
      </Card>
      <Card>
        <h2>Workspace Layout & Cursor Geometry</h2>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button
            variant={layoutPreset === 'sidebar-left' ? 'primary' : 'default'}
            onClick={() => { setLayoutPreset('sidebar-left'); prefsStore.update({ layoutPreset: 'sidebar-left' }); }}
          >
            Sidebar Left
          </Button>
          <Button
            variant={layoutPreset === 'sidebar-right' ? 'primary' : 'default'}
            onClick={() => { setLayoutPreset('sidebar-right'); prefsStore.update({ layoutPreset: 'sidebar-right' }); }}
          >
            Sidebar Right
          </Button>
          <Button
            variant={cursorShape === 'block' ? 'primary' : 'default'}
            onClick={() => setCursorShape('block')}
          >
            Cursor: Block
          </Button>
          <Button
            variant={cursorShape === 'bar' ? 'primary' : 'default'}
            onClick={() => setCursorShape('bar')}
          >
            Cursor: Bar
          </Button>
          <Button
            variant={cursorShape === 'underline' ? 'primary' : 'default'}
            onClick={() => setCursorShape('underline')}
          >
            Cursor: Underline
          </Button>
        </div>
      </Card>
        </>
      ) : null}
      {settingsSection === 'keyboard' ? (
      <Card>
        <h2>Keybindings</h2>
        <ul>
          {keybindings.list().map((kb) => (
            <li key={kb.actionId}>
              <strong>{kb.description}:</strong> <code>{kb.shortcut}</code>
            </li>
          ))}
        </ul>
      </Card>
      ) : null}
      {settingsSection === 'maintenance' ? (
      <Card testId="settings-asset-cache-card">
        <h2>Application Asset Cache Recovery</h2>
        <p>
          Purge Service Worker and static bundle caches without clearing your saved SSH hosts, non-extractable Key Vault keys, or user preferences.
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            variant="default"
            testId="settings-repair-cache-btn"
            onClick={() => {
              void repairApplicationAssetCaches().then((res) => {
                setCacheRepairStatus(
                  `Cleared ${res.deletedCaches.length} asset cache(s) and unregistered ${res.unregisteredServiceWorkers} service worker(s). Saved hosts, keys, and settings preserved.`
                );
              });
            }}
          >
            Repair Application Asset Cache
          </Button>
          {cacheRepairStatus ? (
            <Badge tone="success" testId="settings-repair-cache-status">
              {cacheRepairStatus}
            </Badge>
          ) : null}
        </div>
      </Card>
      ) : null}
    </div>
  );
}
