import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Button, Icon } from '@webssh/ui-kit';
import type { LayoutPreset, PreferencesStore, WorkspacePreset } from '../../prefs';
import type { ScreenId } from '../App';
import type { Setter } from './types';

export interface AppRailProps {
  activeScreen: ScreenId;
  setActiveScreen: Setter<ScreenId>;
  workspacePreset: WorkspacePreset;
  applyPreset: (preset: WorkspacePreset) => void;
  railWidth: number;
  setRailWidth: Setter<number>;
  layoutPreset: LayoutPreset;
  prefsStore: PreferencesStore;
  isRailOpen: boolean;
}

/** Screens that belong under the "Server tools" destination. */
const SERVER_TOOL_SCREENS: readonly ScreenId[] = [
  'overview',
  'software',
  'containers',
  'kubernetes',
  'automations',
  'deployments',
  'activity',
  'diagrams',
  'devops',
  'integrated',
  'tunnels'
];

/**
 * Workspace navigation rail.
 *
 * Groups:
 *   Global:        Welcome, Hosts, Settings
 *   Connection:    Terminal, Files, Editor, Server tools
 *
 * Server tools (containers, Kubernetes, software, automations, deployments,
 * activity) are revealed through the "Server tools" entry so the initial
 * navigation stays short. IDE mode is no longer a gate for basic navigation.
 */
export function AppRail({
  activeScreen,
  setActiveScreen,
  workspacePreset,
  applyPreset,
  railWidth,
  setRailWidth,
  layoutPreset,
  prefsStore,
  isRailOpen
}: AppRailProps): JSX.Element {
  const showServerTools = SERVER_TOOL_SCREENS.includes(activeScreen as ScreenId) || activeScreen === 'server-tools';
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <>
      <nav className="webssh-rail" aria-label="Workspace navigation" style={{ width: `${railWidth}px`, transform: isRailOpen ? 'translateX(0)' : 'translateX(-100%)' }}>
        <div className="webssh-rail-scroll">
          {/* Global */}
          <div className="webssh-rail-group" role="group" aria-label="Global">
            <button type="button" className="webssh-rail-group-title" aria-expanded={!collapsed.global} data-testid="rail-toggle-global" onClick={() => toggle('global')}>Global {collapsed.global ? '▸' : '▾'}</button>
            <Button
              variant={activeScreen === 'welcome' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('welcome')}
              testId="nav-welcome"
            >
              <Icon name="home" /> Welcome
            </Button>
            <Button
              variant={activeScreen === 'hosts' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('hosts')}
              testId="nav-hosts"
            >
              <Icon name="server" /> Hosts
            </Button>
          </div>

          {/* Connection */}
          <div className="webssh-rail-group" role="group" aria-label="Connection">
            <span className="webssh-rail-group-title">Connection</span>
            <Button
              variant={activeScreen === 'workspace' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('workspace')}
              testId="nav-terminal"
            >
              <Icon name="terminal" /> Terminal
            </Button>
            <Button
              variant={activeScreen === 'files' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('files')}
              testId="nav-files"
            >
              <Icon name="folder" /> Files
            </Button>
            <Button
              variant={activeScreen === 'editor' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('editor')}
              testId="nav-editor"
            >
              <Icon name="file" /> Editor
            </Button>
            <Button
              variant={activeScreen === 'server-tools' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('server-tools')}
              testId="nav-server-tools"
            >
              <Icon name="settings" /> Server tools
            </Button>
          </div>

          {/* Server tools (expanded when any server tool screen is active) */}
          {showServerTools ? (
            <div className="webssh-rail-group" role="group" aria-label="Server tools">
              <button type="button" className="webssh-rail-group-title" aria-expanded={!collapsed.server} data-testid="rail-toggle-server-tools" onClick={() => toggle('server')}>Server tools {collapsed.server ? '▸' : '▾'}</button>
              <div style={{ display: collapsed.server ? 'none' : 'contents' }}>
              <Button
                variant={activeScreen === 'overview' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('overview')}
                testId="nav-overview"
              >
                <Icon name="server" /> Overview
              </Button>
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
                <Icon name="server" /> Containers
              </Button>
              <Button
                variant={activeScreen === 'kubernetes' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('kubernetes')}
                testId="nav-kubernetes"
              >
                <Icon name="server" /> Kubernetes
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
              <Button
                variant={activeScreen === 'activity' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('activity')}
                testId="nav-activity"
              >
                Activity
              </Button>
              <Button
                variant={activeScreen === 'diagrams' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('diagrams')}
                testId="nav-diagrams"
              >
                <Icon name="command" /> Diagrams
              </Button>
              <Button
                variant={activeScreen === 'devops' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('devops')}
                testId="nav-devops"
              >
                <Icon name="command" /> DevOps
              </Button>
              <Button
                variant={activeScreen === 'integrated' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('integrated')}
                testId="nav-integrated"
              >
                <Icon name="command" /> Integrated
              </Button>
              <Button
                variant={activeScreen === 'tunnels' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('tunnels')}
                testId="nav-tunnels"
              >
                <Icon name="command" /> Tunnels
              </Button>
              </div>
            </div>
          ) : null}

          {/* Vault + snippets (security/productivity, always available) */}
          <div className="webssh-rail-group" role="group" aria-label="Security & productivity">
            <span className="webssh-rail-group-title">Security & productivity</span>
            <Button
              variant={activeScreen === 'vault' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('vault')}
              testId="nav-vault"
            >
              <Icon name="key" /> Key Vault
            </Button>
            <Button
              variant={activeScreen === 'snippets' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('snippets')}
              testId="nav-snippets"
            >
              Snippets & Replay
            </Button>
          </div>
        </div>

        <div className="webssh-rail-footer">
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
