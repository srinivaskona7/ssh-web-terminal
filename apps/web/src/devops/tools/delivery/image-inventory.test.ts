import { describe, expect, it } from 'vitest';
import { buildInventory, imageInventoryTool, parseDockerPs, podImages } from './image-inventory.js';
import { fakeSession, notInstalled } from './fake-session.js';

const DOCKER = "docker ps --format '{{json .}}'";
const KUBECTL = 'kubectl get pods -A -o json --request-timeout=20s';
const D1 = 'sha256:' + '1a'.repeat(32);
const D2 = 'sha256:' + '2b'.repeat(32);
const D3 = 'sha256:' + '3c'.repeat(32);

/** `docker ps --format '{{json .}}'`: one JSON object per running container. */
const DOCKER_PS = [
  '{"Command":"\\"/docker-entrypoint.…\\"","CreatedAt":"2024-05-02 09:14:11 +0000 UTC","ID":"9c1a2b3c4d5e","Image":"nginx:1.25","Labels":"maintainer=NGINX Docker Maintainers <docker-maint@nginx.com>","LocalVolumes":"0","Mounts":"","Names":"edge","Networks":"bridge","Ports":"0.0.0.0:80->80/tcp","RunningFor":"3 days ago","Size":"0B","State":"running","Status":"Up 3 days"}',
  '{"Command":"\\"docker-entrypoint.s…\\"","CreatedAt":"2024-05-02 09:14:12 +0000 UTC","ID":"1b2c3d4e5f60","Image":"redis","Labels":"","LocalVolumes":"1","Mounts":"4f1e0c…","Names":"cache","Networks":"bridge","Ports":"6379/tcp","RunningFor":"3 days ago","Size":"0B","State":"running","Status":"Up 3 days"}',
  '{"Command":"\\"/app\\"","ID":"aa11bb22cc33","Image":"3f57d9401f8d","Names":"old-api","State":"running","Status":"Up 9 days"}',
  '{"Command":"\\"/bin/worker\\"","ID":"dd44ee55ff66","Image":"registry.internal:5000/team/worker:2.3.1","Names":"worker-1","State":"running","Status":"Up 1 hour"}',
  '{"Command":"\\"/bin/worker\\"","ID":"0a0b0c0d0e0f","Image":"registry.internal:5000/team/worker:2.3.1","Names":"worker-2","State":"running","Status":"Up 1 hour"}',
  ''
].join('\n');

function apiPod(name: string, digest: string): unknown {
  return {
    metadata: {
      name,
      namespace: 'shop',
      labels: { 'pod-template-hash': '5f7c9' },
      ownerReferences: [{ kind: 'ReplicaSet', name: 'api-5f7c9', controller: true }]
    },
    spec: { containers: [{ name: 'api', image: 'ghcr.io/acme/api:latest' }] },
    status: { containerStatuses: [{ name: 'api', image: 'ghcr.io/acme/api:latest', imageID: `ghcr.io/acme/api@${digest}` }] }
  };
}

const PODS = {
  apiVersion: 'v1',
  kind: 'List',
  items: [
    apiPod('api-5f7c9-aaaaa', D1),
    apiPod('api-5f7c9-bbbbb', D2),
    {
      metadata: { name: 'proxy-0', namespace: 'edge', ownerReferences: [{ kind: 'StatefulSet', name: 'proxy', controller: true }] },
      spec: {
        initContainers: [{ name: 'wait', image: 'busybox:1.36' }],
        containers: [{ name: 'nginx', image: 'docker.io/library/nginx:1.25' }]
      },
      status: {
        initContainerStatuses: [{ name: 'wait', imageID: 'docker.io/library/busybox@' + D3 }],
        containerStatuses: [{ name: 'nginx', imageID: 'docker-pullable://nginx@' + D3 }]
      }
    },
    {
      metadata: { name: 'db-0', namespace: 'data', ownerReferences: [{ kind: 'StatefulSet', name: 'db', controller: true }] },
      spec: { containers: [{ name: 'postgres', image: `postgres:16.2@${D1}` }] },
      status: { containerStatuses: [{ name: 'postgres', imageID: 'sha256:' + '9d'.repeat(32) }] }
    }
  ]
};

describe('parseDockerPs', () => {
  it('reads one container per JSON line and counts lines that are not JSON', () => {
    const parsed = parseDockerPs(DOCKER_PS + '{"ID":"cut-off","Ima');
    expect(parsed.containers.map((container) => [container.name, container.image])).toEqual([
      ['edge', 'nginx:1.25'],
      ['cache', 'redis'],
      ['old-api', '3f57d9401f8d'],
      ['worker-1', 'registry.internal:5000/team/worker:2.3.1'],
      ['worker-2', 'registry.internal:5000/team/worker:2.3.1']
    ]);
    expect(parsed.invalidLines).toBe(1);
    expect(parseDockerPs('')).toEqual({ containers: [], invalidLines: 0 });
  });
});

describe('podImages', () => {
  it('takes digests from container statuses, including init containers, and labels the owning workload', () => {
    const uses = podImages(PODS);
    expect(uses).toEqual(
      expect.arrayContaining([
        { image: 'ghcr.io/acme/api:latest', digest: D1, where: 'k8s: Deployment shop/api' },
        { image: 'ghcr.io/acme/api:latest', digest: D2, where: 'k8s: Deployment shop/api' },
        { image: 'busybox:1.36', digest: D3, where: 'k8s: StatefulSet edge/proxy' },
        { image: 'docker.io/library/nginx:1.25', digest: D3, where: 'k8s: StatefulSet edge/proxy' }
      ])
    );
    // A bare sha256 imageID is a local image ID, not a registry digest; the spec digest is used.
    expect(uses.find((use) => use.image.startsWith('postgres'))?.digest).toBe(D1);
    expect(uses).toHaveLength(5);
  });

  it('rejects JSON that is not a pod list', () => {
    expect(() => podImages({ kind: 'Status' })).toThrow(/not a pod list/);
  });
});

describe('buildInventory', () => {
  it('merges spellings of one image across sources and keeps every place it runs', () => {
    const rows = buildInventory([
      { image: 'nginx:1.25', digest: null, where: 'docker: edge' },
      { image: 'docker.io/library/nginx:1.25', digest: D3, where: 'k8s: StatefulSet edge/proxy' },
      { image: 'redis', digest: null, where: 'docker: cache' }
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.image === 'library/nginx')).toEqual({
      reference: 'nginx:1.25',
      image: 'library/nginx',
      registry: 'docker.io (implicit)',
      tag: '1.25',
      digests: [D3],
      problem: null,
      uses: 2,
      where: ['docker: edge', 'k8s: StatefulSet edge/proxy']
    });
    expect(rows.find((row) => row.image === 'library/redis')).toMatchObject({ tag: null, problem: 'untagged', digests: [] });
  });

  it('shows image IDs as such instead of inventing a repository for them', () => {
    const [row] = buildInventory([{ image: '3f57d9401f8d', digest: null, where: 'docker: old-api' }]);
    expect(row).toMatchObject({ image: '3f57d9401f8d', registry: null, tag: null, problem: 'image-id' });
  });
});

describe('imageInventoryTool', () => {
  it('runs exactly the previewed commands and lists both sources', async () => {
    const preview = imageInventoryTool.preview({});
    expect(preview).toEqual([DOCKER, KUBECTL]);
    const { session, commands } = fakeSession({ [DOCKER]: { stdout: DOCKER_PS }, [KUBECTL]: { stdout: JSON.stringify(PODS) } });
    const result = await imageInventoryTool.run(session, {});
    expect(commands).toEqual(preview);
    expect(result.status).toBe('ok');
    expect(result.summary).toMatch(/7 distinct images/);

    const images = result.tables.find((table) => table.id === 'images')!;
    const nginx = images.rows.find((row) => row.image === 'library/nginx');
    expect(nginx).toMatchObject({ registry: 'docker.io (implicit)', tag: '1.25', digest: D3, uses: 2 });
    const worker = images.rows.find((row) => row.image === 'team/worker');
    expect(worker).toMatchObject({ registry: 'registry.internal:5000', uses: 2, digest: null });
    expect(images.rows.find((row) => row.image === 'library/postgres')).toMatchObject({ tag: '16.2', digest: D1 });
    expect(images.rows.find((row) => row.image === 'library/redis')).toMatchObject({ tag: 'none (defaults to latest)' });

    const titles = result.findings.map((finding) => `${finding.severity}: ${finding.title}`);
    expect(titles).toEqual(
      expect.arrayContaining([
        'warning: ghcr.io/acme/api:latest uses the latest tag',
        'warning: redis has no tag',
        'warning: ghcr.io/acme/api:latest runs as 2 different digests',
        'info: Container started from image ID 3f57d9401f8d'
      ])
    );
    expect(result.tables.find((table) => table.id === 'sources')?.rows).toEqual([
      { source: 'docker', status: 'ok', items: 5, detail: '5 running containers' },
      { source: 'kubernetes', status: 'ok', items: 5, detail: '4 pods, 5 containers' }
    ]);
  });

  it('still renders Kubernetes when docker is missing, and says so', async () => {
    const { session } = fakeSession({ [DOCKER]: notInstalled('docker'), [KUBECTL]: { stdout: JSON.stringify(PODS) } });
    const result = await imageInventoryTool.run(session, {});
    expect(result.status).toBe('partial');
    expect(result.tables.find((table) => table.id === 'sources')?.rows[0]).toMatchObject({ source: 'docker', status: 'unavailable', items: null });
    expect(result.tables.find((table) => table.id === 'images')?.rows.length).toBe(4);
    expect(result.notes.join(' ')).toMatch(/docker is not installed/);
  });

  it('is unavailable when neither docker nor kubectl is installed', async () => {
    const { session } = fakeSession({ [DOCKER]: notInstalled('docker'), [KUBECTL]: notInstalled('kubectl') });
    const result = await imageInventoryTool.run(session, {});
    expect(result.status).toBe('unavailable');
    expect(result.tables.find((table) => table.id === 'images')).toBeUndefined();
    expect(result.findings).toEqual([]);
  });

  it('reports a docker permission problem as partial with a hint', async () => {
    const denied =
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.24/containers/json": dial unix /var/run/docker.sock: connect: permission denied\n';
    const { session } = fakeSession({ [DOCKER]: { exitCode: 1, stderr: denied }, [KUBECTL]: { stdout: JSON.stringify(PODS) } });
    const result = await imageInventoryTool.run(session, {});
    expect(result.status).toBe('partial');
    expect(result.tables.find((table) => table.id === 'sources')?.rows[0]).toMatchObject({ status: 'permission denied' });
    expect(result.notes.join(' ')).toMatch(/docker group/);
  });

  it('treats unparseable kubectl output as an error for that source only', async () => {
    const { session } = fakeSession({ [DOCKER]: { stdout: DOCKER_PS }, [KUBECTL]: { stdout: '{"items":[{"metadata"' } });
    const result = await imageInventoryTool.run(session, {});
    expect(result.status).toBe('partial');
    expect(result.tables.find((table) => table.id === 'sources')?.rows[1]).toMatchObject({ source: 'kubernetes', status: 'error' });
    expect(result.tables.find((table) => table.id === 'images')?.rows.length).toBe(4);
  });

  it('is an error when both sources fail for reasons other than a missing binary', async () => {
    const { session } = fakeSession({
      [DOCKER]: { exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' },
      [KUBECTL]: new Error('SSH_EXEC_TIMEOUT: command exceeded 60s')
    });
    const result = await imageInventoryTool.run(session, {});
    expect(result.status).toBe('error');
    expect(result.summary).toMatch(/docker daemon running/);
    expect(result.notes.join(' ')).toMatch(/SSH_EXEC_TIMEOUT/);
  });

  it('reports an empty host honestly', async () => {
    const { session } = fakeSession({ [DOCKER]: { stdout: '' }, [KUBECTL]: { stdout: '{"apiVersion":"v1","items":[],"kind":"List"}' } });
    const result = await imageInventoryTool.run(session, {});
    expect(result.status).toBe('ok');
    expect(result.summary).toMatch(/No running containers/);
    expect(result.findings).toEqual([expect.objectContaining({ severity: 'ok' })]);
  });
});
