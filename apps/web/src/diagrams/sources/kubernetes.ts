/**
 * Kubernetes source: builder (pure, from parsed kubectl JSON) and collector.
 *
 * Secret and ConfigMap objects are never fetched, only their names and
 * namespaces, so the diagram can show which ones a Pod references. Every
 * object kept as evidence is redacted first.
 */
import type { DiagramEdge, DiagramNode, FieldValue, NodeKind, NodeStatus, SourceBuild } from '../model.js';
import {
  clip,
  compareText,
  dedupeEdges,
  dig,
  dropDangling,
  edgeOf,
  firstLine,
  isRec,
  joinSorted,
  labelString,
  list,
  num,
  plural,
  rec,
  sortById,
  str,
  strMap,
  type Rec
} from './common.js';
import { redact, redactFields, redactTags } from './redact.js';
import type { Runner } from './runner.js';

const KIND_OF: Record<string, { kind: NodeKind; slug: string }> = {
  Deployment: { kind: 'k8s-deployment', slug: 'deployment' },
  StatefulSet: { kind: 'k8s-statefulset', slug: 'statefulset' },
  DaemonSet: { kind: 'k8s-daemonset', slug: 'daemonset' },
  ReplicaSet: { kind: 'k8s-replicaset', slug: 'replicaset' },
  Job: { kind: 'k8s-job', slug: 'job' },
  CronJob: { kind: 'k8s-cronjob', slug: 'cronjob' },
  Pod: { kind: 'k8s-pod', slug: 'pod' },
  Service: { kind: 'k8s-service', slug: 'service' },
  Ingress: { kind: 'k8s-ingress', slug: 'ingress' },
  PersistentVolumeClaim: { kind: 'k8s-pvc', slug: 'pvc' }
};
const FAILING_WAITING = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError']);

export interface NamePair {
  namespace: string;
  name: string;
}

export interface KubernetesData {
  /** `kubectl config current-context`; null when not reported. */
  context: string | null;
  /** Parsed `kubectl get <workloads> -o json` List; null when it was not obtained. */
  workloads: unknown;
  /** Parsed `kubectl get nodes,namespaces -o json` List; null when it was not obtained. */
  cluster: unknown;
  /** Parsed Warning events List; null when it was not obtained. */
  events: unknown;
  /** Names only. Null when the listing was not obtained. */
  secrets: NamePair[] | null;
  configMaps: NamePair[] | null;
  /** Restrict to one namespace (the scan ran with `-n`). */
  namespace?: string;
  commands: { workloads: string | null; cluster: string | null; events: string | null; secrets: string | null; configMaps: string | null };
}

export interface BuildMeta {
  commands: string[];
  durationMs?: number;
  /** Things that went wrong; any makes the source `partial` (or `error` when nothing was drawn). */
  issues: string[];
  /** Set when the source cannot run at all on this host (tool missing, nothing to talk to). */
  unavailable?: string;
  hostId?: string | null;
}

export function reportStatus(
  source: SourceBuild['report']['source'],
  meta: BuildMeta,
  nodeCount: number,
  okNote: string
): SourceBuild['report'] {
  const base = { source, commands: meta.commands, ...(meta.durationMs !== undefined ? { durationMs: meta.durationMs } : {}) };
  if (meta.unavailable) return { ...base, status: 'unavailable', note: meta.unavailable };
  if (meta.issues.length === 0) return { ...base, status: 'ok', note: okNote };
  return { ...base, status: nodeCount === 0 ? 'error' : 'partial', note: meta.issues.join('; ') };
}

function nodeId(slug: string, namespace: string, name: string): string {
  return `k8s:${slug}:${namespace}/${name}`;
}

function containerPorts(containers: unknown[]): string | null {
  const ports: string[] = [];
  for (const container of containers) {
    for (const port of list(dig(container, 'ports'))) {
      const number = num(dig(port, 'containerPort'));
      if (number !== null) ports.push(`${number}/${str(dig(port, 'protocol')) ?? 'TCP'}`);
    }
  }
  return joinSorted(ports);
}

function podStatus(pod: Rec): { status: NodeStatus; detail: string | undefined; ready: string | null; restarts: number | null } {
  const statuses = [...list(dig(pod, 'status', 'containerStatuses')), ...list(dig(pod, 'status', 'initContainerStatuses'))];
  const main = list(dig(pod, 'status', 'containerStatuses'));
  const waiting = statuses
    .map((s) => str(dig(s, 'state', 'waiting', 'reason')))
    .find((reason): reason is string => reason !== null && FAILING_WAITING.has(reason));
  const readyCount = main.filter((s) => dig(s, 'ready') === true).length;
  const ready = main.length > 0 ? `${readyCount}/${main.length}` : null;
  const restarts = main.length > 0 ? main.reduce<number>((sum, s) => sum + (num(dig(s, 'restartCount')) ?? 0), 0) : null;
  const phase = str(dig(pod, 'status', 'phase'));
  if (waiting) return { status: 'failed', detail: waiting, ready, restarts };
  switch (phase) {
    case 'Failed':
      return { status: 'failed', detail: str(dig(pod, 'status', 'reason')) ?? 'Failed', ready, restarts };
    case 'Pending':
      return { status: 'pending', detail: str(dig(pod, 'status', 'reason')) ?? 'Pending', ready, restarts };
    case 'Succeeded':
      return { status: 'stopped', detail: 'Succeeded', ready, restarts };
    case 'Running':
      if (main.length === 0) return { status: 'unknown', detail: 'Running; container statuses not reported', ready, restarts };
      return readyCount === main.length
        ? { status: 'healthy', detail: 'Running, all containers ready', ready, restarts }
        : { status: 'warning', detail: `Running, ${readyCount}/${main.length} containers ready`, ready, restarts };
    default:
      return { status: 'unknown', detail: phase ? `phase ${phase}` : undefined, ready, restarts };
  }
}

function replicaStatus(desired: number | null, ready: number | null): { status: NodeStatus; detail: string | undefined } {
  if (desired === null) return { status: 'unknown', detail: undefined };
  const have = ready ?? 0;
  if (desired === 0) return { status: 'stopped', detail: 'scaled to 0' };
  if (have === 0) return { status: 'failed', detail: `0/${desired} ready` };
  return have >= desired ? { status: 'healthy', detail: `${have}/${desired} ready` } : { status: 'warning', detail: `${have}/${desired} ready` };
}

function isPodReady(pod: Rec): boolean {
  return list(dig(pod, 'status', 'conditions')).some((c) => dig(c, 'type') === 'Ready' && dig(c, 'status') === 'True');
}

function selectorMatches(selector: Record<string, string>, labels: Record<string, string>): boolean {
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([k, v]) => labels[k] === v);
}

function portText(port: unknown): string | null {
  const number = num(dig(port, 'port'));
  if (number === null) return null;
  const target = dig(port, 'targetPort');
  const arrow = typeof target === 'number' || (typeof target === 'string' && target.length > 0) ? `→${String(target)}` : '';
  return `${number}/${str(dig(port, 'protocol')) ?? 'TCP'}${arrow}`;
}

interface EventSummary {
  count: number;
  last: string | null;
}

function summariseEvents(events: unknown): Map<string, EventSummary> | null {
  if (!isRec(events)) return null;
  const sorted = new Map<string, Array<{ stamp: string; text: string; count: number }>>();
  for (const event of list(events['items'])) {
    if (dig(event, 'type') !== 'Warning') continue;
    const kind = str(dig(event, 'involvedObject', 'kind'));
    const name = str(dig(event, 'involvedObject', 'name'));
    if (!kind || !name) continue;
    const namespace = str(dig(event, 'involvedObject', 'namespace')) ?? str(dig(event, 'metadata', 'namespace')) ?? '';
    const key = `${kind}/${namespace}/${name}`;
    const text = [str(dig(event, 'reason')), str(dig(event, 'message'))].filter(Boolean).join(': ');
    const stamp = str(dig(event, 'lastTimestamp')) ?? str(dig(event, 'eventTime')) ?? str(dig(event, 'metadata', 'creationTimestamp')) ?? '';
    const bucket = sorted.get(key) ?? [];
    bucket.push({ stamp, text, count: num(dig(event, 'count')) ?? 1 });
    sorted.set(key, bucket);
  }
  const out = new Map<string, EventSummary>();
  for (const [key, items] of sorted) {
    items.sort((a, b) => compareText(a.stamp, b.stamp) || compareText(a.text, b.text));
    out.set(key, { count: items.reduce((sum, i) => sum + i.count, 0), last: items[items.length - 1]!.text || null });
  }
  return out;
}

export function buildKubernetes(data: KubernetesData, meta: BuildMeta): SourceBuild {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const clusterId = `k8s:cluster:${data.context ?? 'unknown'}`;
  const events = summariseEvents(data.events);
  const only = data.namespace;
  const inScope = (namespace: string): boolean => only === undefined || namespace === only;

  const add = (node: Omit<DiagramNode, 'tags' | 'fields'> & { tags?: Record<string, string>; fields?: Record<string, FieldValue> }): void => {
    nodes.push({ ...node, tags: redactTags(node.tags ?? {}), fields: redactFields(node.fields ?? {}) });
  };

  const warn = (kindName: string, namespace: string, name: string): Record<string, FieldValue> => {
    if (events === null) return { warningEvents: null, lastWarning: null };
    const found = events.get(`${kindName}/${namespace}/${name}`);
    return { warningEvents: found?.count ?? 0, lastWarning: found?.last ? clip(found.last, 300) : null };
  };

  const hasCluster = isRec(data.cluster) || isRec(data.workloads);
  if (hasCluster) {
    add({
      id: clusterId,
      kind: 'k8s-cluster',
      label: data.context ?? 'Kubernetes cluster',
      status: 'unknown',
      fields: { context: data.context },
      evidence: { source: 'kubernetes', ...(data.commands.cluster ? { command: data.commands.cluster } : {}) }
    });
  }

  const namespaces = new Set<string>();
  for (const item of list(dig(data.cluster, 'items'))) {
    const kind = str(dig(item, 'kind'));
    const name = str(dig(item, 'metadata', 'name'));
    if (!name) continue;
    const command = data.commands.cluster ?? undefined;
    if (kind === 'Namespace') {
      if (!inScope(name)) continue;
      namespaces.add(name);
      const phase = str(dig(item, 'status', 'phase'));
      add({
        id: `k8s:namespace:${name}`,
        kind: 'k8s-namespace',
        label: name,
        parent: clusterId,
        status: phase === 'Active' ? 'healthy' : phase === 'Terminating' ? 'pending' : 'unknown',
        ...(phase ? { statusDetail: phase } : {}),
        tags: strMap(dig(item, 'metadata', 'labels')),
        fields: { phase },
        evidence: { source: 'kubernetes', ...(command ? { command } : {}), raw: redact(item) }
      });
    } else if (kind === 'Node') {
      const ready = list(dig(item, 'status', 'conditions')).find((c) => dig(c, 'type') === 'Ready');
      const readyStatus = str(dig(ready, 'status'));
      const roles = Object.keys(strMap(dig(item, 'metadata', 'labels')))
        .filter((k) => k.startsWith('node-role.kubernetes.io/'))
        .map((k) => k.slice('node-role.kubernetes.io/'.length));
      add({
        id: `k8s:node:${name}`,
        kind: 'k8s-node',
        label: name,
        parent: clusterId,
        status: readyStatus === 'True' ? 'healthy' : readyStatus === 'False' ? 'failed' : 'unknown',
        ...(readyStatus ? { statusDetail: `Ready=${readyStatus}` } : {}),
        tags: strMap(dig(item, 'metadata', 'labels')),
        fields: { ready: readyStatus === 'True' ? true : readyStatus === 'False' ? false : null, kubeletVersion: str(dig(item, 'status', 'nodeInfo', 'kubeletVersion')), roles: joinSorted(roles) },
        evidence: { source: 'kubernetes', ...(command ? { command } : {}), raw: redact(item) }
      });
    }
  }

  const items = list(dig(data.workloads, 'items')).filter(isRec);
  const pods: Array<{ id: string; namespace: string; labels: Record<string, string>; ready: boolean; object: Rec }> = [];
  const services: Array<{ id: string; namespace: string; selector: Record<string, string> }> = [];
  const command = data.commands.workloads ?? undefined;

  for (const item of items) {
    const kindName = str(item['kind']);
    const name = str(dig(item, 'metadata', 'name'));
    const namespace = str(dig(item, 'metadata', 'namespace')) ?? '';
    const mapping = kindName ? KIND_OF[kindName] : undefined;
    if (!kindName || !name || !mapping || !inScope(namespace)) continue;
    namespaces.add(namespace);
    const id = nodeId(mapping.slug, namespace, name);
    const labels = strMap(dig(item, 'metadata', 'labels'));
    const evidence = { source: 'kubernetes' as const, ...(command ? { command } : {}), raw: redact(item) };
    const parent = `k8s:namespace:${namespace}`;
    const base = { id, kind: mapping.kind, label: name, parent, tags: labels, evidence };

    for (const owner of list(dig(item, 'metadata', 'ownerReferences'))) {
      const ownerKind = str(dig(owner, 'kind'));
      const ownerName = str(dig(owner, 'name'));
      const ownerMap = ownerKind ? KIND_OF[ownerKind] : undefined;
      if (ownerMap && ownerName) edges.push(edgeOf('owns', nodeId(ownerMap.slug, namespace, ownerName), id));
    }

    if (kindName === 'Pod') {
      const spec = rec(item['spec']);
      const containers = list(spec['containers']);
      const { status, detail, ready, restarts } = podStatus(item);
      const nodeName = str(spec['nodeName']);
      const privileged = containers.length === 0 ? null : containers.some((c) => dig(c, 'securityContext', 'privileged') === true);
      const images = joinSorted(containers.map((c) => str(dig(c, 'image')) ?? ''));
      add({
        ...base,
        status,
        ...(detail ? { statusDetail: detail } : {}),
        fields: {
          phase: str(dig(item, 'status', 'phase')),
          ready,
          restarts,
          node: nodeName,
          podIP: str(dig(item, 'status', 'podIP')),
          hostNetwork: typeof spec['hostNetwork'] === 'boolean' ? spec['hostNetwork'] : false,
          privileged,
          containerPorts: containerPorts(containers),
          images,
          ...warn('Pod', namespace, name)
        }
      });
      pods.push({ id, namespace, labels, ready: isPodReady(item), object: item });
      if (nodeName) edges.push(edgeOf('scheduled-on', id, `k8s:node:${nodeName}`));
      for (const volume of list(spec['volumes'])) {
        const claim = str(dig(volume, 'persistentVolumeClaim', 'claimName'));
        if (claim) edges.push(edgeOf('mounts', id, nodeId('pvc', namespace, claim)));
        const configMap = str(dig(volume, 'configMap', 'name'));
        if (configMap) edges.push(edgeOf('uses-config', id, nodeId('configmap', namespace, configMap)));
        const secret = str(dig(volume, 'secret', 'secretName'));
        if (secret) edges.push(edgeOf('uses-config', id, nodeId('secret', namespace, secret)));
        for (const source of list(dig(volume, 'projected', 'sources'))) {
          const pc = str(dig(source, 'configMap', 'name'));
          if (pc) edges.push(edgeOf('uses-config', id, nodeId('configmap', namespace, pc)));
          const ps = str(dig(source, 'secret', 'name'));
          if (ps) edges.push(edgeOf('uses-config', id, nodeId('secret', namespace, ps)));
        }
      }
      for (const container of [...containers, ...list(spec['initContainers'])]) {
        for (const entry of list(dig(container, 'env'))) {
          const cm = str(dig(entry, 'valueFrom', 'configMapKeyRef', 'name'));
          if (cm) edges.push(edgeOf('uses-config', id, nodeId('configmap', namespace, cm)));
          const sk = str(dig(entry, 'valueFrom', 'secretKeyRef', 'name'));
          if (sk) edges.push(edgeOf('uses-config', id, nodeId('secret', namespace, sk)));
        }
        for (const from of list(dig(container, 'envFrom'))) {
          const cm = str(dig(from, 'configMapRef', 'name'));
          if (cm) edges.push(edgeOf('uses-config', id, nodeId('configmap', namespace, cm)));
          const sk = str(dig(from, 'secretRef', 'name'));
          if (sk) edges.push(edgeOf('uses-config', id, nodeId('secret', namespace, sk)));
        }
      }
    } else if (kindName === 'Service') {
      const spec = rec(item['spec']);
      const selector = strMap(spec['selector']);
      const ports = list(spec['ports']);
      services.push({ id, namespace, selector });
      add({
        ...base,
        status: 'unknown',
        fields: {
          type: str(spec['type']),
          clusterIP: str(spec['clusterIP']),
          ports: joinSorted(ports.map((p) => portText(p) ?? '')),
          nodePorts: joinSorted(ports.map((p) => String(num(dig(p, 'nodePort')) ?? ''))),
          selector: labelString(selector),
          externalIPs: joinSorted(list(spec['externalIPs']).filter((v): v is string => typeof v === 'string')),
          loadBalancerIngress: joinSorted(list(dig(item, 'status', 'loadBalancer', 'ingress')).map((i) => str(dig(i, 'ip')) ?? str(dig(i, 'hostname')) ?? ''))
        }
      });
    } else if (kindName === 'Ingress') {
      const spec = rec(item['spec']);
      const backends: string[] = [];
      const defaultBackend = str(dig(spec, 'defaultBackend', 'service', 'name')) ?? str(dig(spec, 'backend', 'serviceName'));
      if (defaultBackend) backends.push(defaultBackend);
      const hosts: string[] = [];
      for (const rule of list(spec['rules'])) {
        const host = str(dig(rule, 'host'));
        if (host) hosts.push(host);
        for (const path of list(dig(rule, 'http', 'paths'))) {
          const backend = str(dig(path, 'backend', 'service', 'name')) ?? str(dig(path, 'backend', 'serviceName'));
          if (backend) backends.push(backend);
        }
      }
      for (const backend of new Set(backends)) edges.push(edgeOf('routes', id, nodeId('service', namespace, backend)));
      const tls = list(spec['tls']);
      add({
        ...base,
        status: 'unknown',
        fields: {
          hosts: joinSorted(hosts),
          tls: tls.length > 0,
          ingressClass: str(spec['ingressClassName']) ?? str(dig(item, 'metadata', 'annotations', 'kubernetes.io/ingress.class'))
        }
      });
    } else if (kindName === 'PersistentVolumeClaim') {
      const phase = str(dig(item, 'status', 'phase'));
      add({
        ...base,
        status: phase === 'Bound' ? 'healthy' : phase === 'Lost' ? 'failed' : phase === 'Pending' ? 'pending' : 'unknown',
        ...(phase ? { statusDetail: phase } : {}),
        fields: {
          phase,
          storageClass: str(dig(item, 'spec', 'storageClassName')),
          capacity: str(dig(item, 'status', 'capacity', 'storage'))
        }
      });
    } else if (kindName === 'Job' || kindName === 'CronJob') {
      let status: NodeStatus = 'unknown';
      let detail: string | undefined;
      if (kindName === 'CronJob') {
        if (dig(item, 'spec', 'suspend') === true) {
          status = 'stopped';
          detail = 'suspended';
        }
      } else {
        const conditions = list(dig(item, 'status', 'conditions'));
        const done = (type: string): boolean => conditions.some((c) => dig(c, 'type') === type && dig(c, 'status') === 'True');
        if (done('Failed')) [status, detail] = ['failed', 'Failed'];
        else if (done('Complete')) [status, detail] = ['stopped', 'Complete'];
        else if ((num(dig(item, 'status', 'active')) ?? 0) > 0) [status, detail] = ['healthy', 'running'];
      }
      add({ ...base, status, ...(detail ? { statusDetail: detail } : {}), fields: { schedule: str(dig(item, 'spec', 'schedule')), ...warn(kindName, namespace, name) } });
    } else {
      const spec = rec(item['spec']);
      const status = rec(item['status']);
      const isDaemon = kindName === 'DaemonSet';
      const desired = isDaemon ? num(status['desiredNumberScheduled']) : num(spec['replicas']);
      const ready = isDaemon ? num(status['numberReady']) : num(status['readyReplicas']);
      const summary = replicaStatus(desired, ready);
      add({
        ...base,
        status: summary.status,
        ...(summary.detail ? { statusDetail: summary.detail } : {}),
        fields: {
          replicas: desired,
          readyReplicas: desired === null ? null : ready ?? 0,
          updatedReplicas: isDaemon ? num(status['updatedNumberScheduled']) : num(status['updatedReplicas']),
          availableReplicas: isDaemon ? num(status['numberAvailable']) : num(status['availableReplicas']),
          ...warn(kindName, namespace, name)
        }
      });
    }
  }

  for (const [kind, names, slug] of [
    ['k8s-configmap', data.configMaps, 'configmap'],
    ['k8s-secret', data.secrets, 'secret']
  ] as const) {
    for (const pair of names ?? []) {
      if (!inScope(pair.namespace)) continue;
      namespaces.add(pair.namespace);
      add({
        id: nodeId(slug, pair.namespace, pair.name),
        kind,
        label: pair.name,
        parent: `k8s:namespace:${pair.namespace}`,
        status: 'unknown',
        evidence: { source: 'kubernetes', ...(kind === 'k8s-secret' ? (data.commands.secrets ? { command: data.commands.secrets } : {}) : data.commands.configMaps ? { command: data.commands.configMaps } : {}) }
      });
    }
  }

  // Namespaces seen only through an object (cluster listing failed) still need a parent to draw in.
  const known = new Set(nodes.map((n) => n.id));
  for (const namespace of [...namespaces].sort(compareText)) {
    const id = `k8s:namespace:${namespace}`;
    if (known.has(id)) continue;
    add({ id, kind: 'k8s-namespace', label: namespace, ...(hasCluster ? { parent: clusterId } : {}), status: 'unknown', evidence: { source: 'kubernetes' } });
  }

  // Services: derived health and the Service -> Pod edges.
  for (const service of services) {
    const node = nodes.find((n) => n.id === service.id)!;
    const selected = pods.filter((p) => p.namespace === service.namespace && selectorMatches(service.selector, p.labels));
    for (const pod of selected) edges.push(edgeOf('selects', service.id, pod.id));
    if (Object.keys(service.selector).length === 0) {
      node.statusDetail = 'no selector';
    } else if (selected.length === 0) {
      node.statusDetail = 'selects no pods';
    } else if (selected.some((p) => p.ready)) {
      node.status = 'healthy';
      node.statusDetail = `${selected.filter((p) => p.ready).length}/${selected.length} selected pods ready (derived)`;
    } else {
      node.status = 'warning';
      node.statusDetail = `${selected.length} selected pods, none ready (derived)`;
    }
  }

  const kept = dropDangling(nodes, dedupeEdges(edges));
  const sorted = sortById(nodes);
  const issues = [...meta.issues];
  const noteParts = [plural(sorted.length, 'object')];
  if (kept.dropped > 0) noteParts.push(`${plural(kept.dropped, 'reference')} to objects outside this listing not drawn`);
  const report = reportStatus('kubernetes', { ...meta, issues }, sorted.length, noteParts.join(', '));
  return { nodes: sorted, edges: sortById(kept.edges), report };
}

/** Parse JSON the tool printed; null (with a reason) when it is not a JSON object. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface KubernetesCollectOptions {
  namespace?: string;
  hostId?: string | null;
}

const NAMESPACE_OK = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export async function collectKubernetes(runner: Runner, options: KubernetesCollectOptions = {}): Promise<SourceBuild> {
  const started = Date.now();
  const issues: string[] = [];
  const finish = (data: KubernetesData, unavailable?: string): SourceBuild =>
    buildKubernetes(data, { commands: runner.commands, durationMs: Date.now() - started, issues, hostId: options.hostId ?? null, ...(unavailable ? { unavailable } : {}) });
  const empty: KubernetesData = {
    context: null,
    workloads: null,
    cluster: null,
    events: null,
    secrets: null,
    configMaps: null,
    commands: { workloads: null, cluster: null, events: null, secrets: null, configMaps: null }
  };

  const namespace = options.namespace;
  if (namespace !== undefined && !NAMESPACE_OK.test(namespace)) {
    issues.push(`"${namespace}" is not a valid namespace name`);
    return finish(empty);
  }
  const scope = namespace ? `-n ${namespace}` : '-A';

  const context = await runner.run('kubectl config current-context');
  if (context.kind === 'missing') return finish(empty, 'kubectl is not installed on this host');
  if (context.kind !== 'ok') return finish(empty, `No Kubernetes context is configured: ${context.message}`);
  const contextName = firstLine(context.stdout) || null;

  const commands = {
    workloads: `kubectl get deployments,statefulsets,daemonsets,replicasets,jobs,cronjobs,pods,services,ingresses,persistentvolumeclaims ${scope} -o json --request-timeout=20s`,
    cluster: 'kubectl get nodes,namespaces -o json --request-timeout=20s',
    events: `kubectl get events ${scope} -o json --field-selector=type=Warning --request-timeout=20s`,
    secrets: `kubectl get secrets ${scope} -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name --no-headers --request-timeout=20s`,
    configMaps: `kubectl get configmaps ${scope} -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name --no-headers --request-timeout=20s`
  };

  const [workloads, cluster, events, secrets, configMaps] = await Promise.all([
    runner.run(commands.workloads),
    runner.run(commands.cluster),
    runner.run(commands.events),
    runner.run(commands.secrets),
    runner.run(commands.configMaps)
  ]);

  const data: KubernetesData = { ...empty, context: contextName, commands: { workloads: null, cluster: null, events: null, secrets: null, configMaps: null } };
  const json = (label: string, outcome: typeof workloads, key: 'workloads' | 'cluster' | 'events'): void => {
    if (outcome.kind !== 'ok') {
      issues.push(`${label}: ${outcome.message}`);
      return;
    }
    const parsed = parseJson(outcome.stdout);
    if (!parsed.ok) {
      issues.push(`${label}: output was not JSON (${parsed.error})`);
      return;
    }
    data[key] = parsed.value;
    data.commands[key] = commands[key];
  };
  json('workloads', workloads, 'workloads');
  json('nodes and namespaces', cluster, 'cluster');
  json('warning events', events, 'events');

  const names = (label: string, outcome: typeof secrets, key: 'secrets' | 'configMaps'): void => {
    if (outcome.kind !== 'ok') {
      issues.push(`${label}: ${outcome.message}`);
      return;
    }
    const pairs: NamePair[] = [];
    for (const line of outcome.stdout.split(/\r?\n/)) {
      const [ns, name] = line.trim().split(/\s+/);
      if (ns && name) pairs.push({ namespace: namespace ?? ns, name });
    }
    data[key] = pairs;
    data.commands[key] = commands[key];
  };
  names('secret names', secrets, 'secrets');
  names('configmap names', configMaps, 'configMaps');
  if (namespace) data.namespace = namespace;

  return finish(data);
}
