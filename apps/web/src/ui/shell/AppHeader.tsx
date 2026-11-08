import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { Button, Icon, type ThemeId } from '@webssh/ui-kit';
import type { ConnectionRegistry } from '../../session/connection-registry';
import type { BrowserSshRelaySessionClient, LiveGatewaySessionClient } from '../../transport';
import type { ConnectionState, PendingJump, ResourceMetrics, ScreenId, SessionTabItem } from '../App';
import type { Setter } from './types';

export type MenuId = 'view' | null;

type SessionClient = LiveGatewaySessionClient | BrowserSshRelaySessionClient;

export interface HeaderView {
  zenMode: boolean;
  setZenMode: Setter<boolean>;
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  activeTheme: ThemeId;
  setActiveTheme: Setter<ThemeId>;
  density: 'comfortable' | 'compact';
  setDensity: Setter<'comfortable' | 'compact'>;
  fontSize: number;
  setFontSize: Setter<number>;
  isRailOpen: boolean;
  toggleRail: () => void;
}

export interface HeaderSessionTabs {
  tabs: SessionTabItem[];
  setTabs: Setter<SessionTabItem[]>;
  activeTabId: string;
  setActiveTabId: Setter<string>;
  activeTabIdRef: { current: string };
  setSessionTabLabel: Setter<string>;
  statusDotClass: string;
  handleAddTab: () => void;
  handleCloseTab: (tabId: string, e?: Event) => void;
}

export interface HeaderConnection {
  connectionState: ConnectionState;
  connectedUser: string;
  connectedHost: string;
  environmentLabel: string;
  rttMs: number;
  resourceMetrics: Map<string, ResourceMetrics>;
  handleDisconnect: () => void;
  setPendingJump: Setter<PendingJump | null>;
  setConnectModalOpen: Setter<boolean>;
  liveSessionRef: { current: SessionClient | null };
  connectionRegistryRef: { current: ConnectionRegistry<SessionClient> };
}

export interface HeaderTerminal {
  splitPanes: number;
  setSplitPanes: Setter<number>;
  broadcastInput: boolean;
  setBroadcastInput: Setter<boolean>;
}

export interface HeaderRecorder {
  recording: boolean;
  startRecording: () => void;
  stopRecording: () => number;
  setReconnectNotice: Setter<string | null>;
}

export interface AppHeaderProps {
  activeScreen: ScreenId;
  setActiveScreen: Setter<ScreenId>;
  openMenu: MenuId;
  setOpenMenu: Setter<MenuId>;
  view: HeaderView;
  sessionTabs: HeaderSessionTabs;
  connection: HeaderConnection;
  terminal: HeaderTerminal;
  recorder: HeaderRecorder;
}

/**
 * Simplified application header.
 *
 * Layout (left to right):
 *   Workspace name  |  Active connection (host · user · state · RTT)  |  Command search (Cmd+K)  |  Settings
 *
 * Below the header sits the session strip (tabs, new tab, split).
 * Rare actions (font, renderer, theme, density) live in the View display menu.
 */
export function AppHeader({
  activeScreen,
  setActiveScreen,
  openMenu,
  setOpenMenu,
  view,
  sessionTabs,
  connection,
  terminal,
  recorder
}: AppHeaderProps): JSX.Element {
  const { zenMode, setZenMode, isFullscreen, toggleFullscreen, activeTheme, setActiveTheme, density, setDensity, fontSize, setFontSize, isRailOpen, toggleRail } = view;
  const {
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    activeTabIdRef,
    setSessionTabLabel,
    statusDotClass,
    handleAddTab,
    handleCloseTab
  } = sessionTabs;
  const {
    connectionState,
    connectedUser,
    connectedHost,
    rttMs,
    resourceMetrics,
    handleDisconnect,
    setPendingJump,
    setConnectModalOpen,
    liveSessionRef,
    connectionRegistryRef
  } = connection;
  const { splitPanes, setSplitPanes, broadcastInput, setBroadcastInput } = terminal;
  const { recording, startRecording, stopRecording, setReconnectNotice } = recorder;

  const onConnectionPage = activeScreen === 'welcome' && connectionState !== 'connected';
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeConnection = connectionRegistryRef.current.get(activeTab?.connectionId);
  const isConnected = connectionState === 'connected' && Boolean(connectedHost);
  const isConnecting = connectionState === 'reconnecting';
  const metrics = activeTab?.connectionId ? resourceMetrics.get(activeTab.connectionId) : undefined;

  const [hoveredMetric, setHoveredMetric] = useState<'cpu' | 'ram' | 'disk' | null>(null);

  const connectionLabel = isConnected
    ? `${connectedUser}@${connectedHost}`
    : connectionState === 'reconnecting'
      ? 'Reconnecting…'
      : 'No active connection';

  return (
    <>
      {/* 1. Header bar: workspace name + active connection + actions */}
      <header className="webssh-header" role="banner">
        <div className="webssh-header-brand">
          <button
            type="button"
            className="webssh-header-menu-toggle"
            aria-label={isRailOpen ? 'Close navigation' : 'Open navigation'}
            title={isRailOpen ? 'Close navigation' : 'Open navigation'}
            onClick={toggleRail}
          >
            <span aria-hidden="true">≡</span>
          </button>
          <Icon name="server" size={16} />
          <span className="webssh-header-workspace">WebSSH Studio</span>
        </div>

        {!onConnectionPage ? (
        <div className="webssh-header-connection">
          <span
            className={`webssh-status-dot ${statusDotClass} ${isConnecting ? 'webssh-status-dot--reconnecting' : ''}`}
            aria-hidden="true"
          />
          <div className="webssh-header-connection-label-group">
            <span className="webssh-header-connection-label">{connectionLabel}</span>
            {connection.environmentLabel ? (
              <span className="webssh-header-environment">{connection.environmentLabel}</span>
            ) : null}
          </div>
          {isConnected && rttMs > 0 ? (
            <span className="webssh-header-connection-rtt">{rttMs} ms</span>
          ) : null}
          {connectionState === 'connected' ? (
            <Button
              variant="ghost"
              onClick={handleDisconnect}
              testId="header-disconnect-btn"
            >
              Disconnect
            </Button>
          ) : connectionState === 'reconnecting' ? (
            <Button
              variant="ghost"
              disabled
              testId="header-reconnecting-btn"
            >
              Reconnecting…
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                setPendingJump(null);
                setConnectModalOpen(true);
              }}
              testId="header-connect-btn"
            >
              Connect
            </Button>
          )}
        </div>
        ) : null}

        <div className="webssh-header-actions">
          <Button
            variant="ghost"
            ariaLabel="Open command palette"
            title="Command Palette (Cmd+K)"
            testId="header-palette-btn"
            onClick={() => {
              // Handled globally in App.tsx via Cmd+K; this button is a fallback.
            }}
          >
            <Icon name="search" size={14} />
          </Button>
          <Button
            variant="ghost"
            ariaLabel="Settings"
            title="Settings"
            onClick={() => setActiveScreen('settings')}
            testId="header-settings-btn"
          >
            <Icon name="settings" size={14} />
          </Button>
        </div>
      </header>

      {/* Rail backdrop (mobile drawer open) */}
      {isRailOpen ? (
        <div
          className="webssh-rail-backdrop"
          onClick={toggleRail}
          onKeyDown={(e) => {
            if (e.key === 'Escape') toggleRail();
          }}
          tabIndex={-1}
          aria-hidden="true"
        />
      ) : null}

      {/* 2. Session strip: tabs + new tab + split controls (workspace only) */}
      {!onConnectionPage ? (
      <div className="webssh-session-strip">
        <div className="webssh-session-tabs" role="tablist" aria-label="Active SSH sessions">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive && activeScreen === 'workspace'}
                className={`webssh-session-tab ${isActive && activeScreen === 'workspace' ? 'webssh-session-tab--active' : ''}`.trim()}
                onClick={() => {
                  setActiveTabId(tab.id);
                  setSessionTabLabel(tab.title);
                  setActiveScreen('workspace');
                  liveSessionRef.current =
                    connectionRegistryRef.current.get(tab.connectionId)?.client ?? null;
                }}
                onDblClick={(e) => {
                  e.preventDefault();
                  const next = window.prompt('Rename session tab', tab.title)?.trim();
                  if (!next) return;
                  setTabs((prev) =>
                    prev.map((item) => (item.id === tab.id ? { ...item, title: next } : item))
                  );
                  if (tab.id === activeTabIdRef.current) setSessionTabLabel(next);
                }}
                title="Double-click to rename"
                data-testid={tab.id === 'tab-1' ? 'tab-session-1' : `tab-session-${tabs.indexOf(tab) + 1}`}
              >
                <span
                  className={`webssh-status-dot ${
                    tab.status === 'error'
                      ? 'webssh-status-dot--offline'
                      : tab.status === 'opening'
                        ? 'webssh-status-dot--reconnecting'
                        : tab.status === 'idle'
                          ? 'webssh-status-dot--disconnected'
                          : statusDotClass
                  }`.trim()}
                  aria-hidden="true"
                />
                <span>{tab.title}</span>
                <span
                  aria-hidden="true"
                  className="webssh-tab-close"
                  data-testid={`close-tab-${tab.id}`}
                  onClick={(e) => handleCloseTab(tab.id, e)}
                >
                  ×
                </span>
              </button>
            );
          })}
        </div>

        {/* Resource strip: CPU / RAM / Disk for the active connection */}
        <div className="webssh-resource-strip">
          {connectionState === 'connected' && connectedHost ? (
            <>
              <span className="webssh-resource-label">{connectedUser}@{connectedHost}</span>
              <div
                className="webssh-resource-metric"
                onClick={() => setActiveScreen('overview')}
                onMouseEnter={() => setHoveredMetric('cpu')}
                onMouseLeave={() => setHoveredMetric(null)}
              >
                <span className="webssh-resource-name">CPU</span>
                <div className="webssh-resource-bar">
                  <div
                    className="webssh-resource-bar-fill"
                    style={{ width: `${metrics?.cpuOverall ?? 0}%` }}
                  />
                </div>
                <span className="webssh-resource-value">{metrics?.cpuOverall ?? '--'}%</span>
              </div>
              <div
                className="webssh-resource-metric"
                onClick={() => setActiveScreen('overview')}
                onMouseEnter={() => setHoveredMetric('ram')}
                onMouseLeave={() => setHoveredMetric(null)}
              >
                <span className="webssh-resource-name">RAM</span>
                <div className="webssh-resource-bar">
                  <div
                    className="webssh-resource-bar-fill"
                    style={{ width: `${metrics?.ramPercent ?? 0}%` }}
                  />
                </div>
                <span className="webssh-resource-value">{metrics?.ramPercent ?? '--'}%</span>
              </div>
              <div
                className="webssh-resource-metric"
                onClick={() => setActiveScreen('overview')}
                onMouseEnter={() => setHoveredMetric('disk')}
                onMouseLeave={() => setHoveredMetric(null)}
              >
                <span className="webssh-resource-name">{metrics?.disk?.[0]?.mountpoint ?? 'Disk'}</span>
                <div className="webssh-resource-bar">
                  <div
                    className="webssh-resource-bar-fill"
                    style={{ width: `${metrics?.disk?.[0]?.percent ?? 0}%` }}
                  />
                </div>
                <span className="webssh-resource-value">
                  {metrics?.disk?.[0]?.percent ?? '--'}%
                </span>
              </div>
              {metrics?.updatedAt && (
                <span className="webssh-resource-updated">
                  updated {Math.floor((Date.now() - metrics.updatedAt) / 1000)}s ago
                </span>
              )}
              {hoveredMetric === 'cpu' && metrics && (
                <div className="webssh-resource-detail webssh-resource-detail--cpu">
                  <div className="webssh-resource-detail-title">CPU Details</div>
                  <div className="webssh-resource-detail-row">
                    <span className="webssh-resource-detail-label">Overall:</span>
                    <span className="webssh-resource-detail-value">{metrics.cpuOverall}%</span>
                  </div>
                  <div className="webssh-resource-detail-row">
                    <span className="webssh-resource-detail-label">Load Avg (1m):</span>
                    <span className="webssh-resource-detail-value">{metrics.loadAvg1}</span>
                  </div>
                  <div className="webssh-resource-detail-row">
                    <span className="webssh-resource-detail-label">Cores:</span>
                    <span className="webssh-resource-detail-value">{metrics.cpuPerCore.length}</span>
                  </div>
                  {metrics.cpuPerCore.length > 0 && (
                    <div className="webssh-resource-detail-percore">
                      <span className="webssh-resource-detail-label">Per-core:</span>
                      {metrics.cpuPerCore.map((p, i) => (
                        <span key={i} className="webssh-resource-detail-core">
                          CPU{i}: {p}%
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {hoveredMetric === 'ram' && metrics && (
                <div className="webssh-resource-detail webssh-resource-detail--ram">
                  <div className="webssh-resource-detail-title">Memory Details</div>
                  <div className="webssh-resource-detail-row">
                    <span className="webssh-resource-detail-label">Usage:</span>
                    <span className="webssh-resource-detail-value">{metrics.ramPercent}%</span>
                  </div>
                  <div className="webssh-resource-detail-row">
                    <span className="webssh-resource-detail-label">Used:</span>
                    <span className="webssh-resource-detail-value">{metrics.ramUsedMiB} MiB</span>
                  </div>
                  <div className="webssh-resource-detail-row">
                    <span className="webssh-resource-detail-label">Total:</span>
                    <span className="webssh-resource-detail-value">{metrics.ramTotalMiB} MiB</span>
                  </div>
                  <div className="webssh-resource-detail-row">
                    <span className="webssh-resource-detail-label">Cache:</span>
                    <span className="webssh-resource-detail-value">{metrics.ramCacheMiB} MiB</span>
                  </div>
                  <div className="webssh-resource-detail-row">
                    <span className="webssh-resource-detail-label">Buffers:</span>
                    <span className="webssh-resource-detail-value">{metrics.ramBuffersMiB} MiB</span>
                  </div>
                  <div className="webssh-resource-detail-row">
                    <span className="webssh-resource-detail-label">Swap:</span>
                    <span className="webssh-resource-detail-value">{metrics.ramSwapPercent}%</span>
                  </div>
                </div>
              )}
              {hoveredMetric === 'disk' && metrics && metrics.disk && (
                <div className="webssh-resource-detail webssh-resource-detail--disk">
                  <div className="webssh-resource-detail-title">Disk Details</div>
                  {metrics.disk.map((d) => (
                    <div key={d.mountpoint} className="webssh-resource-detail-row">
                      <span className="webssh-resource-detail-label">{d.mountpoint}:</span>
                      <span className="webssh-resource-detail-value">
                        {d.usedMiB} / {d.totalMiB} MiB ({d.percent}%)
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <span className="webssh-resource-empty">No active connection</span>
          )}
        </div>
        <Button variant="ghost" className="webssh-resource-mobile-btn" onClick={() => setActiveScreen('overview')} testId="resource-overview-btn">Resources</Button>
        <div className="webssh-session-controls">
          <Button
            variant="ghost"
            ariaLabel="New terminal tab"
            title="New Terminal Tab"
            testId="add-tab-btn"
            onClick={handleAddTab}
          >
            <Icon name="plus" size={14} />
          </Button>
          {splitPanes > 1 ? (
            <Button
              variant={broadcastInput ? 'primary' : 'ghost'}
              ariaPressed={broadcastInput}
              ariaLabel="Send input to every pane in this session"
              testId="toggle-broadcast-btn"
              onClick={() => setBroadcastInput((v) => !v)}
            >
              <Icon name="broadcast" size={14} />
            </Button>
          ) : (
            <Button
              variant="ghost"
              ariaLabel="Split terminal pane"
              title="Split Terminal"
              testId="toggle-split-btn"
              onClick={() => setSplitPanes((n) => (n === 1 ? 2 : 1))}
            >
              <Icon name="split-h" size={14} />
            </Button>
          )}
          {connectionState === 'connected' ? (
            <button
              type="button"
              className="webssh-session-disconnect"
              onClick={handleDisconnect}
              data-testid="disconnect-btn"
              title="End this SSH session"
            >
              <span className="webssh-stop-square" data-testid="stop-red-square" aria-hidden="true" />
              <span>Disconnect</span>
            </button>
          ) : null}
          {recording ? (
            <Button
              variant="primary"
              onClick={() => {
                const events = stopRecording();
                setReconnectNotice(
                  events > 0
                    ? `Recording stopped — ${events} event(s) captured.`
                    : 'Recording stopped with no output captured.'
                );
              }}
              testId="toggle-recording-btn"
            >
              <span className="webssh-rec-dot" aria-hidden="true" />
              Stop Recording
            </Button>
          ) : (
            <Button
              variant="ghost"
              disabled={!isConnected}
              onClick={startRecording}
              testId="toggle-recording-btn"
              title={isConnected ? 'Record this terminal session' : 'Connect to a host to record'}
            >
              <Icon name="play" size={14} />
              Record
            </Button>
          )}
        </div>
      </div>
      ) : null}

      {/* 3. View display menu (font, theme, density, fullscreen, zen, rare actions) */}
      {openMenu === 'view' ? (
        <div className="webssh-view-menu" role="menu" data-testid="view-menu">
          <div className="webssh-view-menu-group">
            <label className="webssh-view-menu-field">
              <span>Theme</span>
              <select
                className="ui-select"
                aria-label="Theme"
                value={activeTheme}
                data-testid="theme-quick-switch"
                onChange={(e) =>
                  setActiveTheme((e.currentTarget as HTMLSelectElement).value as ThemeId)
                }
              >
                {['dark', 'light', 'high-contrast', 'solarized', 'dracula', 'nord', 'gruvbox', 'tokyo-night', 'one-dark'].map(
                  (id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  )
                )}
              </select>
            </label>
            <label className="webssh-view-menu-field">
              <span>Density</span>
              <select
                className="ui-select"
                aria-label="Density"
                value={density}
                data-testid="density-switch"
                onChange={(e) =>
                  setDensity((e.currentTarget as HTMLSelectElement).value as 'comfortable' | 'compact')
                }
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </label>
            <label className="webssh-view-menu-field">
              <span>Font size</span>
              <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                <button
                  type="button"
                  className="webssh-view-menu-item"
                  aria-label="Decrease font size"
                  onClick={() => setFontSize((s) => Math.max(11, s - 1))}
                >
                  −
                </button>
                <span className="webssh-view-menu-font-size">{fontSize}px</span>
                <button
                  type="button"
                  className="webssh-view-menu-item"
                  aria-label="Increase font size"
                  onClick={() => setFontSize((s) => Math.min(32, s + 1))}
                >
                  +
                </button>
              </div>
            </label>
          </div>
          <div className="webssh-view-menu-separator" role="separator" />
          <div className="webssh-view-menu-group">
            <button
              type="button"
              className="webssh-view-menu-item"
              role="menuitemcheckbox"
              aria-checked={zenMode}
              data-testid="toggle-zen-btn"
              onClick={() => {
                setZenMode((z) => !z);
                setOpenMenu(null);
              }}
            >
              <span>{zenMode ? 'Exit Zen Mode' : 'Zen Mode'}</span>
              {zenMode ? <span>Esc</span> : null}
            </button>
            <button
              type="button"
              className="webssh-view-menu-item"
              role="menuitemcheckbox"
              aria-checked={isFullscreen}
              data-testid="toggle-fullscreen-btn"
              onClick={() => {
                toggleFullscreen();
                setOpenMenu(null);
              }}
            >
              <span>{isFullscreen ? 'Exit Full Screen' : 'Full Screen'}</span>
              <span>F11</span>
            </button>
          </div>
        </div>
      ) : null}

      {/* View menu trigger button (⋯) placed at the right edge of the header bar */}
      <button
        type="button"
        className="webssh-view-menu-trigger"
        aria-label="View options"
        title="View options"
        data-testid="view-menu-btn"
        onClick={(e) => {
          e.stopPropagation();
          setOpenMenu((m) => (m === 'view' ? null : 'view'));
        }}
      >
        <span aria-hidden="true">•••</span>
      </button>
    </>
  );
}
