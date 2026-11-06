/**
 * Kubernetes workload posture from `kubectl get pods -A -o json`.
 *
 * Each pod spec is checked for the settings that widen a container's reach
 * into its node (privileged mode, host namespaces, hostPath volumes, added
 * capabilities, root) and for the gaps that hurt reliability (no limits, no
 * probes, mutable image tags, crash loops). Findings are grouped by the
 * workload that owns the pods, so a Deployment with thirty replicas reports
 * each problem once with a pod count.
 */
import { isCommandMissing, makeResult, runEvidence } from '../../exec.js';
import type { DevOpsTool, Finding, FindingSeverity, ResultTable } from '../../types.js';
import { parseImageRef, tagProblem } from './image-ref.js';
import { errorText, firstLines, isRecord, record, records, text, type Json } from './json.js';

export type PostureCheck =
  | 'privileged'
  | 'dangerous-capabilities'
  | 'net-admin'
  | 'host-namespaces'
  | 'host-path'
  | 'root-user'
  | 'may-run-as-root'
  | 'privilege-escalation'
  | 'no-limits'
  | 'no-probes'
  | 'mutable-image'
  | 'restarts';

export interface PostureIssue {
  check: PostureCheck;
  severity: FindingSeverity;
  /** Owning workload, e.g. "Deployment shop/web". */
  workload: string;
  namespace: string;
  /** Null for pod-level settings (host namespaces, hostPath volumes). */
  container: string | null;
  pods: string[];
  detail: string;
}

export interface WorkloadPosture {
  namespace: string;
  kind: string;
  name: string;
  pods: number;
  critical: number;
  warning: number;
  info: number;
}

export interface PostureReport {
  pods: number;
  workloads: WorkloadPosture[];
  issues: PostureIssue[];
}

export const K8S_POSTURE_COMMAND = 'kubectl get pods -A -o json --request-timeout=20s';
export const RESTART_THRESHOLD = 5;
const FINDINGS_CAP = 300;
const TABLE_CAP = 2000;
/** The relay keeps at most 4 MiB of a command's output. */
const CUT_OFF_HINT_CHARS = 3 * 1024 * 1024;
export const KUBECTL_FORBIDDEN_NOTE =
  'Listing pods in all namespaces needs list permission on pods at cluster scope (for example the view ClusterRole).';

const SEVERITY: Record<PostureCheck, FindingSeverity> = {
  privileged: 'critical',
  'dangerous-capabilities': 'critical',
  'net-admin': 'warning',
  'host-namespaces': 'warning',
  'host-path': 'warning',
  'root-user': 'warning',
  'may-run-as-root': 'info',
  'privilege-escalation': 'info',
  'no-limits': 'warning',
  'no-probes': 'info',
  'mutable-image': 'warning',
  restarts: 'warning'
};

const TITLES: Record<PostureCheck, string> = {
  privileged: 'Privileged container',
  'dangerous-capabilities': 'Container adds SYS_ADMIN or ALL capabilities',
  'net-admin': 'Container adds NET_ADMIN',
  'host-namespaces': 'Pod shares host namespaces',
  'host-path': 'Pod mounts a hostPath volume',
  'root-user': 'Container runs as UID 0',
  'may-run-as-root': 'Container may run as root',
  'privilege-escalation': 'Privilege escalation not disabled',
  'no-limits': 'Missing resource limits',
  'no-probes': 'Missing health probes',
  'mutable-image': 'Mutable image tag',
  restarts: 'Container keeps restarting'
};

const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2, ok: 3 };
const RUNTIME_SOCKET = /(?:docker|containerd|crio|cri-dockerd)\.sock$|^\/var\/run\/(?:docker|containerd)\/?$/;

/** A pod list as kubectl prints it; anything else is refused rather than read as empty. */
export function podItems(podList: unknown): Json[] {
  if (!isRecord(podList) || !Array.isArray(podList.items)) {
    throw new Error('kubectl output is not a pod list (no items array)');
  }
  return podList.items.filter(isRecord);
}

/** Notes for kubectl output that did not parse; a cut-off transport is the usual cause. */
export function unparsedKubectlNotes(stdout: string): string[] {
  return stdout.length >= CUT_OFF_HINT_CHARS
    ? ["Output this large was probably cut off by the connection, which keeps at most 4 MiB of a command's output."]
    : [];
}

/** The workload a pod belongs to; ReplicaSets created by a Deployment report the Deployment. */
export function owningWorkload(metadata: Json, podName: string): { kind: string; name: string; ownerKind: string | null } {
  const owners = records(metadata.ownerReferences);
  const owner = owners.find((candidate) => candidate.controller === true) ?? owners[0];
  const ownerKind = owner ? text(owner.kind) : null;
  const ownerName = owner ? text(owner.name) : null;
  if (!ownerKind || !ownerName || ownerKind === 'Node') return { kind: 'Pod', name: podName, ownerKind };
  if (ownerKind === 'ReplicaSet') {
    const hash = text(record(metadata.labels)['pod-template-hash']);
    if (hash && ownerName.endsWith(`-${hash}`)) {
      return { kind: 'Deployment', name: ownerName.slice(0, -hash.length - 1), ownerKind };
    }
  }
  return { kind: ownerKind, name: ownerName, ownerKind };
}

interface Accumulator {
  issue: PostureIssue;
  maxRestarts: number;
  lastReason: string | null;
}

export function analyzePodPosture(podList: unknown): PostureReport {
  const pods = podItems(podList);
  const workloads = new Map<string, WorkloadPosture & { podNames: Set<string> }>();
  const found = new Map<string, Accumulator>();

  for (const pod of pods) {
    const metadata = record(pod.metadata);
    const spec = record(pod.spec);
    const status = record(pod.status);
    const podName = text(metadata.name) ?? '(unnamed)';
    const namespace = text(metadata.namespace) ?? '(unknown)';
    const owner = owningWorkload(metadata, podName);
    const label = `${owner.kind} ${namespace}/${owner.name}`;

    let workload = workloads.get(label);
    if (!workload) {
      workload = { namespace, kind: owner.kind, name: owner.name, pods: 0, critical: 0, warning: 0, info: 0, podNames: new Set() };
      workloads.set(label, workload);
    }
    workload.podNames.add(podName);

    const add = (check: PostureCheck, container: string | null, detail: string, restarts?: { count: number; reason: string | null }): void => {
      const key = `${label}|${check}|${container ?? ''}`;
      let entry = found.get(key);
      if (!entry) {
        entry = {
          issue: { check, severity: SEVERITY[check], workload: label, namespace, container, pods: [], detail },
          maxRestarts: 0,
          lastReason: null
        };
        found.set(key, entry);
      }
      if (!entry.issue.pods.includes(podName)) entry.issue.pods.push(podName);
      if (restarts && restarts.count > entry.maxRestarts) {
        entry.maxRestarts = restarts.count;
        entry.lastReason = restarts.reason;
      }
    };

    const shared = (['hostNetwork', 'hostPID', 'hostIPC'] as const).filter((key) => spec[key] === true);
    if (shared.length > 0) {
      add('host-namespaces', null, `${shared.join(', ')} enabled: the pod shares ${shared.length === 1 ? 'that namespace' : 'those namespaces'} with the node`);
    }
    const hostPaths = records(spec.volumes)
      .filter((volume) => isRecord(volume.hostPath))
      .map((volume) => text(record(volume.hostPath).path) ?? '(no path)');
    if (hostPaths.length > 0) {
      const socket = hostPaths.some((path) => RUNTIME_SOCKET.test(path));
      add(
        'host-path',
        null,
        `mounts ${hostPaths.join(', ')} from the node${socket ? '; the container runtime socket is equivalent to root on the node' : ''}`
      );
    }

    const restartPolicy = text(spec.restartPolicy) ?? 'Always';
    const probesExpected = restartPolicy === 'Always' && owner.ownerKind !== 'Job';
    const podSecurity = record(spec.securityContext);
    const groups: Array<{ init: boolean; containers: Json[] }> = [
      { init: false, containers: records(spec.containers) },
      { init: true, containers: records(spec.initContainers) }
    ];
    for (const { init, containers } of groups) {
      for (const container of containers) {
        const name = text(container.name) ?? '(unnamed)';
        const security = record(container.securityContext);
        if (security.privileged === true) {
          // Privileged already means every capability, any user and full device access.
          add('privileged', name, "securityContext.privileged is true: the container has every capability and the node's devices");
        } else {
          const capabilities = (Array.isArray(record(security.capabilities).add) ? (record(security.capabilities).add as unknown[]) : [])
            .filter((cap): cap is string => typeof cap === 'string')
            .map((cap) => cap.toUpperCase().replace(/^CAP_/, ''));
          const dangerous = capabilities.filter((cap) => cap === 'ALL' || cap === 'SYS_ADMIN');
          if (dangerous.length > 0) add('dangerous-capabilities', name, `capabilities.add includes ${dangerous.join(', ')}, close to full root on the node`);
          if (capabilities.includes('NET_ADMIN')) add('net-admin', name, 'capabilities.add includes NET_ADMIN: it can reconfigure interfaces, routes and firewall rules');

          const runAsUser = typeof security.runAsUser === 'number' ? security.runAsUser : typeof podSecurity.runAsUser === 'number' ? podSecurity.runAsUser : null;
          const runAsNonRoot =
            typeof security.runAsNonRoot === 'boolean' ? security.runAsNonRoot : typeof podSecurity.runAsNonRoot === 'boolean' ? podSecurity.runAsNonRoot : null;
          if (runAsUser === 0) add('root-user', name, 'runAsUser is 0');
          else if (runAsUser === null && runAsNonRoot !== true) {
            add('may-run-as-root', name, "neither runAsNonRoot nor runAsUser is set, so the image's own user applies, which is often root");
          }
          if (security.allowPrivilegeEscalation !== false) {
            add('privilege-escalation', name, 'allowPrivilegeEscalation is not false, so setuid binaries can gain privileges');
          }
        }

        const image = text(container.image);
        const ref = image ? parseImageRef(image) : null;
        const problem = ref ? tagProblem(ref) : null;
        if (image && problem) {
          add(
            'mutable-image',
            name,
            `${image} ${problem === 'latest' ? 'uses the latest tag' : 'has no tag, so it means latest'}; a restart can pull a different image`
          );
        }

        if (init) continue;
        const limits = record(record(container.resources).limits);
        if (Object.keys(limits).length === 0) add('no-limits', name, 'no CPU or memory limit is set');
        else if (!('memory' in limits)) add('no-limits', name, 'no memory limit, so it can take memory from every other pod on the node');
        if (probesExpected) {
          const missing = [!container.readinessProbe && 'readiness', !container.livenessProbe && 'liveness'].filter(
            (probe): probe is string => typeof probe === 'string'
          );
          if (missing.length > 0) add('no-probes', name, `no ${missing.join(' or ')} probe`);
        }
      }
    }

    for (const containerStatus of records(status.containerStatuses)) {
      const count = typeof containerStatus.restartCount === 'number' ? containerStatus.restartCount : 0;
      if (count < RESTART_THRESHOLD) continue;
      const terminated = record(record(containerStatus.lastState).terminated);
      const reason = text(terminated.reason);
      const exit = typeof terminated.exitCode === 'number' ? ` (exit ${terminated.exitCode})` : '';
      add('restarts', text(containerStatus.name) ?? '(unnamed)', '', { count, reason: reason ? `${reason}${exit}` : null });
    }
  }

  const issues = [...found.values()].map(({ issue, maxRestarts, lastReason }) =>
    issue.check === 'restarts'
      ? { ...issue, detail: `restarted up to ${maxRestarts} times${lastReason ? `; last termination: ${lastReason}` : ''}` }
      : issue
  );
  issues.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.workload.localeCompare(b.workload) ||
      a.check.localeCompare(b.check) ||
      (a.container ?? '').localeCompare(b.container ?? '')
  );
  for (const issue of issues) {
    const workload = workloads.get(issue.workload);
    if (workload && issue.severity !== 'ok') workload[issue.severity] += 1;
  }
  const summary = [...workloads.values()]
    .map(({ podNames, ...rest }) => ({ ...rest, pods: podNames.size }))
    .sort(
      (a, b) =>
        b.critical - a.critical ||
        b.warning - a.warning ||
        b.info - a.info ||
        a.namespace.localeCompare(b.namespace) ||
        a.name.localeCompare(b.name)
    );
  return { pods: pods.length, workloads: summary, issues };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function podList(names: string[]): string {
  const shown = names.slice(0, 5).join(', ');
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
}

export const k8sPostureTool: DevOpsTool = {
  id: 'k8s-posture',
  group: 'delivery',
  title: 'Kubernetes workload posture',
  description:
    "Lists the pods the server's kubeconfig can see and checks privileged mode, host namespaces and hostPath mounts, added capabilities, root users, limits, probes, mutable image tags and crash loops, grouped by owning workload.",
  requires: ['kubectl'],
  preview: () => [K8S_POSTURE_COMMAND],
  async run(session) {
    const probe = await runEvidence(session, K8S_POSTURE_COMMAND, 60_000);
    const evidence = [probe.evidence];
    if (isCommandMissing(probe.exitCode, probe.stderr)) {
      return makeResult('unavailable', 'kubectl is not installed on this server', { evidence });
    }
    if (probe.exitCode !== 0) {
      const message = firstLines(probe.stderr || probe.stdout) || `kubectl exited with ${probe.exitCode}`;
      const notes = /forbidden/i.test(probe.stderr) ? [KUBECTL_FORBIDDEN_NOTE] : [];
      return makeResult('error', `kubectl could not list pods: ${message}`, { notes, evidence });
    }

    let report: PostureReport;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(probe.stdout);
      } catch (err) {
        return makeResult('error', `kubectl returned ${probe.stdout.length} characters that are not valid JSON (${errorText(err)})`, {
          notes: unparsedKubectlNotes(probe.stdout),
          evidence
        });
      }
      report = analyzePodPosture(parsed);
    } catch (err) {
      return makeResult('error', errorText(err), { evidence });
    }

    if (report.pods === 0) {
      return makeResult('ok', 'No pods in any namespace this kubeconfig can see', {
        findings: [{ severity: 'ok', title: 'No pods to check' }],
        evidence
      });
    }

    const notes: string[] = [];
    const findings: Finding[] = report.issues.slice(0, FINDINGS_CAP).map((issue) => ({
      severity: issue.severity,
      title: `${TITLES[issue.check]}${issue.container ? ` (${issue.container})` : ''}`,
      detail: `${issue.detail}; ${plural(issue.pods.length, 'pod')}: ${podList(issue.pods)}`,
      subject: issue.workload
    }));
    if (report.issues.length > FINDINGS_CAP) {
      notes.push(
        `Showing the ${FINDINGS_CAP} most severe of ${report.issues.length} findings; ${report.issues.length - FINDINGS_CAP} more are in the issues table.`
      );
    }
    if (report.issues.length > TABLE_CAP) notes.push(`The issues table lists the first ${TABLE_CAP} of ${report.issues.length}.`);
    if (findings.length === 0) findings.push({ severity: 'ok', title: 'No posture issues found' });

    const workloadsTable: ResultTable = {
      id: 'workloads',
      title: 'Workloads',
      columns: [
        { key: 'namespace', label: 'Namespace' },
        { key: 'kind', label: 'Kind' },
        { key: 'name', label: 'Name' },
        { key: 'pods', label: 'Pods', numeric: true },
        { key: 'critical', label: 'Critical', numeric: true },
        { key: 'warning', label: 'Warning', numeric: true },
        { key: 'info', label: 'Info', numeric: true }
      ],
      rows: report.workloads.map((workload) => ({ ...workload }))
    };
    const issuesTable: ResultTable = {
      id: 'issues',
      title: 'Issues',
      columns: [
        { key: 'severity', label: 'Severity' },
        { key: 'workload', label: 'Workload' },
        { key: 'container', label: 'Container' },
        { key: 'check', label: 'Check' },
        { key: 'pods', label: 'Pods', numeric: true },
        { key: 'detail', label: 'Detail' }
      ],
      rows: report.issues.slice(0, TABLE_CAP).map((issue) => ({
        severity: issue.severity,
        workload: issue.workload,
        container: issue.container ?? '(pod spec)',
        check: issue.check,
        pods: issue.pods.length,
        detail: issue.detail
      }))
    };
    const count = (severity: FindingSeverity): number => report.issues.filter((issue) => issue.severity === severity).length;
    const summary = `${plural(report.pods, 'pod')} in ${plural(report.workloads.length, 'workload')}: ${count('critical')} critical, ${count('warning')} warning, ${count('info')} info`;
    return makeResult('ok', summary, { findings, tables: [workloadsTable, issuesTable], notes, evidence });
  }
};
