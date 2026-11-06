/**
 * Image inventory: every container image running on the server (docker) and
 * in the cluster its kubeconfig reaches (kubectl), deduplicated across both
 * and across spellings (`nginx:1.25` and `docker.io/library/nginx:1.25` are
 * one image). Each source is independent: a host without kubectl still gets
 * its docker list, and the missing source is reported rather than hidden.
 */
import type { WorkspaceRemoteSession } from '../../../session/adapters.js';
import { isCommandMissing, isPermissionDenied, makeResult, runEvidence } from '../../exec.js';
import type { CommandEvidence, DevOpsTool, Finding, ResultTable, ToolStatus } from '../../types.js';
import { isImageId, parseImageRef, tagProblem } from './image-ref.js';
import { errorText, firstLines, isRecord, record, records, text, type Json } from './json.js';
import { K8S_POSTURE_COMMAND, KUBECTL_FORBIDDEN_NOTE, owningWorkload, podItems, unparsedKubectlNotes } from './k8s-posture.js';

export const DOCKER_PS_COMMAND = "docker ps --format '{{json .}}'";

/** One container running one image, wherever it was seen. */
export interface ImageUse {
  image: string;
  /** Registry digest the runtime reported, or the one pinned in the reference. */
  digest: string | null;
  /** "docker: web" or "k8s: Deployment shop/web". */
  where: string;
}

export interface InventoryRow {
  /** First spelling seen. */
  reference: string;
  /** Repository path, or the image ID when that is all the runtime reports. */
  image: string;
  /** Registry host, "docker.io (implicit)" for short Docker Hub names, null for image IDs. */
  registry: string | null;
  tag: string | null;
  digests: string[];
  problem: 'latest' | 'untagged' | 'image-id' | null;
  uses: number;
  where: string[];
}

const PROBLEM_RANK: Record<string, number> = { 'image-id': 0, latest: 1, untagged: 2, none: 3 };
const REPO_DIGEST = /@(sha256:[0-9a-f]{64})$/;

export function parseDockerPs(stdout: string): { containers: Array<{ name: string; image: string }>; invalidLines: number } {
  const containers: Array<{ name: string; image: string }> = [];
  let invalidLines = 0;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalidLines++;
      continue;
    }
    const image = isRecord(parsed) ? text(parsed.Image) : null;
    if (!isRecord(parsed) || !image) {
      invalidLines++;
      continue;
    }
    containers.push({ name: text(parsed.Names) ?? text(parsed.ID) ?? '(unnamed)', image });
  }
  return { containers, invalidLines };
}

/** Images of every container, init container and ephemeral container in a pod list. */
export function podImages(podList: unknown): ImageUse[] {
  const uses: ImageUse[] = [];
  for (const pod of podItems(podList)) {
    const metadata = record(pod.metadata);
    const spec = record(pod.spec);
    const status = record(pod.status);
    const podName = text(metadata.name) ?? '(unnamed)';
    const owner = owningWorkload(metadata, podName);
    const where = `k8s: ${owner.kind} ${text(metadata.namespace) ?? '(unknown)'}/${owner.name}`;
    const statuses = new Map<string, Json>();
    for (const key of ['initContainerStatuses', 'containerStatuses', 'ephemeralContainerStatuses']) {
      for (const containerStatus of records(status[key])) {
        const name = text(containerStatus.name);
        if (name) statuses.set(name, containerStatus);
      }
    }
    for (const key of ['initContainers', 'containers', 'ephemeralContainers']) {
      for (const container of records(spec[key])) {
        const image = text(container.image);
        if (!image) continue;
        const name = text(container.name);
        // A bare `sha256:` imageID is a local image ID, not a registry digest.
        const reported = REPO_DIGEST.exec(text(name ? statuses.get(name)?.imageID : null) ?? '')?.[1] ?? null;
        uses.push({ image, digest: parseImageRef(image)?.digest ?? reported, where });
      }
    }
  }
  return uses;
}

export function buildInventory(uses: ImageUse[]): InventoryRow[] {
  const rows = new Map<string, InventoryRow>();
  for (const use of uses) {
    const ref = isImageId(use.image) ? null : parseImageRef(use.image);
    const key = ref ? ref.canonical : `raw:${use.image}`;
    let row = rows.get(key);
    if (!row) {
      const problem = ref ? tagProblem(ref) : isImageId(use.image) ? 'image-id' : null;
      row = {
        reference: use.image,
        image: ref ? ref.repository : use.image,
        registry: ref ? (ref.registryImplicit ? `${ref.registry} (implicit)` : ref.registry) : null,
        tag: ref?.tag ?? null,
        digests: [],
        problem,
        uses: 0,
        where: []
      };
      rows.set(key, row);
    }
    row.uses++;
    if (use.digest && !row.digests.includes(use.digest)) row.digests.push(use.digest);
    if (!row.where.includes(use.where)) row.where.push(use.where);
  }
  return [...rows.values()].sort(
    (a, b) => PROBLEM_RANK[a.problem ?? 'none']! - PROBLEM_RANK[b.problem ?? 'none']! || a.reference.localeCompare(b.reference)
  );
}

type SourceStatus = 'ok' | 'unavailable' | 'permission denied' | 'error';

interface SourceResult {
  source: 'docker' | 'kubernetes';
  status: SourceStatus;
  items: number | null;
  detail: string;
  uses: ImageUse[];
  notes: string[];
}

function failed(source: SourceResult['source'], status: SourceStatus, detail: string, notes: string[]): SourceResult {
  return { source, status, items: null, detail, uses: [], notes };
}

async function dockerSource(session: WorkspaceRemoteSession, evidence: CommandEvidence[]): Promise<SourceResult> {
  try {
    const probe = await runEvidence(session, DOCKER_PS_COMMAND);
    evidence.push(probe.evidence);
    if (isCommandMissing(probe.exitCode, probe.stderr)) {
      return failed('docker', 'unavailable', 'docker is not installed', ['docker is not installed on this server.']);
    }
    if (probe.exitCode !== 0) {
      const message = firstLines(probe.stderr || probe.stdout) || `docker exited with ${probe.exitCode}`;
      if (isPermissionDenied(probe.stderr)) {
        return failed('docker', 'permission denied', message, [
          `${session.user} cannot reach the Docker daemon socket; add the account to the docker group or run as root to include docker containers.`
        ]);
      }
      return failed('docker', 'error', message, [`docker: ${message}`]);
    }
    const parsed = parseDockerPs(probe.stdout);
    const notes = parsed.invalidLines > 0 ? [`${parsed.invalidLines} line(s) of docker ps output were not JSON and were skipped.`] : [];
    const count = parsed.containers.length;
    return {
      source: 'docker',
      status: 'ok',
      items: count,
      detail: `${count} running container${count === 1 ? '' : 's'}`,
      uses: parsed.containers.map((container) => ({
        image: container.image,
        digest: parseImageRef(container.image)?.digest ?? null,
        where: `docker: ${container.name}`
      })),
      notes
    };
  } catch (err) {
    return failed('docker', 'error', errorText(err), [`docker: ${errorText(err)}`]);
  }
}

async function kubernetesSource(session: WorkspaceRemoteSession, evidence: CommandEvidence[]): Promise<SourceResult> {
  try {
    const probe = await runEvidence(session, K8S_POSTURE_COMMAND, 60_000);
    evidence.push(probe.evidence);
    if (isCommandMissing(probe.exitCode, probe.stderr)) {
      return failed('kubernetes', 'unavailable', 'kubectl is not installed', ['kubectl is not installed on this server.']);
    }
    if (probe.exitCode !== 0) {
      const message = firstLines(probe.stderr || probe.stdout) || `kubectl exited with ${probe.exitCode}`;
      if (/forbidden/i.test(probe.stderr)) return failed('kubernetes', 'permission denied', message, [KUBECTL_FORBIDDEN_NOTE]);
      return failed('kubernetes', 'error', message, [`kubectl: ${message}`]);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(probe.stdout);
    } catch (err) {
      const message = `kubectl output is not valid JSON (${probe.stdout.length} characters: ${errorText(err)})`;
      return failed('kubernetes', 'error', message, [message, ...unparsedKubectlNotes(probe.stdout)]);
    }
    const uses = podImages(parsed);
    const pods = podItems(parsed).length;
    return {
      source: 'kubernetes',
      status: 'ok',
      items: uses.length,
      detail: `${pods} pod${pods === 1 ? '' : 's'}, ${uses.length} container${uses.length === 1 ? '' : 's'}`,
      uses,
      notes: []
    };
  } catch (err) {
    return failed('kubernetes', 'error', errorText(err), [`kubernetes: ${errorText(err)}`]);
  }
}

function places(where: string[]): string {
  const shown = where.slice(0, 5).join(', ');
  return where.length > 5 ? `${shown} and ${where.length - 5} more` : shown;
}

function findingsFor(rows: InventoryRow[]): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows) {
    const usedBy = `Used by ${row.uses}: ${places(row.where)}`;
    if (row.problem === 'latest') {
      findings.push({ severity: 'warning', title: `${row.reference} uses the latest tag`, detail: `A restart can pull a different image. ${usedBy}`, subject: row.reference });
    } else if (row.problem === 'untagged') {
      findings.push({ severity: 'warning', title: `${row.reference} has no tag`, detail: `No tag means latest, so a restart can pull a different image. ${usedBy}`, subject: row.reference });
    } else if (row.problem === 'image-id') {
      findings.push({
        severity: 'info',
        title: `Container started from image ID ${row.reference}`,
        detail: `The runtime no longer knows a tag for this image, usually because the tag now points elsewhere. ${usedBy}`,
        subject: row.reference
      });
    }
    if (row.digests.length > 1) {
      findings.push({
        severity: 'warning',
        title: `${row.reference} runs as ${row.digests.length} different digests`,
        detail: `The same reference resolved to different images (${row.digests.join(', ')}). ${usedBy}`,
        subject: row.reference
      });
    }
  }
  return findings;
}

export const imageInventoryTool: DevOpsTool = {
  id: 'image-inventory',
  group: 'delivery',
  title: 'Image inventory',
  description:
    "Lists the container images running under docker on this server and in the cluster its kubeconfig reaches, with registry, tag, digest and where each runs. Flags latest and untagged references. Either source is enough.",
  requires: ['docker', 'kubectl'],
  preview: () => [DOCKER_PS_COMMAND, K8S_POSTURE_COMMAND],
  async run(session) {
    const evidence: CommandEvidence[] = [];
    const sources = [await dockerSource(session, evidence), await kubernetesSource(session, evidence)];
    const notes = sources.flatMap((source) => source.notes);
    const answered = sources.filter((source) => source.status === 'ok');
    const sourcesTable: ResultTable = {
      id: 'sources',
      title: 'Sources',
      columns: [
        { key: 'source', label: 'Source' },
        { key: 'status', label: 'Status' },
        { key: 'items', label: 'Containers', numeric: true },
        { key: 'detail', label: 'Detail' }
      ],
      rows: sources.map((source) => ({ source: source.source, status: source.status, items: source.items, detail: source.detail }))
    };

    if (answered.length === 0) {
      const allMissing = sources.every((source) => source.status === 'unavailable');
      const summary = allMissing
        ? 'Neither docker nor kubectl is installed on this server'
        : `No image source answered: ${sources.find((source) => source.status !== 'unavailable')?.detail ?? 'unknown error'}`;
      return makeResult(allMissing ? 'unavailable' : 'error', summary, { tables: [sourcesTable], notes, evidence });
    }

    const rows = buildInventory(answered.flatMap((source) => source.uses));
    const imagesTable: ResultTable = {
      id: 'images',
      title: 'Images in use',
      columns: [
        { key: 'image', label: 'Image' },
        { key: 'registry', label: 'Registry' },
        { key: 'tag', label: 'Tag' },
        { key: 'digest', label: 'Digest' },
        { key: 'flag', label: 'Flag' },
        { key: 'uses', label: 'Used by', numeric: true },
        { key: 'where', label: 'Where' }
      ],
      rows: rows.map((row) => {
        const ref = row.problem === 'image-id' ? null : parseImageRef(row.reference);
        return {
          image: row.image,
          registry: row.registry,
          tag: row.tag ?? (row.problem === 'image-id' ? null : ref?.digest ? 'none (pinned by digest)' : 'none (defaults to latest)'),
          digest: row.digests.length === 0 ? null : row.digests.length === 1 ? row.digests[0]! : row.digests.join(', '),
          flag: row.problem === 'image-id' ? 'image ID only' : (row.problem ?? ''),
          uses: row.uses,
          where: places(row.where)
        };
      })
    };

    const status: ToolStatus = answered.length === sources.length ? 'ok' : 'partial';
    const only = status === 'partial' ? ` (${answered.map((source) => source.source).join(' and ')} only)` : '';
    const findings = findingsFor(rows);
    let summary: string;
    if (rows.length === 0) {
      summary = `No running containers or pods use any image${only}`;
      findings.push({ severity: 'ok', title: 'No images in use' });
    } else {
      const count = (problem: InventoryRow['problem']): number => rows.filter((row) => row.problem === problem).length;
      summary = `${rows.length} distinct image${rows.length === 1 ? '' : 's'} in use: ${count('latest')} latest, ${count('untagged')} untagged, ${count('image-id')} image IDs${only}`;
      if (findings.length === 0) findings.push({ severity: 'ok', title: `All ${rows.length} images are pinned to a tag or digest` });
    }
    return makeResult(status, summary, { findings, tables: [imagesTable, sourcesTable], notes, evidence });
  }
};
