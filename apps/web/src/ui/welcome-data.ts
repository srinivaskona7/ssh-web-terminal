/**
 * Real, stored or freshly probed data for the Welcome dashboard. Nothing here
 * is invented: a value that could not be read is `null` and renders as
 * "not reported".
 */
import { jobStore, type JobStore } from '../jobs/job-store.js';
import type { JobKind, JobRecord, JobState } from '../jobs/types.js';
import { KubernetesClient } from '../kubernetes/kubectl-client.js';
import type { RemoteSession } from '../session/remote-session.js';

export interface JobSummary {
  id: string;
  title: string;
  kind: JobKind;
  /** The state as last written to this browser's storage, not re-checked on the server. */
  state: JobState;
  server: string;
  createdAt: number;
  endedAt?: number;
}

export function summariseJob(job: JobRecord): JobSummary {
  return {
    id: job.id,
    title: job.title,
    kind: job.kind,
    state: job.state,
    server: `${job.server.user}@${job.server.host}:${job.server.port}`,
    createdAt: job.createdAt,
    endedAt: job.endedAt
  };
}

/** Newest jobs first; a failing store reads as no history, never as an error screen. */
export async function loadRecentJobs(store: Pick<JobStore, 'list'> = jobStore, limit = 5): Promise<JobSummary[]> {
  try {
    const jobs = await store.list();
    return jobs.slice(0, limit).map(summariseJob);
  } catch {
    return [];
  }
}

export interface KubeTiles {
  context: string | null;
  namespaces: number | null;
  /** Pods in the `default` namespace only: that is the one the client lists. */
  pods: { namespace: string; total: number; running: number; notReady: number } | null;
}

export type KubeTilesResult = { ok: true; tiles: KubeTiles } | { ok: false; reason: string };

/**
 * Probe the connected server's kubectl once. Each tile is read independently,
 * so one denied call leaves that tile "not reported" rather than hiding the rest.
 */
export async function loadKubeTiles(session: RemoteSession): Promise<KubeTilesResult> {
  const client = new KubernetesClient(session);
  try {
    const available = await client.available();
    if (!available.ok) return { ok: false, reason: available.detail };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const [contexts, namespaces, pods] = await Promise.allSettled([
    client.contexts(),
    client.namespaces(),
    client.pods()
  ]);

  return {
    ok: true,
    tiles: {
      context: contexts.status === 'fulfilled' ? (contexts.value.find((c) => c.current)?.name ?? null) : null,
      namespaces: namespaces.status === 'fulfilled' ? namespaces.value.length : null,
      pods:
        pods.status === 'fulfilled'
          ? {
              namespace: 'default',
              total: pods.value.length,
              running: pods.value.filter((p) => p.phase === 'Running').length,
              notReady: pods.value.filter((p) => !isFullyReady(p.ready)).length
            }
          : null
    }
  };
}

/** `ready` is kubectl's "1/2" form. Anything unparsable counts as not ready. */
function isFullyReady(ready: string): boolean {
  const match = /^(\d+)\/(\d+)$/.exec(ready.trim());
  return match !== null && match[1] === match[2] && match[2] !== '0';
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". Future or invalid times read as "just now". */
export function formatAgo(timestamp: number, now: number): string {
  const seconds = Math.floor((now - timestamp) / 1000);
  if (!Number.isFinite(seconds) || seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
