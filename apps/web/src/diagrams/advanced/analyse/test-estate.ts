/**
 * A hand-built estate for the analyse tests. It follows the ids, fields and edge
 * directions of docs/DIAGRAMS_FEATURES.md exactly, so the analyses are checked
 * against the shape the scan produces. Not imported by product code.
 */
import { makeEdge, makeGraph, makeNode } from '../../fixtures';
import type { DiagramEdge, DiagramGraph, DiagramNode, FieldValue, NodeKind, NodeStatus, SourceReport } from '../../model';

type Fields = Record<string, FieldValue>;

interface Extra {
  status?: NodeStatus;
  statusDetail?: string;
  parent?: string;
  tags?: Record<string, string>;
  fields?: Fields;
}

function node(id: string, kind: NodeKind, label: string, extra: Extra = {}): DiagramNode {
  const source = id.startsWith('k8s:') ? 'kubernetes' : id.startsWith('docker:') || id.startsWith('compose:') ? 'docker' : id.startsWith('systemd:') ? 'systemd' : id.startsWith('ssh:') ? 'ssh-path' : 'sockets';
  return makeNode(id, { kind, label, source, status: extra.status ?? 'unknown', parent: extra.parent, tags: extra.tags ?? {}, fields: extra.fields ?? {}, statusDetail: extra.statusDetail });
}

const NS = 'k8s:namespace:shop';
const HOST = 'host:prod-1';
const PROJECT = 'compose:project:store';

const sourceReports: SourceReport[] = [
  { source: 'ssh-path', status: 'ok', commands: [] },
  { source: 'kubernetes', status: 'ok', commands: ['kubectl get pods -A -o json'] },
  { source: 'docker', status: 'ok', commands: ['docker ps -a --format json'] },
  { source: 'systemd', status: 'ok', commands: ['systemctl list-units --all'] },
  { source: 'sockets', status: 'partial', note: 'Not root: some listeners have no process.', commands: ['ss -tulpn'] }
];

export function buildEstate(): DiagramGraph {
  const nodes: DiagramNode[] = [
    // SSH path and host
    node('ssh:browser', 'browser', 'Browser', { status: 'healthy' }),
    node('ssh:relay', 'relay', 'Relay', { status: 'healthy' }),
    node(HOST, 'host', 'prod-1', { status: 'healthy' }),

    // Kubernetes: cluster, namespace, node
    node('k8s:cluster:prod', 'k8s-cluster', 'prod', { status: 'healthy' }),
    node(NS, 'k8s-namespace', 'shop', { parent: 'k8s:cluster:prod', status: 'unknown' }),
    node('k8s:node:worker-1', 'k8s-node', 'worker-1', { parent: 'k8s:cluster:prod', status: 'healthy', fields: { ready: true, roles: 'worker', kubeletVersion: 'v1.30.2' } }),

    // Kubernetes: web workload (one crashing pod)
    node('k8s:deployment:shop/web', 'k8s-deployment', 'web', {
      parent: NS,
      status: 'warning',
      fields: { replicas: 3, readyReplicas: 2, updatedReplicas: 3, availableReplicas: 2, warningEvents: 4, lastWarning: 'Back-off restarting failed container web in pod web-7c9f-c3d4e' }
    }),
    node('k8s:replicaset:shop/web-7c9f', 'k8s-replicaset', 'web-7c9f', { parent: NS, status: 'warning', fields: { replicas: 3, readyReplicas: 2 } }),
    node('k8s:pod:shop/web-7c9f-a1b2c', 'k8s-pod', 'web-7c9f-a1b2c', {
      parent: NS,
      status: 'healthy',
      fields: { phase: 'Running', ready: '1/1', restarts: 0, node: 'worker-1', podIP: '10.1.0.11', hostNetwork: false, privileged: false, containerPorts: '8080/TCP', images: 'shop/web:1.4', warningEvents: 0, lastWarning: null }
    }),
    node('k8s:pod:shop/web-7c9f-b2c3d', 'k8s-pod', 'web-7c9f-b2c3d', {
      parent: NS,
      status: 'healthy',
      fields: { phase: 'Running', ready: '1/1', restarts: 1, node: 'worker-1', podIP: '10.1.0.12', hostNetwork: false, privileged: false, containerPorts: '8080/TCP', images: 'shop/web:1.4', warningEvents: 0, lastWarning: null }
    }),
    node('k8s:pod:shop/web-7c9f-c3d4e', 'k8s-pod', 'web-7c9f-c3d4e', {
      parent: NS,
      status: 'failed',
      statusDetail: 'CrashLoopBackOff',
      fields: { phase: 'Running', ready: '0/1', restarts: 12, node: 'worker-1', podIP: '10.1.0.13', hostNetwork: false, privileged: false, containerPorts: '8080/TCP', images: 'shop/web:1.4', warningEvents: 4, lastWarning: 'Back-off restarting failed container web' }
    }),
    node('k8s:configmap:shop/web-config', 'k8s-configmap', 'web-config', { parent: NS, status: 'unknown' }),
    node('k8s:service:shop/web', 'k8s-service', 'web', { parent: NS, status: 'healthy', fields: { type: 'ClusterIP', clusterIP: '10.96.0.20', ports: '80/TCP→8080', nodePorts: null, selector: 'app=web', externalIPs: null, loadBalancerIngress: null } }),
    node('k8s:service:shop/web-public', 'k8s-service', 'web-public', {
      parent: NS,
      status: 'healthy',
      fields: { type: 'NodePort', clusterIP: '10.96.0.21', ports: '80/TCP→8080', nodePorts: '30080/TCP', selector: 'app=web', externalIPs: null, loadBalancerIngress: null }
    }),
    node('k8s:ingress:shop/web', 'k8s-ingress', 'web', { parent: NS, status: 'unknown', fields: { hosts: 'shop.example.com', tls: false, ingressClass: 'nginx' } }),
    node('k8s:ingress:shop/secure', 'k8s-ingress', 'secure', { parent: NS, status: 'unknown', fields: { hosts: 'secure.example.com', tls: true, ingressClass: 'nginx' } }),
    node('k8s:ingress:shop/mystery', 'k8s-ingress', 'mystery', { parent: NS, status: 'unknown', fields: { hosts: 'mystery.example.com', tls: null, ingressClass: null } }),

    // Kubernetes: database (single replica, privileged, host network)
    node('k8s:statefulset:shop/db', 'k8s-statefulset', 'db', { parent: NS, status: 'healthy', fields: { replicas: 1, readyReplicas: 1, updatedReplicas: 1, availableReplicas: 1, warningEvents: 0, lastWarning: null } }),
    node('k8s:pod:shop/db-0', 'k8s-pod', 'db-0', {
      parent: NS,
      status: 'healthy',
      fields: { phase: 'Running', ready: '1/1', restarts: 0, node: 'worker-1', podIP: '10.1.0.30', hostNetwork: true, privileged: true, containerPorts: '5432/TCP', images: 'postgres:16', warningEvents: 0, lastWarning: null }
    }),
    node('k8s:service:shop/db', 'k8s-service', 'db', { parent: NS, status: 'healthy', fields: { type: 'ClusterIP', clusterIP: '10.96.0.30', ports: '5432/TCP→5432', nodePorts: null, selector: 'app=db', externalIPs: null, loadBalancerIngress: null } }),
    node('k8s:pvc:shop/data-db-0', 'k8s-pvc', 'data-db-0', { parent: NS, status: 'healthy', fields: { phase: 'Bound', storageClass: 'fast', capacity: '20Gi' } }),
    node('k8s:secret:shop/db-password', 'k8s-secret', 'db-password', { parent: NS, status: 'unknown' }),

    // Kubernetes: things nothing uses
    node('k8s:pvc:shop/old-data', 'k8s-pvc', 'old-data', { parent: NS, status: 'healthy', fields: { phase: 'Bound', storageClass: 'slow', capacity: '5Gi' } }),
    node('k8s:service:shop/legacy', 'k8s-service', 'legacy', { parent: NS, status: 'unknown', fields: { type: 'ClusterIP', clusterIP: '10.96.0.40', ports: '80/TCP→80', nodePorts: null, selector: 'app=legacy', externalIPs: null, loadBalancerIngress: null } }),
    node('k8s:service:shop/external-db', 'k8s-service', 'external-db', { parent: NS, status: 'unknown', fields: { type: 'ExternalName', clusterIP: null, ports: null, nodePorts: null, selector: null, externalIPs: null, loadBalancerIngress: null } }),
    node('k8s:configmap:shop/unused-config', 'k8s-configmap', 'unused-config', { parent: NS, status: 'unknown' }),
    node('k8s:secret:shop/old-token', 'k8s-secret', 'old-token', { parent: NS, status: 'unknown' }),

    // Docker / Compose
    node(PROJECT, 'compose-project', 'store', { parent: HOST, status: 'unknown' }),
    node('docker:container:cache', 'container', 'cache', {
      parent: PROJECT,
      status: 'healthy',
      fields: { state: 'running', health: null, image: 'redis:7', publishedPorts: '0.0.0.0:6379->6379/tcp, :::6379->6379/tcp', privileged: false, networkMode: 'app-net', restarts: 0, exitCode: null, composeProject: 'store', composeService: 'cache' }
    }),
    node('docker:container:debug', 'container', 'debug', {
      parent: HOST,
      status: 'failed',
      statusDetail: 'exited (1)',
      fields: { state: 'exited', health: null, image: 'busybox:1.0', publishedPorts: '127.0.0.1:9000->9000/tcp', privileged: true, networkMode: 'host', restarts: 5, exitCode: 1, composeProject: null, composeService: null }
    }),
    node('docker:network:app-net', 'docker-network', 'app-net', { parent: HOST, status: 'unknown' }),
    node('docker:network:bridge', 'docker-network', 'bridge', { parent: HOST, status: 'unknown' }),
    node('docker:volume:cache-data', 'docker-volume', 'cache-data', { parent: HOST, status: 'unknown' }),
    node('docker:volume:stale-vol', 'docker-volume', 'stale-vol', { parent: HOST, status: 'unknown' }),
    node('docker:image:redis:7', 'image', 'redis:7', { parent: HOST, status: 'unknown' }),
    node('docker:image:busybox:1.0', 'image', 'busybox:1.0', { parent: HOST, status: 'unknown' }),
    node('docker:image:alpine:3.19', 'image', 'alpine:3.19', { parent: HOST, status: 'unknown' }),

    // systemd
    node('systemd:unit:sshd.service', 'systemd-unit', 'sshd.service', { parent: HOST, status: 'healthy', fields: { activeState: 'active', subState: 'running', mainPid: 611, fragmentPath: '/lib/systemd/system/ssh.service', description: 'OpenBSD Secure Shell server' } }),
    node('systemd:unit:nginx.service', 'systemd-unit', 'nginx.service', { parent: HOST, status: 'healthy', fields: { activeState: 'active', subState: 'running', mainPid: 812, fragmentPath: '/lib/systemd/system/nginx.service', description: 'A high performance web server' } }),
    node('systemd:unit:postgres.service', 'systemd-unit', 'postgres.service', { parent: HOST, status: 'healthy', fields: { activeState: 'active', subState: 'running', mainPid: 905, fragmentPath: null, description: 'PostgreSQL database server' } }),
    node('systemd:unit:app.service', 'systemd-unit', 'app.service', { parent: HOST, status: 'healthy', fields: { activeState: 'active', subState: 'running', mainPid: 1301, fragmentPath: null, description: 'Application' } }),
    node('systemd:unit:backup.service', 'systemd-unit', 'backup.service', { parent: HOST, status: 'failed', statusDetail: 'failed (exit-code)', fields: { activeState: 'failed', subState: 'failed', mainPid: 0, fragmentPath: null, description: 'Nightly backup' } }),
    node('systemd:unit:sync-a.service', 'systemd-unit', 'sync-a.service', { parent: HOST, status: 'stopped', fields: { activeState: 'inactive', subState: 'dead', mainPid: 0, fragmentPath: null, description: 'Sync A' } }),
    node('systemd:unit:sync-b.service', 'systemd-unit', 'sync-b.service', { parent: HOST, status: 'stopped', fields: { activeState: 'inactive', subState: 'dead', mainPid: 0, fragmentPath: null, description: 'Sync B' } }),
    node('proc:node', 'process', 'node', { parent: HOST, status: 'unknown', fields: {} }),

    // Sockets
    node('sock:listen:tcp:0.0.0.0:22', 'listener', 'tcp 0.0.0.0:22', { parent: HOST, status: 'healthy', fields: { protocol: 'tcp', bindAddress: '0.0.0.0', port: 22, process: 'sshd', pid: 611, allInterfaces: true } }),
    node('sock:listen:tcp:0.0.0.0:80', 'listener', 'tcp 0.0.0.0:80', { parent: HOST, status: 'healthy', fields: { protocol: 'tcp', bindAddress: '0.0.0.0', port: 80, process: 'nginx', pid: 812, allInterfaces: true } }),
    node('sock:listen:tcp:0.0.0.0:6379', 'listener', 'tcp 0.0.0.0:6379', { parent: HOST, status: 'healthy', fields: { protocol: 'tcp', bindAddress: '0.0.0.0', port: 6379, process: 'docker-proxy', pid: 1500, allInterfaces: true } }),
    node('sock:listen:tcp:127.0.0.1:5432', 'listener', 'tcp 127.0.0.1:5432', { parent: HOST, status: 'healthy', fields: { protocol: 'tcp', bindAddress: '127.0.0.1', port: 5432, process: 'postgres', pid: 905, allInterfaces: false } }),
    node('sock:listen:tcp:127.0.0.1:3000', 'listener', 'tcp 127.0.0.1:3000', { parent: HOST, status: 'healthy', fields: { protocol: 'tcp', bindAddress: '127.0.0.1', port: 3000, process: 'node', pid: 1302, allInterfaces: false } }),
    node('peer:10.0.0.5', 'peer', '10.0.0.5', { status: 'unknown', fields: { address: '10.0.0.5', port: null, connections: 3 } }),
    node('peer:10.0.0.9:5432', 'peer', '10.0.0.9:5432', { status: 'unknown', fields: { address: '10.0.0.9', port: 5432, connections: 1 } })
  ];

  const e = (from: string, to: string, kind: DiagramEdge['kind']): DiagramEdge => makeEdge(from, to, kind);
  const webPods = ['k8s:pod:shop/web-7c9f-a1b2c', 'k8s:pod:shop/web-7c9f-b2c3d', 'k8s:pod:shop/web-7c9f-c3d4e'];
  const edges: DiagramEdge[] = [
    // SSH path
    e('ssh:browser', 'ssh:relay', 'hop'),
    e('ssh:relay', HOST, 'hop'),

    // Kubernetes ownership and scheduling
    e('k8s:deployment:shop/web', 'k8s:replicaset:shop/web-7c9f', 'owns'),
    ...webPods.map((pod) => e('k8s:replicaset:shop/web-7c9f', pod, 'owns')),
    ...webPods.map((pod) => e(pod, 'k8s:node:worker-1', 'scheduled-on')),
    ...webPods.map((pod) => e(pod, 'k8s:configmap:shop/web-config', 'uses-config')),
    e('k8s:statefulset:shop/db', 'k8s:pod:shop/db-0', 'owns'),
    e('k8s:pod:shop/db-0', 'k8s:node:worker-1', 'scheduled-on'),
    e('k8s:pod:shop/db-0', 'k8s:pvc:shop/data-db-0', 'mounts'),
    e('k8s:pod:shop/db-0', 'k8s:secret:shop/db-password', 'uses-config'),

    // Kubernetes traffic
    ...webPods.map((pod) => e('k8s:service:shop/web', pod, 'selects')),
    ...webPods.map((pod) => e('k8s:service:shop/web-public', pod, 'selects')),
    e('k8s:service:shop/db', 'k8s:pod:shop/db-0', 'selects'),
    e('k8s:ingress:shop/web', 'k8s:service:shop/web', 'routes'),
    e('k8s:ingress:shop/secure', 'k8s:service:shop/web', 'routes'),

    // Docker
    e('docker:container:cache', 'docker:network:app-net', 'attached'),
    e('docker:container:cache', 'docker:volume:cache-data', 'mounts'),
    e('docker:container:cache', 'docker:image:redis:7', 'runs'),
    e('docker:container:debug', 'docker:image:busybox:1.0', 'runs'),
    e('sock:listen:tcp:0.0.0.0:6379', 'docker:container:cache', 'routes'),

    // systemd
    e('systemd:unit:app.service', 'systemd:unit:postgres.service', 'depends-on'),
    e('systemd:unit:app.service', 'systemd:unit:nginx.service', 'orders-after'),
    e('systemd:unit:sync-a.service', 'systemd:unit:sync-b.service', 'depends-on'),
    e('systemd:unit:sync-b.service', 'systemd:unit:sync-a.service', 'depends-on'),
    e('systemd:unit:app.service', 'proc:node', 'owns'),

    // Sockets
    e('systemd:unit:sshd.service', 'sock:listen:tcp:0.0.0.0:22', 'listens'),
    e('systemd:unit:nginx.service', 'sock:listen:tcp:0.0.0.0:80', 'listens'),
    e('systemd:unit:postgres.service', 'sock:listen:tcp:127.0.0.1:5432', 'listens'),
    e('proc:node', 'sock:listen:tcp:127.0.0.1:3000', 'listens'),
    e('peer:10.0.0.5', 'sock:listen:tcp:0.0.0.0:22', 'connects'),
    e('proc:node', 'peer:10.0.0.9:5432', 'connects')
  ];

  return makeGraph(nodes, edges, { title: 'prod-1', hostKey: 'ops@prod-1:22', sources: sourceReports.map((r) => ({ ...r })) });
}
