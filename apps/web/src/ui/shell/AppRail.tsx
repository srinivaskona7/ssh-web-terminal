import type { JSX } from 'preact';
import { Button, Icon } from '@webssh/ui-kit';
import type { LayoutPreset, PreferencesStore, WorkspacePreset } from '../../prefs';
import type { ScreenId } from '../App';
import type { Setter } from './types';

export interface AppRailProps {
  activeScreen: ScreenId;
  setActiveScreen: Setter<ScreenId>;
  workspacePreset: WorkspacePreset;
  applyPreset: (preset: WorkspacePreset) => void;
  /** IDE mode adds the Workspace tools group. */
  ideMode: boolean;
  setIdeMode: Setter<boolean>;
  railWidth: number;
  setRailWidth: Setter<number>;
  /** A right-hand rail drags the other way. */
  layoutPreset: LayoutPreset;
  /** The resizer persists the width when a drag or arrow-key step ends. */
  prefsStore: PreferencesStore;
}

/** Workspace navigation rail and its resize handle. */
export function AppRail({
  activeScreen,
  setActiveScreen,
  workspacePreset,
  applyPreset,
  ideMode,
  setIdeMode,
  railWidth,
  setRailWidth,
  layoutPreset,
  prefsStore
}: AppRailProps): JSX.Element {
  return (
    <>
      <nav
        className="webssh-rail"
        aria-label="Workspace navigation"
        style={{ width: `${railWidth}px` }}
      >
        <div className="webssh-rail-scroll">
          <Button
            variant="ghost"
            className={activeScreen === 'welcome' ? 'webssh-rail-home webssh-rail-home--active' : 'webssh-rail-home'}
            onClick={() => setActiveScreen('welcome')}
            testId="nav-welcome"
          >
            <Icon name="home" /> Home
          </Button>
          <div className="webssh-rail-presets-group">
            <span className="webssh-rail-group-title">Workspace</span>
            <div className="webssh-rail-presets" role="group" aria-label="Workspace preset">
              {(['terminal', 'develop', 'operate'] as const).map((preset) => (
                <Button
                  key={preset}
                  variant={workspacePreset === preset ? 'default' : 'ghost'}
                  ariaPressed={workspacePreset === preset}
                  onClick={() => applyPreset(preset)}
                  testId={`preset-${preset}`}
                >
                  {preset[0]!.toUpperCase() + preset.slice(1)}
                </Button>
              ))}
            </div>
          </div>

          <div className="webssh-rail-group" role="group" aria-label="Sessions">
            <span className="webssh-rail-group-title">Sessions</span>
            <Button
              variant={activeScreen === 'workspace' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('workspace')}
              testId="nav-workspace"
            >
              <Icon name="terminal" /> Terminal
            </Button>
            <Button
              variant={activeScreen === 'overview' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('overview')}
              testId="nav-overview"
            >
              <Icon name="server" /> Servers
            </Button>
            <Button
              variant={activeScreen === 'files' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('files')}
              testId="nav-files"
            >
              <Icon name="folder" /> Files
            </Button>
            <Button
              variant={activeScreen === 'activity' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('activity')}
              testId="nav-activity"
            >
              Activity
            </Button>
          </div>

          <div className="webssh-rail-group" role="group" aria-label="Operations">
            <span className="webssh-rail-group-title">Operations</span>
            <Button
              variant={activeScreen === 'software' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('software')}
              testId="nav-software"
            >
              Software
            </Button>
            <Button
              variant={activeScreen === 'containers' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('containers')}
              testId="nav-containers"
            >
              Containers
            </Button>
            <Button
              variant={activeScreen === 'kubernetes' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('kubernetes')}
              testId="nav-kubernetes"
            >
              Kubernetes
            </Button>
            <Button
              variant={activeScreen === 'automations' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('automations')}
              testId="nav-automations"
            >
              Automations
            </Button>
            <Button
              variant={activeScreen === 'deployments' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('deployments')}
              testId="nav-deployments"
            >
              Deployments
            </Button>
          </div>

          {ideMode ? (
            <div className="webssh-rail-group" role="group" aria-label="Workspace tools" data-testid="sidebar-nav">
              <span className="webssh-rail-group-title">Workspace tools</span>
              <Button
                variant={activeScreen === 'features' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('features')}
                testId="nav-features"
              >
                Features
              </Button>
              <Button
                variant={activeScreen === 'tunnels' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('tunnels')}
                testId="nav-tunnels"
              >
                Port Tunnels
              </Button>
              <Button
                variant={activeScreen === 'vault' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('vault')}
                testId="nav-vault"
              >
                <Icon name="key" /> Key Vault
              </Button>
              <Button
                variant={activeScreen === 'hosts' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('hosts')}
                testId="nav-hosts"
              >
                <Icon name="server" /> Hosts
              </Button>
              <Button
                variant={activeScreen === 'editor' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('editor')}
                testId="nav-editor"
              >
                Editor
              </Button>
              <Button
                variant={activeScreen === 'ide' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('ide')}
                testId="nav-ide"
              >
                Workspace IDE
              </Button>
              <Button
                variant={activeScreen === 'snippets' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('snippets')}
                testId="nav-snippets"
              >
                Snippets &amp; Replay
              </Button>
            </div>
          ) : null}
        </div>

        <div className="webssh-rail-footer">
          <Button
            variant={ideMode ? 'primary' : 'default'}
            ariaPressed={ideMode}
            onClick={() => {
              setIdeMode((prev) => {
                const next = !prev;
                if (next && activeScreen === 'welcome') {
                  setActiveScreen('features');
                }
                return next;
              });
            }}
            testId="enable-ide-mode-btn"
          >
            {ideMode ? 'IDE mode on' : 'Open IDE'}
          </Button>
          <Button
            variant={activeScreen === 'settings' ? 'primary' : 'ghost'}
            onClick={() => setActiveScreen('settings')}
            testId="nav-settings"
          >
            <Icon name="settings" /> Settings
          </Button>
        </div>
      </nav>
      <div
        className="webssh-rail-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize navigation rail"
        aria-valuenow={railWidth}
        aria-valuemin={120}
        aria-valuemax={360}
        tabIndex={0}
        onKeyDown={(e) => {
          const step = e.key === 'ArrowLeft' ? -8 : e.key === 'ArrowRight' ? 8 : 0;
          if (!step) return;
          e.preventDefault();
          setRailWidth((w) => {
            const next = Math.min(360, Math.max(120, w + step));
            prefsStore.update({ railWidthPx: next });
            return next;
          });
        }}
        onPointerDown={(e) => {
          const startX = e.clientX;
          const startWidth = railWidth;
          const target = e.currentTarget as HTMLElement;
          target.setPointerCapture(e.pointerId);
          const onMove = (move: PointerEvent): void => {
            const delta =
              layoutPreset === 'sidebar-right' ? startX - move.clientX : move.clientX - startX;
            setRailWidth(Math.min(360, Math.max(120, startWidth + delta)));
          };
          const onUp = (): void => {
            target.removeEventListener('pointermove', onMove);
            target.removeEventListener('pointerup', onUp);
            setRailWidth((w) => {
              prefsStore.update({ railWidthPx: w });
              return w;
            });
          };
          target.addEventListener('pointermove', onMove);
          target.addEventListener('pointerup', onUp);
        }}
      />
    </>
  );
}
