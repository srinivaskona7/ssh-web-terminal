import { describe, expect, it } from 'vitest';
import { analyzePodPosture, k8sPostureTool, type PostureIssue } from './k8s-posture.js';
import { fakeSession, notInstalled } from './fake-session.js';

const COMMAND = 'kubectl get pods -A -o json --request-timeout=20s';
const SHA = 'sha256:' + '4f'.repeat(32);

/** Pods as `kubectl get pods -A -o json` prints them, trimmed to the fields that matter. */
function webPod(suffix: string, restarts: number): unknown {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `web-7d9f8c6b5d-${suffix}`,
      namespace: 'shop',
      labels: { app: 'web', 'pod-template-hash': '7d9f8c6b5d' },
      ownerReferences: [
        { apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-7d9f8c6b5d', uid: 'b1', controller: true, blockOwnerDeletion: true }
      ]
    },
    spec: {
      restartPolicy: 'Always',
      securityContext: {},
      containers: [
        {
          name: 'web',
          image: 'nginx:latest',
          imagePullPolicy: 'Always',
          resources: {},
          securityContext: { privileged: true }
        }
      ],
      volumes: [
        { name: 'docker', hostPath: { path: '/var/run/docker.sock', type: 'Socket' } },
        { name: 'kube-api-access-8x2lq', projected: { sources: [] } }
      ]
    },
    status: {
      phase: 'Running',
      containerStatuses: [
        {
          name: 'web',
          image: 'docker.io/library/nginx:latest',
          imageID: `docker.io/library/nginx@${SHA}`,
          ready: true,
          restartCount: restarts,
          lastState: restarts > 0 ? { terminated: { exitCode: 137, reason: 'OOMKilled' } } : {}
        }
      ]
    }
  };
}

const dbPod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: 'db-0',
    namespace: 'data',
    ownerReferences: [{ apiVersion: 'apps/v1', kind: 'StatefulSet', name: 'db', uid: 'c1', controller: true }]
  },
  spec: {
    restartPolicy: 'Always',
    securityContext: { runAsNonRoot: true, runAsUser: 999, fsGroup: 999 },
    containers: [
      {
        name: 'postgres',
        image: `postgres:16.2@${SHA}`,
        resources: { limits: { cpu: '1', memory: '1Gi' }, requests: { cpu: '250m', memory: '512Mi' } },
        readinessProbe: { exec: { command: ['pg_isready'] } },
        livenessProbe: { tcpSocket: { port: 5432 } },
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } }
      }
    ]
  },
  status: { phase: 'Running', containerStatuses: [{ name: 'postgres', restartCount: 4 }] }
};

const agentPod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: 'agent-x7k2p',
    namespace: 'kube-system',
    ownerReferences: [{ apiVersion: 'apps/v1', kind: 'DaemonSet', name: 'agent', uid: 'd1', controller: true }]
  },
  spec: {
    hostNetwork: true,
    hostPID: true,
    containers: [
      {
        name: 'agent',
        image: 'registry.internal:5000/agent',
        resources: { limits: { cpu: '200m' } },
        readinessProbe: { httpGet: { path: '/ready', port: 8080 } },
        securityContext: { runAsUser: 0, allowPrivilegeEscalation: false, capabilities: { add: ['NET_ADMIN', 'cap_sys_admin'] } }
      }
    ]
  },
  status: { phase: 'Running', containerStatuses: [{ name: 'agent', restartCount: 0 }] }
};

const jobPod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: 'backup-28391040-q8z5d',
    namespace: 'data',
    ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'backup-28391040', uid: 'e1', controller: true }]
  },
  spec: {
    restartPolicy: 'OnFailure',
    securityContext: { runAsNonRoot: true, runAsUser: 1000 },
    containers: [
      {
        name: 'backup',
        image: 'ghcr.io/acme/backup:2.4.1',
        resources: { limits: { memory: '256Mi' } },
        securityContext: { allowPrivilegeEscalation: false }
      }
    ]
  },
  status: { phase: 'Succeeded' }
};

const barePod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'debug-shell', namespace: 'default' },
  spec: {
    restartPolicy: 'Never',
    initContainers: [{ name: 'setup', image: 'busybox', securityContext: { privileged: true } }],
    containers: [
      {
        name: 'shell',
        image: `alpine@${SHA}`,
        resources: { limits: { memory: '64Mi' } },
        securityContext: { runAsUser: 1000, allowPrivilegeEscalation: false }
      }
    ]
  },
  status: { phase: 'Running' }
};

const orphanReplicaSetPod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: 'frontend-abc12',
    namespace: 'legacy',
    labels: { tier: 'frontend' },
    ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'frontend', uid: 'f1', controller: true }]
  },
  spec: {
    securityContext: { runAsNonRoot: true },
    containers: [
      {
        name: 'php',
        image: 'php:8.3-apache',
        resources: { limits: { memory: '128Mi' } },
        readinessProbe: { httpGet: { path: '/', port: 80 } },
        livenessProbe: { httpGet: { path: '/', port: 80 } },
        securityContext: { allowPrivilegeEscalation: false }
      }
    ]
  },
  status: { phase: 'Running', containerStatuses: [{ name: 'php', restartCount: 0 }] }
};

const podList = (...items: unknown[]): unknown => ({ apiVersion: 'v1', items, kind: 'List', metadata: { resourceVersion: '' } });

const FULL = podList(webPod('abcde', 7), webPod('fghij', 2), dbPod, agentPod, jobPod, barePod, orphanReplicaSetPod);

function issuesFor(issues: PostureIssue[], workload: string): string[] {
  return issues
    .filter((issue) => issue.workload === workload)
    .map((issue) => `${issue.check}${issue.container ? `/${issue.container}` : ''}`)
    .sort();
}

describe('analyzePodPosture', () => {
  it('groups ReplicaSet pods under their Deployment and counts the pods per issue', () => {
    const report = analyzePodPosture(FULL);
    expect(report.pods).toBe(7);
    expect(issuesFor(report.issues, 'Deployment shop/web')).toEqual(
      ['host-path', 'mutable-image/web', 'no-limits/web', 'no-probes/web', 'privileged/web', 'restarts/web'].sort()
    );
    const privileged = report.issues.find((issue) => issue.check === 'privileged' && issue.workload === 'Deployment shop/web');
    expect(privileged).toMatchObject({ severity: 'critical', namespace: 'shop', container: 'web' });
    expect(privileged?.pods).toEqual(['web-7d9f8c6b5d-abcde', 'web-7d9f8c6b5d-fghij']);
    expect(report.issues.find((issue) => issue.check === 'host-path')?.detail).toContain('/var/run/docker.sock');
  });

  it('keeps a ReplicaSet without a matching pod-template-hash as the ReplicaSet', () => {
    const report = analyzePodPosture(FULL);
    expect(report.workloads.map((workload) => `${workload.kind} ${workload.namespace}/${workload.name}`)).toContain(
      'ReplicaSet legacy/frontend'
    );
    expect(issuesFor(report.issues, 'ReplicaSet legacy/frontend')).toEqual([]);
  });

  it('finds nothing wrong with a pinned, non-root, limited and probed StatefulSet', () => {
    expect(issuesFor(analyzePodPosture(FULL).issues, 'StatefulSet data/db')).toEqual([]);
  });

  it('normalises capability names and reports host namespaces, UID 0 and a missing memory limit', () => {
    const report = analyzePodPosture(FULL);
    expect(issuesFor(report.issues, 'DaemonSet kube-system/agent')).toEqual(
      [
        'dangerous-capabilities/agent',
        'host-namespaces',
        'mutable-image/agent',
        'net-admin/agent',
        'no-limits/agent',
        'no-probes/agent',
        'root-user/agent'
      ].sort()
    );
    const byCheck = new Map(
      report.issues.filter((issue) => issue.workload === 'DaemonSet kube-system/agent').map((issue) => [issue.check, issue])
    );
    expect(byCheck.get('dangerous-capabilities')).toMatchObject({ severity: 'critical', detail: expect.stringContaining('SYS_ADMIN') });
    expect(byCheck.get('net-admin')?.severity).toBe('warning');
    expect(byCheck.get('host-namespaces')?.detail).toMatch(/hostNetwork.*hostPID/);
    expect(byCheck.get('host-namespaces')?.detail).not.toMatch(/hostIPC/);
    expect(byCheck.get('no-limits')?.detail).toMatch(/memory/);
    expect(byCheck.get('no-probes')?.detail).toMatch(/liveness/);
    expect(byCheck.get('no-probes')?.detail).not.toMatch(/readiness/);
    expect(byCheck.get('root-user')?.severity).toBe('warning');
  });

  it('does not ask Jobs or run-once pods for probes, but still checks their init containers', () => {
    const report = analyzePodPosture(FULL);
    expect(issuesFor(report.issues, 'Job data/backup-28391040')).toEqual([]);
    expect(issuesFor(report.issues, 'Pod default/debug-shell')).toEqual(
      ['mutable-image/setup', 'privileged/setup'].sort()
    );
  });

  it('flags root-capable defaults and privilege escalation at lower severity', () => {
    const report = analyzePodPosture(
      podList({
        metadata: { name: 'api', namespace: 'dev' },
        spec: {
          containers: [
            {
              name: 'api',
              image: 'acme/api:1.0',
              resources: { limits: { memory: '1Gi' } },
              readinessProbe: {},
              livenessProbe: {}
            }
          ]
        }
      })
    );
    const issues = report.issues.map((issue) => [issue.check, issue.severity]);
    expect(issues).toEqual(
      expect.arrayContaining([
        ['may-run-as-root', 'info'],
        ['privilege-escalation', 'info']
      ])
    );
    expect(issues).toHaveLength(2);
  });

  it('reports restarts from five upwards with the highest count and last reason', () => {
    const report = analyzePodPosture(podList(webPod('a', 4), webPod('b', 5), webPod('c', 12)));
    const restarts = report.issues.find((issue) => issue.check === 'restarts');
    expect(restarts?.pods).toEqual(['web-7d9f8c6b5d-b', 'web-7d9f8c6b5d-c']);
    expect(restarts?.detail).toMatch(/12 times/);
    expect(restarts?.detail).toMatch(/OOMKilled/);
  });

  it('summarises each workload', () => {
    const report = analyzePodPosture(FULL);
    expect(report.workloads.find((workload) => workload.name === 'web')).toEqual({
      namespace: 'shop',
      kind: 'Deployment',
      name: 'web',
      pods: 2,
      critical: 1,
      warning: 4,
      info: 1
    });
  });

  it('accepts an empty list and rejects JSON that is not a pod list', () => {
    expect(analyzePodPosture(podList())).toEqual({ pods: 0, workloads: [], issues: [] });
    expect(() => analyzePodPosture({ kind: 'Status', status: 'Failure' })).toThrow(/not a pod list/);
    expect(() => analyzePodPosture(null)).toThrow(/not a pod list/);
  });

  it('tolerates pods with missing spec fields instead of inventing values', () => {
    const report = analyzePodPosture(podList({ metadata: { name: 'odd', namespace: 'x' } }, { spec: { containers: 'nope' } }));
    expect(report.pods).toBe(2);
    expect(report.issues).toEqual([]);
  });
});

describe('k8sPostureTool', () => {
  it('previews and sends exactly one kubectl command', async () => {
    expect(k8sPostureTool.preview({})).toEqual([COMMAND]);
    const { session, commands } = fakeSession({ [COMMAND]: { stdout: JSON.stringify(FULL) } });
    const result = await k8sPostureTool.run(session, {});
    expect(commands).toEqual([COMMAND]);
    expect(result.status).toBe('ok');
    expect(result.summary).toMatch(/7 pods in 6 workloads/);
    expect(result.findings.find((finding) => finding.subject === 'Deployment shop/web' && finding.severity === 'critical')).toMatchObject({
      title: expect.stringMatching(/privileged/i),
      detail: expect.stringMatching(/2 pods/)
    });
    expect(result.tables.map((table) => table.id)).toEqual(['workloads', 'issues']);
    expect(result.evidence[0]).toMatchObject({ command: COMMAND, exitCode: 0 });
  });

  it('reports a server without kubectl as unavailable', async () => {
    const { session } = fakeSession({ [COMMAND]: notInstalled('kubectl') });
    const result = await k8sPostureTool.run(session, {});
    expect(result).toMatchObject({ status: 'unavailable', findings: [], tables: [] });
  });

  it("reports no cluster access as an error carrying kubectl's own message", async () => {
    const refused =
      'The connection to the server localhost:8080 was refused - did you specify the right host or port?\n';
    const { session } = fakeSession({ [COMMAND]: { exitCode: 1, stderr: refused } });
    const result = await k8sPostureTool.run(session, {});
    expect(result.status).toBe('error');
    expect(result.summary).toContain('localhost:8080 was refused');
    expect(result.findings).toEqual([]);
  });

  it('explains a forbidden cluster-wide list', async () => {
    const forbidden =
      'Error from server (Forbidden): pods is forbidden: User "ops" cannot list resource "pods" in API group "" at the cluster scope\n';
    const { session } = fakeSession({ [COMMAND]: { exitCode: 1, stderr: forbidden } });
    const result = await k8sPostureTool.run(session, {});
    expect(result.status).toBe('error');
    expect(result.notes.join(' ')).toMatch(/all namespaces/);
  });

  it('reports truncated JSON as an error and says when the transport may have cut it', async () => {
    const small = fakeSession({ [COMMAND]: { stdout: '{"apiVersion":"v1","items":[{"metadata":' } });
    const smallResult = await k8sPostureTool.run(small.session, {});
    expect(smallResult.status).toBe('error');
    expect(smallResult.summary).toMatch(/not valid JSON/);
    expect(smallResult.notes).toEqual([]);

    const big = fakeSession({ [COMMAND]: { stdout: '{"items":[' + '{"metadata":{}},'.repeat(270_000) } });
    const bigResult = await k8sPostureTool.run(big.session, {});
    expect(bigResult.status).toBe('error');
    expect(bigResult.notes.join(' ')).toMatch(/4 MiB/);
  });

  it('says so when there are no pods', async () => {
    const { session } = fakeSession({ [COMMAND]: { stdout: JSON.stringify(podList()) } });
    const result = await k8sPostureTool.run(session, {});
    expect(result.status).toBe('ok');
    expect(result.summary).toMatch(/No pods/);
    expect(result.findings).toEqual([expect.objectContaining({ severity: 'ok' })]);
  });

  it('caps the findings, keeping the most severe, and says how many were left out', async () => {
    // Ten privileged pods (critical) and 390 that only may run as root (info): 400 findings.
    const pods = Array.from({ length: 400 }, (_, index) => ({
      metadata: { name: `p${index}`, namespace: 'bulk' },
      spec: {
        containers: [
          {
            name: 'c',
            image: 'acme/app:1.0',
            resources: { limits: { memory: '1Gi' } },
            readinessProbe: {},
            livenessProbe: {},
            securityContext: index < 10 ? { privileged: true } : { allowPrivilegeEscalation: false }
          }
        ]
      }
    }));
    const { session } = fakeSession({ [COMMAND]: { stdout: JSON.stringify(podList(...pods)) } });
    const result = await k8sPostureTool.run(session, {});
    expect(result.findings).toHaveLength(300);
    expect(result.findings.filter((finding) => finding.severity === 'critical')).toHaveLength(10);
    expect(result.notes.join(' ')).toMatch(/100 more/);
    expect(result.tables.find((table) => table.id === 'issues')?.rows).toHaveLength(400);
  });
});
