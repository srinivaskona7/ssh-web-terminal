import { posixQuote } from '../recipes/engine.js';
import type { RemoteSession } from '../session/remote-session.js';

/**
 * Docker-compatible container workflows over the SSH session.
 *
 * The daemon socket is never exposed over the network: every call is a CLI
 * invocation executed as the SSH user, subject to that user's own Docker
 * permissions. Privileged/host-namespace operations are surfaced, not hidden.
 */

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
  composeProject?: string;
  composeService?: string;
}

export interface ImageSummary {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdAt: string;
}

export interface VolumeSummary {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
}

export interface NetworkSummary {
  id: string;
  name: string;
  driver: string;
  scope: string;
}

const CONTAINER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function assertRef(value: string, what: string): string {
  const trimmed = value.trim();
  if (!CONTAINER_ID.test(trimmed) || trimmed.startsWith('-')) {
    throw new Error(`Invalid ${what} "${value}"`);
  }
  return trimmed;
}

/** Docker's `--format '{{json .}}'` prints one JSON object per line. */
export function parseJsonLines<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip malformed lines rather than failing the whole listing.
    }
  }
  return out;
}

export class DockerClient {
  constructor(private readonly session: RemoteSession) {}

  async available(): Promise<{ ok: boolean; detail: string }> {
    const result = await this.session.exec('docker --version', { timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      return { ok: false, detail: (result.stderr || result.stdout).trim() || 'docker is not installed' };
    }
    const daemon = await this.session.exec('docker info --format "{{.ServerVersion}}"', {
      timeoutMs: 20_000
    });
    if (daemon.exitCode !== 0) {
      return {
        ok: false,
        detail:
          (daemon.stderr || daemon.stdout).trim() ||
          'Docker CLI is installed, but the daemon is unreachable for this user'
      };
    }
    return { ok: true, detail: `Docker ${daemon.stdout.trim()}` };
  }

  async listContainers(all = true): Promise<ContainerSummary[]> {
    const format = '{{json .}}';
    const result = await this.session.exec(
      `docker ps ${all ? '--all' : ''} --no-trunc --format ${posixQuote(format)}`,
      { timeoutMs: 30_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error(`docker ps failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return parseJsonLines<Record<string, string>>(result.stdout).map((row) => ({
      id: row['ID'] ?? '',
      name: row['Names'] ?? '',
      image: row['Image'] ?? '',
      state: row['State'] ?? '',
      status: row['Status'] ?? '',
      ports: row['Ports'] ?? '',
      createdAt: row['CreatedAt'] ?? '',
      composeProject: row['Label']?.match(/com\.docker\.compose\.project=([^,]+)/)?.[1],
      composeService: row['Label']?.match(/com\.docker\.compose\.service=([^,]+)/)?.[1]
    }));
  }

  async images(): Promise<ImageSummary[]> {
    const result = await this.session.exec(
      `docker images --format ${posixQuote('{{json .}}')}`,
      { timeoutMs: 30_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error(`docker images failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return parseJsonLines<Record<string, string>>(result.stdout).map((row) => ({
      id: row['ID'] ?? '',
      repository: row['Repository'] ?? '',
      tag: row['Tag'] ?? '',
      size: row['Size'] ?? '',
      createdAt: row['CreatedAt'] ?? ''
    }));
  }

  async volumes(): Promise<VolumeSummary[]> {
    const result = await this.session.exec(
      `docker volume ls --format ${posixQuote('{{json .}}')}`,
      { timeoutMs: 30_000 }
    );
    if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout).trim());
    return parseJsonLines<Record<string, string>>(result.stdout).map((row) => ({
      name: row['Name'] ?? '',
      driver: row['Driver'] ?? '',
      mountpoint: row['Mountpoint'] ?? '',
      scope: row['Scope'] ?? ''
    }));
  }

  async networks(): Promise<NetworkSummary[]> {
    const result = await this.session.exec(
      `docker network ls --format ${posixQuote('{{json .}}')}`,
      { timeoutMs: 30_000 }
    );
    if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout).trim());
    return parseJsonLines<Record<string, string>>(result.stdout).map((row) => ({
      id: row['ID'] ?? '',
      name: row['Name'] ?? '',
      driver: row['Driver'] ?? '',
      scope: row['Scope'] ?? ''
    }));
  }

  async inspect(id: string): Promise<unknown> {
    const ref = assertRef(id, 'container reference');
    const result = await this.session.exec(`docker inspect ${posixQuote(ref)}`, {
      timeoutMs: 30_000
    });
    if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout).trim());
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error('docker inspect returned invalid JSON');
    }
  }

  async logs(id: string, tail = 200): Promise<string> {
    const ref = assertRef(id, 'container reference');
    const safeTail = Math.max(1, Math.min(10_000, Math.floor(tail)));
    const result = await this.session.exec(
      `docker logs --tail ${safeTail} ${posixQuote(ref)} 2>&1`,
      { timeoutMs: 60_000 }
    );
    return result.stdout + result.stderr;
  }

  async start(id: string): Promise<void> {
    await this.action('start', id);
  }

  async stop(id: string): Promise<void> {
    await this.action('stop', id);
  }

  async restart(id: string): Promise<void> {
    await this.action('restart', id);
  }

  private async action(verb: 'start' | 'stop' | 'restart', id: string): Promise<void> {
    const ref = assertRef(id, 'container reference');
    const result = await this.session.exec(`docker ${verb} ${posixQuote(ref)}`, {
      timeoutMs: 90_000
    });
    if (result.exitCode !== 0) {
      throw new Error(`docker ${verb} failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  /** Validate a Compose file without changing anything. */
  async validateCompose(filePath: string): Promise<{ ok: boolean; detail: string }> {
    const result = await this.session.exec(
      `docker compose -f ${posixQuote(filePath)} config --quiet`,
      { timeoutMs: 60_000 }
    );
    return { ok: result.exitCode === 0, detail: (result.stderr || result.stdout).trim() };
  }

  async composeUp(filePath: string): Promise<string> {
    const result = await this.session.exec(
      `docker compose -f ${posixQuote(filePath)} up -d --remove-orphans`,
      { timeoutMs: 15 * 60_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error(`docker compose up failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout + result.stderr;
  }
}
