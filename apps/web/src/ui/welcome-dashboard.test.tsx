import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { jobStore } from '../jobs/job-store';
import type { JobRecord } from '../jobs/types';
import type { WorkspaceRemoteSession } from '../session/adapters';
import { IDE_STORE_KEY } from './ide-storage';
import { WelcomeDashboard } from './WelcomeDashboard';

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function job(id: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    kind: 'install',
    title: `Install ${id}`,
    server: { host: 'web-1', port: 22, user: 'deploy', transport: 'go-gateway' },
    state: 'succeeded',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    steps: [],
    variables: {},
    attached: false,
    ...over
  };
}

type Reply = { stdout?: string; stderr?: string; exitCode?: number };

function fakeSession(replies: (command: string) => Reply | undefined, connected = true): WorkspaceRemoteSession {
  return {
    transport: 'go-gateway',
    host: 'web-1',
    user: 'deploy',
    port: 22,
    isConnected: () => connected,
    exec: vi.fn(async (command: string) => {
      const reply = replies(command);
      return { stdout: reply?.stdout ?? '', stderr: reply?.stderr ?? '', exitCode: reply?.exitCode ?? 0 };
    })
  };
}

const KUBE_OK = (command: string): Reply | undefined => {
  if (command.includes('version --client')) return { stdout: '{"clientVersion":{"gitVersion":"v1.30.0"}}' };
  if (command.includes('auth') && command.includes('can-i')) return { stdout: 'yes\n' };
  if (command.includes('config view')) return { stdout: 'prod staging' };
  if (command.includes('current-context')) return { stdout: 'prod\n' };
  if (command.includes('get') && command.includes('namespaces')) return { stdout: 'default kube-system apps' };
  if (command.includes('get') && command.includes('pods')) {
    return {
      stdout: JSON.stringify({
        items: [
          { metadata: { name: 'a', namespace: 'default' }, status: { phase: 'Running', containerStatuses: [{ ready: true }] } },
          { metadata: { name: 'b', namespace: 'default' }, status: { phase: 'Running', containerStatuses: [{ ready: true }, { ready: false }] } },
          { metadata: { name: 'c', namespace: 'default' }, status: { phase: 'Pending' } }
        ]
      })
    };
  }
  return undefined;
};

describe('WelcomeDashboard', () => {
  let host: HTMLElement;

  beforeEach(async () => {
    window.localStorage.clear();
    for (const existing of await jobStore.list()) await jobStore.remove(existing.id);
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    render(null, host);
    host.remove();
  });

  const mount = async (session: WorkspaceRemoteSession | null, onNavigate = vi.fn()): Promise<ReturnType<typeof vi.fn>> => {
    render(<WelcomeDashboard session={session} onNavigate={onNavigate} />, host);
    await settle();
    return onNavigate;
  };

  const text = (testId: string): string => host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';

  it('renders nothing when there is nothing real to show', async () => {
    await mount(null);
    expect(host.querySelector('[data-testid="welcome-dashboard"]')).toBeNull();
  });

  it('lists editor projects newest first and recent files, and opens the editor', async () => {
    window.localStorage.setItem(
      IDE_STORE_KEY,
      JSON.stringify({
        projects: ['/srv/a', '/srv/b', '/srv/c', '/srv/d', '/srv/e', '/srv/f', '/srv/g'],
        recentFiles: ['/srv/g/main.go', '/srv/g/README.md']
      })
    );
    const onNavigate = await mount(null);
    const projects = [...host.querySelectorAll('[data-testid="welcome-projects"] li')].map((li) => li.textContent);
    expect(projects).toEqual(['/srv/g', '/srv/f', '/srv/e', '/srv/d', '/srv/c']);
    expect(text('welcome-recent-files')).toContain('/srv/g/main.go');
    expect(text('welcome-ide')).toContain('not tied to one host');

    (host.querySelector('[data-testid="welcome-open-ide"]') as HTMLButtonElement).click();
    expect(onNavigate).toHaveBeenCalledWith('ide');
  });

  it('shows stored jobs newest first with their last known state', async () => {
    await jobStore.save(job('old', { createdAt: Date.now() - 3 * 3_600_000, state: 'failed' }));
    await jobStore.save(job('new', { createdAt: Date.now() - 120_000, state: 'detached' }));
    const onNavigate = await mount(null);

    const rows = [...host.querySelectorAll('[data-testid="welcome-job"]')].map((r) => r.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Install new');
    expect(rows[0]).toContain('detached');
    expect(rows[0]).toContain('deploy@web-1:22');
    expect(rows[0]).toContain('2 min ago');
    expect(rows[1]).toContain('failed');
    expect(rows[1]).toContain('3 h ago');
    expect(text('welcome-jobs')).toContain('Last known state');

    (host.querySelector('[data-testid="welcome-open-activity"]') as HTMLButtonElement).click();
    expect(onNavigate).toHaveBeenCalledWith('activity');
  });

  it('shows Kubernetes tiles only while connected, from the real probe', async () => {
    const session = fakeSession(KUBE_OK);
    await mount(session);
    expect(text('welcome-kube-context')).toContain('prod');
    expect(text('welcome-kube-namespaces')).toContain('3');
    expect(text('welcome-kube-pods')).toContain('2 running of 3, 2 not ready');
  });

  it('shows no Kubernetes card when disconnected', async () => {
    const session = fakeSession(KUBE_OK, false);
    await jobStore.save(job('only'));
    await mount(session);
    expect(host.querySelector('[data-testid="welcome-kube"]')).toBeNull();
    expect(session.exec).not.toHaveBeenCalled();
  });

  it('shows no Kubernetes card when kubectl is missing', async () => {
    const session = fakeSession((command) =>
      command.includes('version --client') ? { exitCode: 127, stderr: 'kubectl: command not found' } : undefined
    );
    await jobStore.save(job('only'));
    await mount(session);
    expect(host.querySelector('[data-testid="welcome-kube"]')).toBeNull();
    expect(host.querySelector('[data-testid="welcome-jobs"]')).not.toBeNull();
  });

  it('leaves a tile "not reported" when its own probe is denied, without hiding the rest', async () => {
    const session = fakeSession((command) => {
      if (command.includes('get') && command.includes('pods')) return { exitCode: 1, stderr: 'forbidden: cannot list pods' };
      return KUBE_OK(command);
    });
    await mount(session);
    expect(text('welcome-kube-context')).toContain('prod');
    expect(text('welcome-kube-pods')).toContain('not reported');
  });

  it('survives a corrupt editor store', async () => {
    window.localStorage.setItem(IDE_STORE_KEY, '{not json');
    await jobStore.save(job('still-here'));
    await mount(null);
    expect(host.querySelector('[data-testid="welcome-ide"]')).toBeNull();
    expect(host.querySelector('[data-testid="welcome-jobs"]')).not.toBeNull();
  });
});
