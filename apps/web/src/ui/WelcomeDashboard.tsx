/**
 * Welcome dashboard: what this browser remembers (editor projects and files,
 * job history) plus live Kubernetes tiles while a server is connected.
 *
 * Every figure comes from storage or a probe that actually ran. Job states are
 * labelled "last known" because a detached job may have finished since.
 */
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Badge, Button, Card } from '@webssh/ui-kit';
import { isActiveJobState, type JobState } from '../jobs/types.js';
import type { WorkspaceRemoteSession } from '../session/adapters.js';
import { readIdeRecents, type IdeRecents } from './ide-storage';
import {
  formatAgo,
  loadKubeTiles,
  loadRecentJobs,
  type JobSummary,
  type KubeTilesResult
} from './welcome-data';
import './welcome-dashboard.css';

export type DashboardScreen = 'ide' | 'activity' | 'kubernetes';

export interface WelcomeDashboardProps {
  session: WorkspaceRemoteSession | null;
  onNavigate: (screen: DashboardScreen) => void;
}

const LIST_LIMIT = 5;

function jobTone(state: JobState): 'neutral' | 'success' | 'warning' | 'danger' {
  if (state === 'succeeded') return 'success';
  if (state === 'failed' || state === 'verification_failed' || state === 'lost') return 'danger';
  if (isActiveJobState(state)) return 'warning';
  return 'neutral';
}

function NotReported(): JSX.Element {
  return <span className="welcome-dash-missing">not reported</span>;
}

export function WelcomeDashboard({ session, onNavigate }: WelcomeDashboardProps): JSX.Element | null {
  const [recents] = useState<IdeRecents>(() => readIdeRecents());
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [kube, setKube] = useState<KubeTilesResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadRecentJobs(undefined, LIST_LIMIT).then((loaded) => {
      if (!cancelled) setJobs(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const connected = session !== null && session.isConnected();
  useEffect(() => {
    let cancelled = false;
    setKube(null);
    if (!session || !connected) return undefined;
    void loadKubeTiles(session).then((result) => {
      if (!cancelled) setKube(result);
    });
    return () => {
      cancelled = true;
    };
  }, [session, connected]);

  const hasIde = recents.projects.length + recents.recentFiles.length > 0;
  const tiles = kube && kube.ok ? kube.tiles : null;
  if (!hasIde && jobs.length === 0 && !tiles) return null;

  const now = Date.now();
  return (
    <div className="welcome-dash" data-testid="welcome-dashboard">
      {hasIde ? (
        <Card testId="welcome-ide" className="welcome-dash-card">
          <h3 className="welcome-dash-title">Workspace editor</h3>
          {recents.projects.length > 0 ? (
            <>
              <h4 className="welcome-dash-sub">Projects</h4>
              <ul className="welcome-dash-list" data-testid="welcome-projects">
                {recents.projects
                  .slice(-LIST_LIMIT)
                  .reverse()
                  .map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
              </ul>
            </>
          ) : null}
          {recents.recentFiles.length > 0 ? (
            <>
              <h4 className="welcome-dash-sub">Recent files</h4>
              <ul className="welcome-dash-list" data-testid="welcome-recent-files">
                {recents.recentFiles.slice(0, LIST_LIMIT).map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="welcome-dash-note">Remembered by this browser; not tied to one host.</p>
          <Button testId="welcome-open-ide" onClick={() => onNavigate('ide')}>
            Open editor
          </Button>
        </Card>
      ) : null}

      {jobs.length > 0 ? (
        <Card testId="welcome-jobs" className="welcome-dash-card">
          <h3 className="welcome-dash-title">Recent jobs</h3>
          <p className="welcome-dash-note">Last known state, from this browser. A detached job may have finished since.</p>
          <ul className="welcome-dash-list" data-testid="welcome-job-list">
            {jobs.map((job) => (
              <li key={job.id} className="welcome-dash-job" data-testid="welcome-job">
                <span className="welcome-dash-job-title">{job.title}</span>
                <Badge tone={jobTone(job.state)}>{job.state.replace(/_/g, ' ')}</Badge>
                <span className="welcome-dash-meta">
                  {job.server} · {formatAgo(job.createdAt, now)}
                </span>
              </li>
            ))}
          </ul>
          <Button testId="welcome-open-activity" onClick={() => onNavigate('activity')}>
            Open activity
          </Button>
        </Card>
      ) : null}

      {tiles ? (
        <Card testId="welcome-kube" className="welcome-dash-card">
          <h3 className="welcome-dash-title">Kubernetes</h3>
          <dl className="welcome-dash-tiles">
            <div className="welcome-dash-tile" data-testid="welcome-kube-context">
              <dt>Context</dt>
              <dd>{tiles.context ?? <NotReported />}</dd>
            </div>
            <div className="welcome-dash-tile" data-testid="welcome-kube-namespaces">
              <dt>Namespaces</dt>
              <dd>{tiles.namespaces ?? <NotReported />}</dd>
            </div>
            <div className="welcome-dash-tile" data-testid="welcome-kube-pods">
              <dt>Pods in {tiles.pods?.namespace ?? 'default'}</dt>
              <dd>
                {tiles.pods ? (
                  <>
                    {tiles.pods.running} running of {tiles.pods.total}
                    {tiles.pods.notReady > 0 ? `, ${tiles.pods.notReady} not ready` : ''}
                  </>
                ) : (
                  <NotReported />
                )}
              </dd>
            </div>
          </dl>
          <Button testId="welcome-open-kubernetes" onClick={() => onNavigate('kubernetes')}>
            Open Kubernetes
          </Button>
        </Card>
      ) : null}
    </div>
  );
}
