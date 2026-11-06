import type { JSX } from 'preact';
import { Button, Icon, THEME_IDS, type ThemeId } from '@webssh/ui-kit';
import type { ConnectionRegistry } from '../../session/connection-registry';
import type { BrowserSshRelaySessionClient, LiveGatewaySessionClient } from '../../transport';
import type { ConnectionState, PendingJump, ScreenId, SessionTabItem } from '../App';
import type { Setter } from './types';

export type MenuId = 'terminal' | 'edit' | 'view' | 'security' | 'features' | 'more' | null;

type SessionClient = LiveGatewaySessionClient | BrowserSshRelaySessionClient;

/** Traffic lights and the View menu: zen, full screen, theme and font size. */
export interface HeaderView {
  zenMode: boolean;
  setZenMode: Setter<boolean>;
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  activeTheme: ThemeId;
  setActiveTheme: Setter<ThemeId>;
  setFontSize: Setter<number>;
}

export interface HeaderSessionTabs {
  tabs: SessionTabItem[];
  setTabs: Setter<SessionTabItem[]>;
  activeTabId: string;
  setActiveTabId: Setter<string>;
  activeTabIdRef: { current: string };
  setSessionTabLabel: Setter<string>;
  /** The connection's dot class; a tab that is opening, failed or idle shows its own. */
  statusDotClass: string;
  handleAddTab: () => void;
  handleCloseTab: (tabId: string, e?: Event) => void;
}

export interface HeaderConnection {
  connectionState: ConnectionState;
  handleDisconnect: () => void;
  setPendingJump: Setter<PendingJump | null>;
  setConnectModalOpen: Setter<boolean>;
  /** Selecting a tab points the live session at that tab's own transport. */
  liveSessionRef: { current: SessionClient | null };
  connectionRegistryRef: { current: ConnectionRegistry<SessionClient> };
}

/** Edit-menu buffer actions plus the split, broadcast and inspector toggles. */
export interface HeaderTerminal {
  terminalLines: string[];
  setTerminalLines: Setter<string[]>;
  copyToClipboard: (text: string) => void;
  updateCurrentInput: (next: string | ((prev: string) => string)) => void;
  splitPanes: number;
  setSplitPanes: Setter<number>;
  broadcastInput: boolean;
  setBroadcastInput: Setter<boolean>;
  showCommandInspector: boolean;
  setShowCommandInspector: Setter<boolean>;
}

export interface HeaderRecorder {
  recording: boolean;
  startRecording: () => void;
  /** Stops the recording and returns how many events it captured. */
  stopRecording: () => number;
  /** The stop summary is shown in the connection banner. */
  setReconnectNotice: Setter<string | null>;
}

export interface HeaderIde {
  ideMode: boolean;
  setIdeMode: Setter<boolean>;
  redactionMode: boolean;
  setRedactionMode: Setter<boolean>;
}

export interface AppHeaderProps {
  activeScreen: ScreenId;
  setActiveScreen: Setter<ScreenId>;
  /** App closes the open menu on any click outside a menu group. */
  openMenu: MenuId;
  setOpenMenu: Setter<MenuId>;
  /** The authorized_keys append command that the Security menu copies. */
  authorizedKeysSnippet: string;
  view: HeaderView;
  sessionTabs: HeaderSessionTabs;
  connection: HeaderConnection;
  terminal: HeaderTerminal;
  recorder: HeaderRecorder;
  ide: HeaderIde;
}

/**
 * Window title bar (traffic lights and menu bar) and the session tab strip
 * with its quick controls. App renders it only outside zen and full-screen
 * mode; every value and handler comes from App.
 */
export function AppHeader({
  activeScreen,
  setActiveScreen,
  openMenu,
  setOpenMenu,
  authorizedKeysSnippet,
  view,
  sessionTabs,
  connection,
  terminal,
  recorder,
  ide
}: AppHeaderProps): JSX.Element {
  const { zenMode, setZenMode, isFullscreen, toggleFullscreen, activeTheme, setActiveTheme, setFontSize } = view;
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
    handleDisconnect,
    setPendingJump,
    setConnectModalOpen,
    liveSessionRef,
    connectionRegistryRef
  } = connection;
  const {
    terminalLines,
    setTerminalLines,
    copyToClipboard,
    updateCurrentInput,
    splitPanes,
    setSplitPanes,
    broadcastInput,
    setBroadcastInput,
    showCommandInspector,
    setShowCommandInspector
  } = terminal;
  const { recording, startRecording, stopRecording, setReconnectNotice } = recorder;
  const { ideMode, setIdeMode, redactionMode, setRedactionMode } = ide;

  return (
    <>
      {/* 1. macOS Window Title Bar & Native Menu Bar */}
      <div className="webssh-titlebar" data-testid="macos-titlebar">
        <div className="webssh-titlebar-left">
          <div className="webssh-traffic-lights" role="group" aria-label="Window controls">
            <button
              type="button"
              className="webssh-traffic-light webssh-traffic-light--close"
              aria-label="Close session or reset"
              title="Close session / Reset"
              data-testid="traffic-light-close"
              onClick={handleDisconnect}
            />
            <button
              type="button"
              className="webssh-traffic-light webssh-traffic-light--minimize"
              aria-label="Minimize or toggle Zen mode"
              title="Minimize / Toggle Zen Mode"
              data-testid="traffic-light-minimize"
              onClick={() => setZenMode((z) => !z)}
            />
            <button
              type="button"
              className="webssh-traffic-light webssh-traffic-light--fullscreen"
              aria-label="Toggle full screen"
              title="Full Screen"
              data-testid="traffic-light-fullscreen"
              onClick={toggleFullscreen}
            />
          </div>

          <nav className="webssh-menubar" aria-label="Application menu bar" data-testid="macos-menubar">
            <div className="webssh-menu-group" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={`webssh-menu-trigger ${openMenu === 'terminal' ? 'webssh-menu-trigger--open' : ''}`.trim()}
                onClick={() => setOpenMenu((m) => (m === 'terminal' ? null : 'terminal'))}
                data-testid="menu-terminal-btn"
              >
                Terminal
              </button>
              {openMenu === 'terminal' ? (
                <div className="webssh-menu-dropdown" role="menu" data-testid="menu-terminal-dropdown">
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      handleAddTab();
                      setOpenMenu(null);
                    }}
                  >
                    <span>New Tab</span>
                    <span>Cmd+T</span>
                  </button>
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setSplitPanes((n) => (n === 1 ? 2 : 1));
                      setActiveScreen('workspace');
                      setOpenMenu(null);
                    }}
                  >
                    <span>Split Terminal</span>
                    <span>Cmd+D</span>
                  </button>
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      handleDisconnect();
                      setOpenMenu(null);
                    }}
                  >
                    <span>Disconnect</span>
                    <span>Cmd+W</span>
                  </button>
                </div>
              ) : null}
            </div>

            <div className="webssh-menu-group" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={`webssh-menu-trigger ${openMenu === 'edit' ? 'webssh-menu-trigger--open' : ''}`.trim()}
                onClick={() => setOpenMenu((m) => (m === 'edit' ? null : 'edit'))}
                data-testid="menu-edit-btn"
              >
                Edit
              </button>
              {openMenu === 'edit' ? (
                <div className="webssh-menu-dropdown" role="menu" data-testid="menu-edit-dropdown">
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      copyToClipboard(terminalLines.join(String.fromCharCode(10)));
                      setOpenMenu(null);
                    }}
                  >
                    <span>Copy</span>
                    <span>Cmd+C</span>
                  </button>
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      updateCurrentInput((prev) => `${prev}ls -la`);
                      setOpenMenu(null);
                    }}
                  >
                    <span>Paste</span>
                    <span>Cmd+V</span>
                  </button>
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setTerminalLines([]);
                      setOpenMenu(null);
                    }}
                  >
                    <span>Clear Buffer</span>
                    <span>Cmd+K</span>
                  </button>
                </div>
              ) : null}
            </div>

            <div className="webssh-menu-group" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={`webssh-menu-trigger ${openMenu === 'view' ? 'webssh-menu-trigger--open' : ''}`.trim()}
                onClick={() => setOpenMenu((m) => (m === 'view' ? null : 'view'))}
                data-testid="menu-view-btn"
              >
                View
              </button>
              {openMenu === 'view' ? (
                <div className="webssh-menu-dropdown" role="menu" data-testid="menu-view-dropdown">
                  <label className="webssh-menu-field">
                    <span>Theme</span>
                    <select
                      className="ui-select"
                      aria-label="Theme"
                      value={activeTheme}
                      data-testid="theme-quick-switch"
                      onChange={(e) => setActiveTheme((e.currentTarget as HTMLSelectElement).value as ThemeId)}
                    >
                      {THEME_IDS.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="webssh-menu-separator" role="separator" />
                  <button
                    type="button"
                    className="webssh-menu-item"
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
                    className="webssh-menu-item"
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
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setFontSize((s) => Math.min(32, s + 1));
                      setOpenMenu(null);
                    }}
                  >
                    <span>Increase Font Size</span>
                    <span>Cmd++</span>
                  </button>
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setFontSize((s) => Math.max(11, s - 1));
                      setOpenMenu(null);
                    }}
                  >
                    <span>Decrease Font Size</span>
                    <span>Cmd+-</span>
                  </button>
                </div>
              ) : null}
            </div>

            <div className="webssh-menu-group" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={`webssh-menu-trigger ${openMenu === 'security' ? 'webssh-menu-trigger--open' : ''}`.trim()}
                onClick={() => setOpenMenu((m) => (m === 'security' ? null : 'security'))}
                data-testid="menu-security-btn"
              >
                Security
              </button>
              {openMenu === 'security' ? (
                <div className="webssh-menu-dropdown" role="menu" data-testid="menu-security-dropdown">
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setActiveScreen('vault');
                      setOpenMenu(null);
                    }}
                  >
                    <span>Argon2id Key Vault</span>
                  </button>
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setActiveScreen('hosts');
                      setOpenMenu(null);
                    }}
                  >
                    <span>Known Hosts</span>
                  </button>
                  <button
                    type="button"
                    className="webssh-menu-item"
                    role="menuitem"
                    onClick={() => {
                      copyToClipboard(authorizedKeysSnippet);
                      setTerminalLines((prev) => [
                        ...prev,
                        `Deployed Public Key Snippet: ${authorizedKeysSnippet}`
                      ]);
                      setOpenMenu(null);
                    }}
                  >
                    <span>Deploy Public Key</span>
                  </button>
                </div>
              ) : null}
            </div>

            <div className="webssh-menu-group" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={`webssh-menu-trigger ${openMenu === 'features' ? 'webssh-menu-trigger--open' : ''}`.trim()}
                onClick={() => {
                  setActiveScreen('features');
                  setOpenMenu(null);
                }}
                data-testid="menu-features-btn"
              >
                Features
              </button>
            </div>
          </nav>
        </div>

      </div>

      {/* 2 & 3. Studio Session Tab Bar & Right-Side Controls (Stop Square, Fullscreen, Pop-out, More Menu & Custom Options) */}
      <header className="webssh-topbar webssh-studio-toolbar" role="banner">
        <div className="webssh-studio-tabs">
          <div className="webssh-studio-tabs" role="tablist" aria-label="Active SSH sessions">
            {tabs.map((tab, idx) => {
              const isActive = tab.id === activeTabId;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive && activeScreen === 'workspace'}
                  className={`webssh-studio-tab ${isActive && activeScreen === 'workspace' ? 'webssh-studio-tab--active' : ''}`.trim()}
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
                  data-testid={idx === 0 ? 'tab-session-1' : `tab-session-${idx + 1}`}
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
                    aria-label={`Status: ${tab.status ?? (tab.connected ? 'ready' : 'idle')}`}
                  />
                  <span>{tab.title}</span>
                  {tab.status === 'opening' ? <span aria-live="polite">opening…</span> : null}
                  {tab.status === 'error' ? (
                    <span role="status" title={tab.errorMessage}>
                      failed
                    </span>
                  ) : null}
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
          <span className="webssh-studio-tab-separator" data-testid="tab-separator" aria-hidden="true" />
          <button
            type="button"
            className="webssh-studio-add-btn"
            aria-label="New terminal tab"
            title="Add Terminal Session"
            data-testid="add-tab-btn"
            onClick={handleAddTab}
          >
            +
          </button>
        </div>

        <div
          data-testid="topbar-quick-controls"
          className="webssh-studio-controls"
        >
          <Button
            variant={showCommandInspector ? 'primary' : 'ghost'}
            ariaLabel={showCommandInspector ? 'Hide command inspector' : 'Show command inspector'}
            onClick={() => setShowCommandInspector((v) => !v)}
            testId="toggle-command-inspector"
          >
            <Icon name="terminal" />
          </Button>

          {connectionState === 'disconnected' ? (
            <Button
              variant="primary"
              onClick={() => {
                setPendingJump(null);
                setConnectModalOpen(true);
              }}
              testId="new-connection-btn"
            >
              New Connection
            </Button>
          ) : null}

          {/* Disconnect exists only while there is a session to end. */}
          {connectionState === 'connected' ? (
            <button
              type="button"
              className="webssh-studio-stop-btn"
              onClick={handleDisconnect}
              data-testid="disconnect-btn"
              title="End this SSH session"
            >
              <span className="webssh-studio-stop-square" data-testid="stop-red-square" aria-hidden="true" />
              <span>Disconnect</span>
            </button>
          ) : null}

          <Button
            variant={recording ? 'primary' : 'ghost'}
            ariaPressed={recording}
            ariaLabel="Record this terminal session to an asciicast file"
            onClick={() => {
              if (recording) {
                const events = stopRecording();
                setReconnectNotice(
                  events > 0
                    ? `Recording stopped — ${events} event(s) captured. Open Snippets to replay or download.`
                    : 'Recording stopped with no output captured.'
                );
              } else {
                startRecording();
              }
            }}
            disabled={!recording && connectionState !== 'connected'}
            title={recording || connectionState === 'connected' ? undefined : 'Connect to a host to record a session'}
            testId="toggle-recording-btn"
          >
            {recording ? (
              <>
                <span className="webssh-rec-dot" aria-hidden="true" />
                Recording · Stop
              </>
            ) : (
              'Record'
            )}
          </Button>

          {splitPanes > 1 ? (
            <Button
              variant={broadcastInput ? 'primary' : 'ghost'}
              ariaPressed={broadcastInput}
              ariaLabel="Send input to every pane in this session"
              onClick={() => setBroadcastInput((v) => !v)}
              testId="toggle-broadcast-btn"
            >
              Broadcast
            </Button>
          ) : null}

          {ideMode ? (
            <Button
              variant={redactionMode ? 'primary' : 'ghost'}
              onClick={() => setRedactionMode((r) => !r)}
              testId="toggle-redaction-btn"
            >
              {redactionMode ? 'Redaction: ON' : 'Redact Secrets'}
            </Button>
          ) : null}
        </div>

        {/* More Menu (Three Horizontal Gray Dots ⋯) */}
          <div className="webssh-menu-group" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="webssh-studio-icon-btn"
              aria-label="More terminal options"
              title="More Custom Options"
              data-testid="more-options-menu-btn"
              onClick={() => setOpenMenu((m) => (m === 'more' ? null : 'more'))}
            >
              <span aria-hidden="true">•••</span>
            </button>
            {openMenu === 'more' ? (
              <div
                className="webssh-menu-dropdown"
                role="menu"
                data-testid="more-options-dropdown"
                style={{ right: 0, left: 'auto' }}
              >
                <button
                  type="button"
                  className="webssh-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setIdeMode((m) => !m);
                    setOpenMenu(null);
                  }}
                >
                  <span>{ideMode ? 'Disable IDE Mode' : 'Enable IDE Mode'}</span>
                </button>
                <button
                  type="button"
                  className="webssh-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setSplitPanes((n) => (n === 1 ? 2 : 1));
                    setActiveScreen('workspace');
                    setOpenMenu(null);
                  }}
                >
                  <span>Toggle Split Pane</span>
                </button>
                <button
                  type="button"
                  className="webssh-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setRedactionMode((r) => !r);
                    setOpenMenu(null);
                  }}
                >
                  <span>{redactionMode ? 'Disable Secret Redaction' : 'Enable Secret Redaction'}</span>
                </button>
                <button
                  type="button"
                  className="webssh-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setActiveScreen('settings');
                    setOpenMenu(null);
                  }}
                >
                  <span>Themes & Typography Settings</span>
                </button>
                <button
                  type="button"
                  className="webssh-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setActiveScreen('welcome');
                    setOpenMenu(null);
                  }}
                >
                  <span>Quick Connect Welcome Screen</span>
                </button>
              </div>
            ) : null}
        </div>
      </header>
    </>
  );
}
