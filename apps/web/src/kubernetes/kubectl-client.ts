import { posixQuote } from '../recipes/engine.js';
import type { RemoteSession } from '../session/remote-session.js';

/**
 * Kubernetes workspace, scoped strictly to an explicitly selected kubeconfig
 * context. The workspace never assumes cluster-admin: every action is whatever
 * the SSH user's kubeconfig is actually authorized to do, and errors are shown
 * verbatim.
 */

export interface KubeContext {
  name: string;
  current: boolean;
}

export interface PodSummary {
  namespace: string;
  name: string;
  phase: string;
  ready: string;
  restarts: number;
  node: string;
  createdAt: string;
  labels: Record<string, string>;
}

export interface WorkloadSummary {
  kind: string;
  namespace: string;
  name: string;
  ready: string;
  available: string;
  age: string;
}

export interface KubeEvent {
  type: string;
  reason: string;
  message: string;
  object: string;
  count: number;
  lastSeen: string;
}

const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i;

function assertName(value: string, what: string): string {
  const trimmed = value.trim();
  if (!NAME_RE.test(trimmed)) throw new Error(`Invalid ${what} "${value}"`);
  return trimmed;
}

function kubectl(args: string[], context?: string, namespace?: string): string {
  const parts = ['kubectl'];
  if (context) parts.push('--context', posixQuote(assertName(context, 'context')));
  if (namespace) parts.push('--namespace', posixQuote(assertName(namespace, 'namespace')));
  parts.push(...args.map(posixQuote));
  return parts.join(' ');
}

function parseJson<T>(text: string, action: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${action} returned invalid JSON`);
  }
}

export class KubernetesClient {
  constructor(
    private readonly session: RemoteSession,
    private readonly context?: string,
    private readonly namespace = 'default'
  ) {}

  private ns(): string {
    return assertName(this.namespace, 'namespace');
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    const result = await this.session.exec('kubectl version --client --output=json', {
      timeoutMs: 20_000
    });
    if (result.exitCode !== 0) {
      return { ok: false, detail: (result.stderr || result.stdout).trim() || 'kubectl is not installed' };
    }
    const canI = await this.session.exec(
      kubectl(['auth', 'can-i', 'list', 'pods', '--all-namespaces'], this.context),
      { timeoutMs: 20_000 }
    );
    const allowed = canI.stdout.trim() === 'yes';
    return {
      ok: true,
      detail: `${result.stdout.trim().slice(0, 200)}${allowed ? '' : ' — no cluster-wide pod visibility; namespace-scoped features only'}`
    };
  }

  async contexts(): Promise<KubeContext[]> {
    const result = await this.session.exec('kubectl config view -o jsonpath={.contexts[*].name}', {
      timeoutMs: 20_000
    });
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout).trim() || 'Unable to read kubeconfig');
    }
    const current = await this.session.exec('kubectl config current-context', { timeoutMs: 15_000 });
    const currentName = current.stdout.trim();
    return result.stdout
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => ({ name, current: name === currentName }));
  }

  async namespaces(): Promise<string[]> {
    const result = await this.session.exec(
      kubectl(['get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}'], this.context),
      { timeoutMs: 30_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout).trim() || 'Unable to list namespaces');
    }
    return result.stdout.split(/\s+/).filter(Boolean);
  }

  async pods(): Promise<PodSummary[]> {
    const result = await this.session.exec(
      kubectl(['get', 'pods', '-o', 'json'], this.context, this.ns()),
      { timeoutMs: 45_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout).trim() || 'Unable to list pods');
    }
    const payload = parseJson<{
      items?: Array<{
        metadata?: {
          name?: string;
          namespace?: string;
          creationTimestamp?: string;
          labels?: Record<string, string>;
        };
        spec?: { nodeName?: string };
        status?: {
          phase?: string;
          containerStatuses?: Array<{ ready?: boolean; restartCount?: number }>;
        };
      }>;
    }>(result.stdout, 'kubectl get pods');

    return (payload.items ?? []).map((item) => {
      const statuses = item.status?.containerStatuses ?? [];
      const readyContainers = statuses.filter((s) => s.ready).length;
      return {
        namespace: item.metadata?.namespace ?? this.ns(),
        name: item.metadata?.name ?? '',
        phase: item.status?.phase ?? 'Unknown',
        ready: `${readyContainers}/${statuses.length}`,
        restarts: statuses.reduce((sum, s) => sum + (s.restartCount ?? 0), 0),
        node: item.spec?.nodeName ?? '',
        createdAt: item.metadata?.creationTimestamp ?? '',
        labels: item.metadata?.labels ?? {}
      };
    });
  }

  async workloads(): Promise<WorkloadSummary[]> {
    const kinds = ['deployments', 'statefulsets', 'daemonsets'];
    const out: WorkloadSummary[] = [];
    for (const kind of kinds) {
      const result = await this.session.exec(
        kubectl(['get', kind, '-o', 'json'], this.context, this.ns()),
        { timeoutMs: 45_000 }
      );
      if (result.exitCode !== 0) continue;
      const payload = parseJson<{
        items?: Array<{
          metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
          status?: { readyReplicas?: number; replicas?: number; availableReplicas?: number };
        }>;
      }>(result.stdout, `kubectl get ${kind}`);
      for (const item of payload.items ?? []) {
        const replicas = item.status?.replicas ?? 0;
        out.push({
          kind: kind.replace(/s$/, ''),
          namespace: item.metadata?.namespace ?? this.ns(),
          name: item.metadata?.name ?? '',
          ready: String(item.status?.readyReplicas ?? 0),
          available: `${item.status?.availableReplicas ?? 0}/${replicas}`,
          age: item.metadata?.creationTimestamp ?? ''
        });
      }
    }
    return out;
  }

  async events(): Promise<KubeEvent[]> {
    const result = await this.session.exec(
      kubectl(['get', 'events', '--sort-by=.lastTimestamp', '-o', 'json'], this.context, this.ns()),
      { timeoutMs: 45_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout).trim() || 'Unable to list events');
    }
    const payload = parseJson<{
      items?: Array<{
        type?: string;
        reason?: string;
        message?: string;
        count?: number;
        lastTimestamp?: string;
        involvedObject?: { kind?: string; name?: string };
      }>;
    }>(result.stdout, 'kubectl get events');
    return (payload.items ?? [])
      .map((item) => ({
        type: item.type ?? '',
        reason: item.reason ?? '',
        message: item.message ?? '',
        object: `${item.involvedObject?.kind ?? ''}/${item.involvedObject?.name ?? ''}`,
        count: item.count ?? 1,
        lastSeen: item.lastTimestamp ?? ''
      }))
      .slice(-200)
      .reverse();
  }

  async podLogs(pod: string, tail = 200, container?: string): Promise<string> {
    const safePod = assertName(pod, 'pod name');
    const args = ['logs', safePod, `--tail=${Math.max(1, Math.min(10_000, tail))}`];
    if (container) args.push('-c', assertName(container, 'container name'));
    const result = await this.session.exec(kubectl(args, this.context, this.ns()), {
      timeoutMs: 60_000
    });
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout).trim() || 'Unable to read pod logs');
    }
    return result.stdout;
  }

  /** Client-side validation + server dry run. Nothing is applied. */
  async applyPreview(manifest: string): Promise<{ ok: boolean; diff: string }> {
    const result = await this.session.exec(
      `printf %s ${posixQuote(btoa(manifest))} | base64 -d | kubectl --context ${posixQuote(
        assertName(this.context ?? 'default', 'context')
      )} diff -f - 2>&1`,
      { timeoutMs: 60_000 }
    );
    // `kubectl diff` exits 1 when there are differences, which is not an error.
    return { ok: result.exitCode === 0 || result.exitCode === 1, diff: result.stdout + result.stderr };
  }

  async apply(manifest: string): Promise<string> {
    const result = await this.session.exec(
      `printf %s ${posixQuote(btoa(manifest))} | base64 -d | kubectl --context ${posixQuote(
        assertName(this.context ?? 'default', 'context')
      )} apply -f -`,
      { timeoutMs: 120_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout).trim() || 'kubectl apply failed');
    }
    return result.stdout + result.stderr;
  }

  async scale(kind: 'deployment' | 'statefulset', name: string, replicas: number): Promise<string> {
    const safeName = assertName(name, `${kind} name`);
    const count = Math.max(0, Math.min(1000, Math.floor(replicas)));
    const result = await this.session.exec(
      kubectl(['scale', `${kind}/${safeName}`, `--replicas=${count}`], this.context, this.ns()),
      { timeoutMs: 120_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout).trim() || 'kubectl scale failed');
    }
    return result.stdout + result.stderr;
  }

  async rolloutRestart(kind: 'deployment' | 'statefulset' | 'daemonset', name: string): Promise<string> {
    const safeName = assertName(name, `${kind} name`);
    const result = await this.session.exec(
      kubectl(['rollout', 'restart', `${kind}/${safeName}`], this.context, this.ns()),
      { timeoutMs: 120_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout).trim() || 'rollout restart failed');
    }
    return result.stdout + result.stderr;
  }

  async rolloutStatus(kind: string, name: string): Promise<string> {
    const safeKind = assertName(kind, 'workload kind').toLowerCase();
    const safeName = assertName(name, 'workload name');
    const result = await this.session.exec(
      kubectl(['rollout', 'status', `${safeKind}/${safeName}`, '--timeout=120s'], this.context, this.ns()),
      { timeoutMs: 150_000 }
    );
    return (result.stdout + result.stderr).trim();
  }

  /**
   * Rollback is only offered for workloads whose controller supports
   * `rollout undo`. It cannot reverse database or external-state changes.
   */
  async rollback(kind: 'deployment', name: string): Promise<string> {
    const safeName = assertName(name, 'deployment name');
    const result = await this.session.exec(
      kubectl(['rollout', 'undo', `${kind}/${safeName}`], this.context, this.ns()),
      { timeoutMs: 150_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout).trim() || 'rollout undo failed');
    }
    return result.stdout + result.stderr;
  }
}
