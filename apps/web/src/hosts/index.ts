import type { JumpHop } from '@webssh/protocol';

export { validateEnvVars, type EnvVarError } from '@webssh/protocol';

/** How a saved jump hop signs in. Absent means it reuses the target's credentials. */
export type HopAuthMethod = 'password' | 'private_key' | 'remote_signer';

const HOP_AUTH_METHODS: readonly HopAuthMethod[] = ['password', 'private_key', 'remote_signer'];

/**
 * A saved ProxyJump hop. Like the profile itself it holds no secret: a
 * password or key hop gets its secret at connect time, and a browser-key hop
 * names its vault key by fingerprint.
 */
export interface HostJumpHop {
  host: string;
  port: number;
  user: string;
  authMethod?: HopAuthMethod;
  keyFingerprint?: string;
}

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
  jumpHops: HostJumpHop[];
  /**
   * Environment requested for the shell. The server decides what it takes
   * (OpenSSH accepts only LANG and LC_* by default), so values are exported
   * with the profile: keep secrets out of them.
   */
  env?: Record<string, string>;
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
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              const sanitized = sanitizeHostProfile(item);
              if (sanitized) {
                this.hosts.set(sanitized.id, sanitized);
              }
            }
          }
        }
      }
    } catch {
      // Ignore malformed or unavailable storage without wiping other keys
    }
  }

  private save(): boolean {
    try {
      if (typeof localStorage === 'undefined' || typeof localStorage.setItem !== 'function') {
        // No storage at all: nothing was persisted, so say so.
        return false;
      }
      localStorage.setItem(this.storageKey, JSON.stringify(Array.from(this.hosts.values())));
      return true;
    } catch {
      // Unavailable or full storage: the caller reports that nothing persisted.
      return false;
    }
  }

  upsert(profile: HostProfile): HostProfile {
    // A hop handed over with its connect-time secrets must not carry them into storage.
    const stored: HostProfile = { ...profile, jumpHops: profile.jumpHops.map(toSavedHop) };
    this.hosts.set(stored.id, stored);
    this.save();
    return stored;
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

  /**
   * Host profiles contain no secrets — private keys live in the Key Vault and
   * passwords are never stored — so the export is safe to share.
   */
  exportJson(): string {
    return JSON.stringify({ version: 1, hosts: Array.from(this.hosts.values()) }, null, 2);
  }

  /** Merge a previously exported file; malformed entries are skipped, not fatal. */
  importJson(text: string): { imported: HostProfile[]; skipped: number; persisted: boolean } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Not valid JSON');
    }
    const rawList = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { hosts?: unknown }).hosts)
        ? ((parsed as { hosts: unknown[] }).hosts)
        : null;
    if (!rawList) {
      throw new Error('Expected an array of hosts or { "hosts": [...] }');
    }
    const imported: HostProfile[] = [];
    let skipped = 0;
    for (const item of rawList) {
      const sanitized = sanitizeHostProfile(item);
      if (!sanitized) {
        skipped += 1;
        continue;
      }
      this.hosts.set(sanitized.id, sanitized);
      imported.push(sanitized);
    }
    // Report the write result: a full or blocked localStorage would otherwise
    // let the UI announce a successful import whose hosts vanish on reload.
    const persisted = imported.length > 0 ? this.save() : true;
    return { imported, skipped, persisted };
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

/** Keep only what a profile may hold for a hop: where it is and how it signs in. */
function toSavedHop(hop: HostJumpHop): HostJumpHop {
  const saved: HostJumpHop = { host: hop.host, port: hop.port, user: hop.user };
  if (hop.authMethod && HOP_AUTH_METHODS.includes(hop.authMethod)) saved.authMethod = hop.authMethod;
  if (typeof hop.keyFingerprint === 'string' && hop.keyFingerprint) saved.keyFingerprint = hop.keyFingerprint;
  return saved;
}

function sanitizeEnv(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') env[name] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/** Secrets for one hop, supplied at connect time and never saved. */
export interface JumpHopSecret {
  password?: string;
  privateKeyPem?: string;
  privateKeyPassphrase?: string;
  /** authorized_keys line of the vault key a `remote_signer` hop names. */
  publicKey?: string;
}

/**
 * Turn saved hops plus this connect's secrets (by hop position) into the
 * `connect.jump` entries. A hop with its own auth method must get its own
 * secret: sending it bare would make it borrow the target's credentials.
 */
export function buildConnectJumpHops(
  hops: HostJumpHop[],
  secrets: Array<JumpHopSecret | undefined> = []
): JumpHop[] {
  return hops.map((hop, index) => {
    const wire: JumpHop = { host: hop.host, port: hop.port, user: hop.user };
    if (!hop.authMethod) return wire;
    const label = `Jump hop ${index + 1} (${hop.user}@${hop.host}:${hop.port})`;
    const secret = secrets[index] ?? {};
    wire.authMethod = hop.authMethod;
    if (hop.authMethod === 'password') {
      if (!secret.password) throw new Error(`${label} needs its password`);
      wire.password = secret.password;
    } else if (hop.authMethod === 'private_key') {
      if (!secret.privateKeyPem) throw new Error(`${label} needs its private key`);
      wire.privateKeyPem = secret.privateKeyPem;
      if (secret.privateKeyPassphrase) wire.privateKeyPassphrase = secret.privateKeyPassphrase;
    } else {
      if (!hop.keyFingerprint) throw new Error(`${label} names no vault key fingerprint`);
      if (!secret.publicKey) throw new Error(`${label} needs the public key of ${hop.keyFingerprint}`);
      wire.keyFingerprint = hop.keyFingerprint;
      wire.publicKey = secret.publicKey;
    }
    return wire;
  });
}

function sanitizeHostProfile(raw: unknown): HostProfile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' && obj.id.trim().length > 0 ? obj.id.trim() : null;
  const host = typeof obj.host === 'string' && obj.host.trim().length > 0 ? obj.host.trim() : null;
  if (!id || !host) {
    return null;
  }
  const alias = typeof obj.alias === 'string' && obj.alias.trim().length > 0 ? obj.alias.trim() : host;
  const user = typeof obj.user === 'string' && obj.user.trim().length > 0 ? obj.user.trim() : 'root';
  const port =
    typeof obj.port === 'number' && Number.isFinite(obj.port) && obj.port > 0 && obj.port <= 65535
      ? obj.port
      : 22;
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === 'string')
    : [];
  const jumpHops: HostJumpHop[] = Array.isArray(obj.jumpHops)
    ? obj.jumpHops
        .filter((jh): jh is Record<string, unknown> => typeof jh === 'object' && jh !== null)
        .filter((jh) => typeof jh.host === 'string' && jh.host.length > 0)
        .map((jh) =>
          toSavedHop({
            host: String(jh.host),
            port: typeof jh.port === 'number' && Number.isFinite(jh.port) ? jh.port : 22,
            user: typeof jh.user === 'string' && jh.user.length > 0 ? jh.user : 'root',
            authMethod: jh.authMethod as HopAuthMethod | undefined,
            keyFingerprint: jh.keyFingerprint as string | undefined
          })
        )
    : [];

  return {
    id,
    alias,
    host,
    port,
    user,
    keyFingerprint: typeof obj.keyFingerprint === 'string' ? obj.keyFingerprint : undefined,
    folder: typeof obj.folder === 'string' ? obj.folder : undefined,
    tags,
    favorite: Boolean(obj.favorite),
    notes: typeof obj.notes === 'string' ? obj.notes : undefined,
    jumpHops,
    env: sanitizeEnv(obj.env),
    tmuxAutoAttach: typeof obj.tmuxAutoAttach === 'string' ? obj.tmuxAutoAttach : undefined,
    lastConnectedAt: typeof obj.lastConnectedAt === 'number' ? obj.lastConnectedAt : undefined
  };
}

function parseJumpHopSpec(spec: string, byAlias: Map<string, RawHostBlock>, defaultUser: string): HostJumpHop {
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
    const jumpHops: HostJumpHop[] = [];
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
