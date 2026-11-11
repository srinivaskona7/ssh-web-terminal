import type { JSX } from 'preact';
import { useState, useMemo } from 'preact/hooks';
import { Button, Icon, Badge, type IconName } from '@webssh/ui-kit';
import type { LayoutPreset, PreferencesStore, WorkspacePreset } from '../../prefs';
import type { ScreenId, SessionTabItem } from '../App';
import type { HostProfile } from '../../hosts';
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
  recentHosts?: HostProfile[];
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

interface RailGroupState {
  collapsed: boolean;
}

/**
 * Workspace navigation rail.
 *
 * Groups:
 *   Global:        Welcome, Hosts, Settings
 *   Connection:    Terminal, Files, Editor, Server tools
 *   Recents:       Recent host shortcuts (quick reconnect)
 *
 * Server tools (containers, Kubernetes, software, automations, deployments,
 * activity) are revealed through the "Server tools" entry so the initial
 * navigation stays short. IDE mode is no longer a gate for basic navigation.
 *
 * Each group is collapsible; collapsed state lives in this component only.
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
  isRailOpen,
  recentHosts = []
}: AppRailProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    global: false,
    workspace: false,
    recents: false,
    settings: false
  });

  const toggleGroup = (id: string): void => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const serverToolCount = SERVER_TOOL_SCREENS.filter((s) => s !== 'tunnels').length;

  const navItem = (
    id: string,
    label: string,
    icon: IconName,
    active: boolean,
    onClick: () => void,
    badge?: number | string
  ): JSX.Element => (
    <Button
      key={id}
      variant={active ? 'primary' : 'ghost'}
      onClick={onClick}
      testId={`nav-${id}`}
      className="webssh-rail-nav-item"
    >
      <Icon name={icon} size={14} className="webssh-rail-nav-icon" />
      <span className="webssh-rail-nav-label">{label}</span>
      {badge !== undefined ? (
        <span className="webssh-rail-nav-badge">
          <Badge tone="neutral">{badge}</Badge>
        </span>
      ) : null}
    </Button>
  );

  const group = (
    id: string,
    title: string,
    children: JSX.Element | JSX.Element[]
  ): JSX.Element => {
    const isCollapsed = collapsed[id] ?? false;
    return (
      <div key={id} className="webssh-rail-group" role="group" aria-label={title}>
        <div
          className="webssh-rail-group-header"
          onClick={() => toggleGroup(id)}
          role="button"
          tabIndex={0}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand ${title}` : `Collapse ${title}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            padding: 'var(--space-1) var(--space-2)',
            cursor: 'pointer',
            borderRadius: 'var(--radius-sm)',
            userSelect: 'none'
          }}
        >
          <span className="webssh-rail-group-title">{title}</span>
          <span
            className="webssh-rail-group-chevron"
            aria-hidden="true"
            style={{
              transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
              transition: 'transform var(--motion-normal)',
              fontSize: 'var(--font-size-xs)'
            }}
          >
            ▸
          </span>
        </div>
        {!isCollapsed && (
          <div className="webssh-rail-group-body">{children}</div>
        )}
      </div>
    );
  };

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
          {group(
            'global',
            'Global',
            [
              navItem(
                'hosts',
                'Saved Hosts',
                'server',
                activeScreen === 'hosts',
                () => setActiveScreen('hosts'),
                recentHosts.length > 0 ? recentHosts.length : undefined
              ),
              navItem(
                'settings',
                'Settings',
                'settings',
                activeScreen === 'settings',
                () => setActiveScreen('settings')
              )
            ]
          )}

          {/* Workspace */}
          {group(
            'workspace',
            'Workspace',
            [
              navItem(
                'workspace',
                'Terminal',
                'terminal',
                activeScreen === 'workspace',
                () => setActiveScreen('workspace')
              ),
              navItem(
                'files',
                'Files',
                'folder',
                activeScreen === 'files',
                () => setActiveScreen('files')
              ),
              navItem(
                'editor',
                'Editor',
                'file',
                activeScreen === 'editor',
                () => setActiveScreen('editor')
              ),
              navItem(
                'server-tools',
                'Server Tools',
                'server',
                SERVER_TOOL_SCREENS.includes(activeScreen as ScreenId),
                () => setActiveScreen('overview'),
                serverToolCount
              )
            ]
          )}

          {/* Recents (quick reconnect) */}
          {recentHosts.length > 0 && (
            group(
              'recents',
              'Recent Hosts',
              recentHosts.map((host) => {
                const label = `${host.user ?? 'user'}@${host.host}`;
                return navItem(
                  `recent-${host.host}-${host.port}`,
                  label,
                  'server',
                  activeScreen === 'workspace' && connectedHost === host.host && connectedUser === host.user,
                  () => {
                    setActiveScreen('workspace');
                    // Trigger connect via the same path as WelcomeScreen: open connect modal with pre-filled host
                    // We signal the parent through onConnectAnother; the host itself is applied by the caller.
                    void onConnectAnother?.();
                  }
                );
              })
            )
          )}

          {/* Settings footer entry */}
          {group(
            'settings',
            'Settings',
            [
              navItem(
                'settings-footer',
                'Settings',
                'settings',
                activeScreen === 'settings',
                () => setActiveScreen('settings')
              )
            ]
          )}
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
