/**
 * Realistic kubectl output for the Kubernetes source tests: a `shop` namespace
 * with a Deployment whose third Pod is crash-looping, a Service, an Ingress, a
 * PVC and Secret names, on a two-node cluster. Env values and Secret names here
 * are deliberately sensitive-looking so the redaction tests have something to
 * catch.
 */
export const K8S_CONTEXT = 'prod-eu\n';

export const K8S_CLUSTER = {
  apiVersion: 'v1',
  kind: 'List',
  items: [
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'shop', labels: { team: 'storefront' } },
      status: { phase: 'Active' }
    },
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-system' }, status: { phase: 'Active' } },
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'old' }, status: { phase: 'Terminating' } },
    {
      apiVersion: 'v1',
      kind: 'Node',
      metadata: { name: 'node-a', labels: { 'node-role.kubernetes.io/control-plane': '', 'kubernetes.io/arch': 'amd64' } },
      status: { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.29.4' } }
    },
    {
      apiVersion: 'v1',
      kind: 'Node',
      metadata: { name: 'node-b', labels: {} },
      status: { conditions: [{ type: 'Ready', status: 'Unknown' }], nodeInfo: { kubeletVersion: 'v1.29.4' } }
    }
  ]
};

const podTemplate = (name: string, node: string, state: Record<string, unknown>, ready: boolean, restarts: number, phase = 'Running') => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name,
    namespace: 'shop',
    labels: { app: 'web', tier: 'frontend' },
    ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-7c9f6d' }],
    managedFields: [{ manager: 'kube-controller-manager', operation: 'Update' }]
  },
  spec: {
    nodeName: node,
    containers: [
      {
        name: 'web',
        image: 'registry.example.test/shop/web:1.8.2',
        ports: [{ containerPort: 8080, protocol: 'TCP' }],
        env: [
          { name: 'DATABASE_URL', value: 'postgres://shop:hunter2@db:5432/shop' },
          { name: 'API_TOKEN', valueFrom: { secretKeyRef: { name: 'api-credentials', key: 'token' } } },
          { name: 'LOG_LEVEL', valueFrom: { configMapKeyRef: { name: 'web-config', key: 'level' } } }
        ],
        envFrom: [{ secretRef: { name: 'web-secrets' } }],
        securityContext: {}
      }
    ],
    volumes: [
      { name: 'uploads', persistentVolumeClaim: { claimName: 'uploads' } },
      { name: 'conf', configMap: { name: 'web-config' } },
      { name: 'tls', secret: { secretName: 'web-tls' } }
    ]
  },
  status: {
    phase,
    podIP: '10.42.0.17',
    conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
    containerStatuses: [{ name: 'web', ready, restartCount: restarts, state }]
  }
});

export const K8S_WORKLOADS = {
  apiVersion: 'v1',
  kind: 'List',
  items: [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'web',
        namespace: 'shop',
        labels: { app: 'web' },
        annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"spec":{"env":[{"name":"X","value":"leak"}]}}' }
      },
      spec: { replicas: 3 },
      status: { readyReplicas: 2, updatedReplicas: 3, availableReplicas: 2 }
    },
    {
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: {
        name: 'web-7c9f6d',
        namespace: 'shop',
        labels: { app: 'web' },
        ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' }]
      },
      spec: { replicas: 3 },
      status: { readyReplicas: 2 }
    },
    {
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: 'db', namespace: 'shop' },
      spec: { replicas: 0 },
      status: {}
    },
    {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { name: 'agent', namespace: 'kube-system' },
      status: { desiredNumberScheduled: 2, numberReady: 0, numberAvailable: 0 }
    },
    podTemplate('web-7c9f6d-aaaaa', 'node-a', { running: {} }, true, 0),
    podTemplate('web-7c9f6d-bbbbb', 'node-a', { running: {} }, true, 1),
    podTemplate('web-7c9f6d-ccccc', 'node-b', { waiting: { reason: 'CrashLoopBackOff' } }, false, 14),
    {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'migrate-1', namespace: 'shop', ownerReferences: [{ kind: 'CronJob', name: 'migrate' }] },
      status: { conditions: [{ type: 'Complete', status: 'True' }] }
    },
    { apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name: 'migrate', namespace: 'shop' }, spec: { schedule: '0 3 * * *', suspend: true } },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'web', namespace: 'shop' },
      spec: {
        type: 'NodePort',
        clusterIP: '10.43.12.7',
        selector: { app: 'web' },
        ports: [{ port: 80, targetPort: 8080, protocol: 'TCP', nodePort: 30080 }]
      }
    },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'headless', namespace: 'shop' }, spec: { clusterIP: 'None', ports: [{ port: 5432 }] } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'lonely', namespace: 'shop' }, spec: { selector: { app: 'nothing' }, ports: [{ port: 1 }] } },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: { name: 'web', namespace: 'shop' },
      spec: {
        ingressClassName: 'nginx',
        rules: [{ host: 'shop.example.test', http: { paths: [{ path: '/', backend: { service: { name: 'web', port: { number: 80 } } } }] } }]
      }
    },
    {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'uploads', namespace: 'shop' },
      spec: { storageClassName: 'fast' },
      status: { phase: 'Bound', capacity: { storage: '10Gi' } }
    },
    { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'scratch', namespace: 'shop' }, status: { phase: 'Pending' } },
    { apiVersion: 'example.dev/v1', kind: 'Widget', metadata: { name: 'ignored', namespace: 'shop' } }
  ]
};

export const K8S_EVENTS = {
  apiVersion: 'v1',
  kind: 'List',
  items: [
    {
      type: 'Warning',
      reason: 'BackOff',
      message: 'Back-off restarting failed container web',
      count: 41,
      lastTimestamp: '2026-11-05T10:00:00Z',
      involvedObject: { kind: 'Pod', name: 'web-7c9f6d-ccccc', namespace: 'shop' }
    },
    {
      type: 'Warning',
      reason: 'Unhealthy',
      message: 'Readiness probe failed: HTTP probe failed with statuscode: 500',
      count: 3,
      lastTimestamp: '2026-11-05T11:00:00Z',
      involvedObject: { kind: 'Pod', name: 'web-7c9f6d-ccccc', namespace: 'shop' }
    },
    { type: 'Normal', reason: 'Pulled', message: 'ignored', involvedObject: { kind: 'Pod', name: 'web-7c9f6d-aaaaa', namespace: 'shop' } },
    { type: 'Warning', reason: 'Broken', message: 'no involved object' }
  ]
};

export const K8S_SECRET_NAMES = 'shop   api-credentials\nshop   web-secrets\nshop   web-tls\nkube-system   bootstrap-token-abcdef\n';
export const K8S_CONFIGMAP_NAMES = 'shop   web-config\nkube-system   coredns\n';
