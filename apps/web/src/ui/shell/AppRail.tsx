import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Button, Icon } from '@webssh/ui-kit';
import type { LayoutPreset, PreferencesStore, WorkspacePreset } from '../../prefs';
import type { ScreenId } from '../App';
import type { Setter } from './types';

export interface AppRailProps {
  activeScreen: ScreenId;
  setActiveScreen: Setter<ScreenId>;
  connectedHost?: string;
  connectedUser?: string;
  connectedPort?: number;
  onConnectAnother?: () => void;
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
  connectedHost,
  connectedUser,
  connectedPort,
  onConnectAnother,
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
        <div style={{ padding: 'var(--space-2)', borderBottom: 'var(--border-hairline)' }} data-testid="host-switcher">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
            <span className="webssh-status-dot webssh-status-dot--connected" aria-hidden="true" />
            <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{connectedHost ? `${connectedUser}@${connectedHost}:${connectedPort}` : 'No host'}</strong>
          </div>
          <Button variant="ghost" onClick={() => onConnectAnother?.()} testId="connect-another-btn">Connect another server</Button>
        </div>
        <div className="webssh-rail-scroll">
          {/* Global */}
          <div className="webssh-rail-group" role="group" aria-label="Global">
            <span className="webssh-rail-group-title">Global</span>
            <Button
              variant={activeScreen === 'hosts' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('hosts')}
              testId="nav-hosts"
            >
              <Icon name="server" /> Saved Hosts
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
                variant={activeScreen === 'tunnels' ? 'primary' : 'ghost'}
                onClick={() => setActiveScreen('tunnels')}
                testId="nav-tunnels"
              >
                <Icon name="command" /> Tunnels
              </Button>
              </div>
            </div>
          ) : null}

          {/* Settings footer entry */}
          <div className="webssh-rail-group" role="group" aria-label="Settings">
            <Button
              variant={activeScreen === 'settings' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('settings')}
              testId="nav-settings"
            >
              <Icon name="settings" /> Settings
            </Button>
          </div>
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
