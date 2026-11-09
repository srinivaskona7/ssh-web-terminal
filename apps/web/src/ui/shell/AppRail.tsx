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
  // Server tools are now reached through the Server Health view's capability sections.

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

          {/* Workspace */}
          <div className="webssh-rail-group" role="group" aria-label="Workspace">
            <span className="webssh-rail-group-title">Workspace</span>
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
              variant={activeScreen === 'overview' ? 'primary' : 'ghost'}
              onClick={() => setActiveScreen('overview')}
              testId="nav-server-health"
            >
              <Icon name="server" /> Server Health
            </Button>
          </div>

          {/* Server Health capability sections are reached via the Server Health view's tabs. */}

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
