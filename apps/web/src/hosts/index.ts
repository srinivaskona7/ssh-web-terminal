import type { JumpHop } from '@webssh/protocol';

export interface HostProfile {
  id: string;
  alias: string;
  host: string;
  port: number;
  user: string;
  keyFingerprint?: string;
  folder?: string;
  tags: string[];
  favorite: boolean;
  notes?: string;
  jumpHops: JumpHop[];
  tmuxAutoAttach?: string;
  lastConnectedAt?: number;
}

export class HostRegistry {
  private readonly hosts = new Map<string, HostProfile>();
  private readonly storageKey: string;

  constructor(storageKey = 'webssh.hosts.v1') {
    this.storageKey = storageKey;
    this.load();
  }

  private load(): void {
    try {
      if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
        const raw = localStorage.getItem(this.storageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as HostProfile[];
          for (const h of parsed) {
            this.hosts.set(h.id, h);
          }
        }
      }
    } catch {
      // Ignore malformed or unavailable storage
    }
  }

  private save(): void {
    try {
      if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
        localStorage.setItem(this.storageKey, JSON.stringify(Array.from(this.hosts.values())));
      }
    } catch {
      // Ignore unavailable storage
    }
  }

  upsert(profile: HostProfile): HostProfile {
    this.hosts.set(profile.id, profile);
    this.save();
    return profile;
  }

  remove(id: string): boolean {
    const deleted = this.hosts.delete(id);
    this.save();
    return deleted;
  }

  get(id: string): HostProfile | undefined {
    return this.hosts.get(id);
  }

  list(query = '', folder?: string, tag?: string): HostProfile[] {
    const q = query.trim().toLowerCase();
    return Array.from(this.hosts.values())
      .filter((h) => {
        if (folder && h.folder !== folder) return false;
        if (tag && !h.tags.includes(tag)) return false;
        if (!q) return true;
        return (
          h.alias.toLowerCase().includes(q) ||
          h.host.toLowerCase().includes(q) ||
          h.user.toLowerCase().includes(q) ||
          h.tags.some((t) => t.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        return a.alias.localeCompare(b.alias);
      });
  }

  importSshConfig(configText: string, defaultUser = 'root'): HostProfile[] {
    const imported = parseOpenSshConfig(configText, defaultUser);
    for (const h of imported) {
      this.hosts.set(h.id, h);
    }
    this.save();
    return imported;
  }
}

interface RawHostBlock {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  proxyJump?: string[];
}

function parseJumpHopSpec(spec: string, byAlias: Map<string, RawHostBlock>, defaultUser: string): JumpHop {
  const existing = byAlias.get(spec);
  if (existing) {
    return {
      host: existing.hostName ?? existing.alias,
      port: existing.port ?? 22,
      user: existing.user ?? defaultUser
    };
  }
  // Support user@host:port syntax
  let user = defaultUser;
  let hostPort = spec;
  const atIdx = spec.indexOf('@');
  if (atIdx > 0) {
    user = spec.slice(0, atIdx);
    hostPort = spec.slice(atIdx + 1);
  }
  let host = hostPort;
  let port = 22;
  const colonIdx = hostPort.lastIndexOf(':');
  if (colonIdx > 0) {
    host = hostPort.slice(0, colonIdx);
    const parsedPort = Number.parseInt(hostPort.slice(colonIdx + 1), 10);
    if (Number.isFinite(parsedPort) && parsedPort > 0) {
      port = parsedPort;
    }
  }
  return { host, port, user };
}

/**
 * Parses an OpenSSH `~/.ssh/config` file into saved host profiles, resolving ProxyJump chains.
 */
export function parseOpenSshConfig(configText: string, defaultUser = 'root'): HostProfile[] {
  const blocks: RawHostBlock[] = [];
  let current: RawHostBlock[] = [];

  const lines = configText.split(String.fromCharCode(10));
  for (const rawLine of lines) {
    const stripped = rawLine.replace(/#.*$/, '').trim();
    if (!stripped) continue;

    const match = stripped.match(/^(\S+)\s+(.*)$/);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const val = match[2]!.trim().replace(/^"|"$/g, '');

    if (key === 'host') {
      const aliases = val
        .split(/\s+/)
        .filter((a) => a.length > 0 && !a.includes('*') && !a.includes('?'));
      current = aliases.map((alias) => {
        const block: RawHostBlock = { alias };
        blocks.push(block);
        return block;
      });
      continue;
    }

    for (const block of current) {
      if (key === 'hostname') {
        block.hostName = val;
      } else if (key === 'user') {
        block.user = val;
      } else if (key === 'port') {
        const p = Number.parseInt(val, 10);
        if (Number.isFinite(p) && p > 0 && p <= 65535) {
          block.port = p;
        }
      } else if (key === 'proxyjump') {
        block.proxyJump = val
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s.toLowerCase() !== 'none');
      }
    }
  }

  const byAlias = new Map<string, RawHostBlock>();
  for (const b of blocks) {
    byAlias.set(b.alias, b);
  }

  return blocks.map((b) => {
    const jumpHops: JumpHop[] = [];
    if (b.proxyJump) {
      for (const spec of b.proxyJump) {
        const referenced = byAlias.get(spec);
        if (referenced?.proxyJump) {
          for (const nested of referenced.proxyJump) {
            jumpHops.push(parseJumpHopSpec(nested, byAlias, defaultUser));
          }
        }
        jumpHops.push(parseJumpHopSpec(spec, byAlias, defaultUser));
      }
    }

    return {
      id: `host-${b.alias}`,
      alias: b.alias,
      host: b.hostName ?? b.alias,
      port: b.port ?? 22,
      user: b.user ?? defaultUser,
      tags: ['ssh-config'],
      favorite: false,
      jumpHops
    };
  });
}
