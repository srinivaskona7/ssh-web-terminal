import type { JSX } from 'preact';
import { Badge, Button, Card, THEME_IDS, type ThemeId } from '@webssh/ui-kit';
import type { CursorShape, LayoutPreset, PreferencesStore } from '../../prefs';
import { repairApplicationAssetCaches } from '../ErrorBoundary';
import type { KeybindingRegistry } from '../productivity';
import type { Setter } from './types';

export type SettingsSection = 'appearance' | 'keyboard' | 'maintenance' | 'administrator';

/** Font, theme, layout and cursor; the layout buttons also write the preference store. */
export interface SettingsAppearance {
  fontFamily: string;
  setFontFamily: Setter<string>;
  fontSize: number;
  setFontSize: Setter<number>;
  lineHeight: number;
  setLineHeight: Setter<number>;
  activeTheme: ThemeId;
  setActiveTheme: Setter<ThemeId>;
  layoutPreset: LayoutPreset;
  setLayoutPreset: Setter<LayoutPreset>;
  cursorShape: CursorShape;
  setCursorShape: Setter<CursorShape>;
  prefsStore: PreferencesStore;
}

export interface SettingsAdministrator {
  transportMode: string;
  setTransportMode: (m: string) => void;
  gatewayUrl: string;
  setGatewayUrl: Setter<string>;
  gatewayAuthToken: string;
  setGatewayAuthToken: Setter<string>;
  gatewayProbeStatus: { ok: boolean; message: string } | null;
  setGatewayProbeStatus: Setter<{ ok: boolean; message: string } | null>;
  handleTestGateway: (rawUrl?: string) => Promise<void>;
  relaySessionUser: string;
  relayLoginUser: string;
  setRelayLoginUser: Setter<string>;
  relayLoginPass: string;
  setRelayLoginPass: Setter<string>;
  handleRelayLogin: () => Promise<void>;
  handleRelaySignOut: () => void;
}

export interface SettingsScreenProps {
  settingsSection: SettingsSection;
  setSettingsSection: Setter<SettingsSection>;
  appearance: SettingsAppearance;
  keybindings: KeybindingRegistry;
  cacheRepairStatus: string;
  setCacheRepairStatus: Setter<string>;
  administrator?: SettingsAdministrator;
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
  setCacheRepairStatus,
  administrator
}: SettingsScreenProps): JSX.Element {
  const {
    fontFamily,
    setFontFamily,
    fontSize,
    setFontSize,
    lineHeight,
    setLineHeight,
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
          ['maintenance', 'Maintenance'],
          ['administrator', 'Administrator']
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
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}>
          <Button variant="ghost" testId="font-preset-compact" onClick={() => { setFontSize(14); setLineHeight(1.2); }}>Compact 14px</Button>
          <Button variant="ghost" testId="font-preset-default" onClick={() => { setFontSize(15); setLineHeight(1.25); }}>Default 15px</Button>
          <Button variant="ghost" testId="font-preset-teaching" onClick={() => { setFontSize(18); setLineHeight(1.35); }}>Teaching 18px</Button>
        </div>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: `${fontSize}px`, marginTop: 'var(--space-2)', border: 'var(--border-hairline)', borderRadius: 'var(--radius-md)', padding: 'var(--space-2)' }} data-testid="font-preview">
          <span>Sample terminal</span>
          <div style={{ fontSize: 'var(--font-size-xs)' }}>AaBbGg 0123456789 $ stty size</div>
        </div>
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
      {settingsSection === 'administrator' && administrator ? (
      <Card testId="admin-transport-settings">
        <h2>Administrator — Relay &amp; Gateway</h2>
        <p className="ws-mod-muted">Connection endpoints and accounts. Saved in this browser only; never sent except to the relay/gateway you connect to.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
          {administrator.relaySessionUser ? (
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <Badge tone="success">Signed in as {administrator.relaySessionUser}</Badge>
              <Button variant="ghost" testId="product-sign-out-btn" onClick={() => administrator.handleRelaySignOut()}>Sign out</Button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end' }} data-testid="product-sign-in">
              <div style={{ flex: 1, minWidth: '160px' }}><label htmlFor="product-sign-in-user">Username</label><input id="product-sign-in-user" type="text" className="ui-input" value={administrator.relayLoginUser} onInput={(e) => administrator.setRelayLoginUser((e.target as HTMLInputElement).value)} data-testid="product-sign-in-user" /></div>
              <div style={{ flex: 1, minWidth: '160px' }}><label htmlFor="product-sign-in-pass">Password</label><input id="product-sign-in-pass" type="password" className="ui-input" value={administrator.relayLoginPass} onInput={(e) => administrator.setRelayLoginPass((e.target as HTMLInputElement).value)} data-testid="product-sign-in-pass" /></div>
              <Button variant="default" testId="product-sign-in-submit" onClick={() => void administrator.handleRelayLogin()}>Sign in</Button>
            </div>
          )}
          <label htmlFor="welcome-transport-mode-select">SSH Transport Mode</label>
          <select id="welcome-transport-mode-select" className="ui-input" value={administrator.transportMode} onChange={(e) => { const m = (e.target as HTMLSelectElement).value; administrator.setTransportMode(m); try { globalThis.localStorage?.setItem('webssh.transport.mode', m); } catch {} }} data-testid="welcome-transport-mode-select">
            <option value="go-gateway">Go SSH/SFTP Gateway (Full PTY + SFTP + Editor + Tunnels + 4 MiB Resume)</option>
            <option value="cloudflare-relay">Cloudflare Worker SSH Relay (Terminal, tabs; SFTP via gateway preferred)</option>
          </select>
          <label htmlFor="welcome-gateway-url-input">{administrator.transportMode === 'cloudflare-relay' ? 'Relay endpoint (wss://…/ws)' : 'Gateway endpoint (wss://…/ws)'}</label>
          <input id="welcome-gateway-url-input" type="text" className="ui-input" value={administrator.gatewayUrl} onInput={(e) => { const v = (e.target as HTMLInputElement).value; administrator.setGatewayUrl(v); administrator.setGatewayProbeStatus(null); try { globalThis.localStorage?.setItem('webssh.gateway.wsUrl', v); } catch {} }} data-testid="welcome-gateway-url-input" />
          <label htmlFor="welcome-gateway-token-input">Gateway Auth Token (optional)</label>
          <input id="welcome-gateway-token-input" type="password" className="ui-input" value={administrator.gatewayAuthToken} onInput={(e) => { const v = (e.target as HTMLInputElement).value; administrator.setGatewayAuthToken(v); try { globalThis.sessionStorage?.setItem('webssh.gateway.authToken', v); } catch {} }} data-testid="welcome-gateway-token-input" />
          <Button variant="default" testId="test-gateway-btn" onClick={() => void administrator.handleTestGateway(administrator.gatewayUrl)}>Test Gateway</Button>
          {administrator.gatewayProbeStatus ? <Badge tone={administrator.gatewayProbeStatus.ok ? 'success' : 'danger'} testId="gateway-probe-badge">{administrator.gatewayProbeStatus.message}</Badge> : null}
        </div>
      </Card>
      ) : null}
    </div>
  );
}
