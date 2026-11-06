/**
 * Small readers over `DiagramNode` shared by the analyses. A field the node does
 * not carry, or carries as `null`, is "not reported"; none of these helpers
 * turns that into a value.
 */
import type { DiagramNode, FieldValue, NodeKind, NodeStatus } from '../../model.js';

const hasOwn = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);

/** A reported field value, or undefined. Own properties only, so a field named `constructor` is never a function. */
export function fieldValue(node: DiagramNode, name: string): FieldValue | undefined {
  return hasOwn(node.fields, name) ? node.fields[name] : undefined;
}

export function tagValue(node: DiagramNode, key: string): string | undefined {
  return hasOwn(node.tags, key) ? node.tags[key] : undefined;
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A finite number, from a number or from text that is entirely a decimal number. */
export function toNumber(value: FieldValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!DECIMAL.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function fieldNumber(node: DiagramNode, name: string): number | null {
  return toNumber(fieldValue(node, name));
}

/** `true` / `false` from a boolean or the text "true" / "false"; null otherwise. */
export function fieldBoolean(node: DiagramNode, name: string): boolean | null {
  const value = fieldValue(node, name);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  return null;
}

/** A reported value as text; null when the node does not report the field. */
export function fieldText(node: DiagramNode, name: string): string | null {
  const value = fieldValue(node, name);
  return value === undefined || value === null ? null : String(value);
}

export const KIND_LABELS: Record<NodeKind, string> = {
  browser: 'Browser',
  relay: 'Relay',
  gateway: 'Gateway',
  'jump-host': 'Jump host',
  host: 'Host',
  'k8s-cluster': 'Cluster',
  'k8s-namespace': 'Namespace',
  'k8s-node': 'Node',
  'k8s-deployment': 'Deployment',
  'k8s-statefulset': 'StatefulSet',
  'k8s-daemonset': 'DaemonSet',
  'k8s-replicaset': 'ReplicaSet',
  'k8s-job': 'Job',
  'k8s-cronjob': 'CronJob',
  'k8s-pod': 'Pod',
  'k8s-service': 'Service',
  'k8s-ingress': 'Ingress',
  'k8s-configmap': 'ConfigMap',
  'k8s-secret': 'Secret',
  'k8s-pvc': 'PVC',
  'compose-project': 'Compose project',
  'compose-service': 'Compose service',
  container: 'Container',
  'docker-network': 'Docker network',
  'docker-volume': 'Docker volume',
  image: 'Image',
  'systemd-unit': 'systemd unit',
  process: 'Process',
  listener: 'Listener',
  peer: 'Peer',
  'tf-module': 'Terraform module',
  'tf-resource': 'Terraform resource',
  custom: 'Custom'
};

export function kindLabel(kind: NodeKind): string {
  return KIND_LABELS[kind] ?? kind;
}

export function statusLabel(status: NodeStatus): string {
  return status === 'unknown' ? 'not reported' : status;
}

/** Plain code-point order, so lists sort the same on every machine. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface KindGroup {
  kind: NodeKind;
  label: string;
  ids: string[];
}

/** Ids grouped by node kind, the biggest group first. Ids that are not nodes are skipped. */
export function groupByKind(ids: readonly string[], nodes: ReadonlyMap<string, DiagramNode>): KindGroup[] {
  const groups = new Map<NodeKind, string[]>();
  for (const id of ids) {
    const node = nodes.get(id);
    if (!node) continue;
    const list = groups.get(node.kind);
    if (list) list.push(id);
    else groups.set(node.kind, [id]);
  }
  return [...groups]
    .map(([kind, list]) => ({ kind, label: kindLabel(kind), ids: list }))
    .sort((a, b) => b.ids.length - a.ids.length || compareText(a.label, b.label));
}
