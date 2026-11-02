export class HostRegistry {
    hosts = new Map();
    storageKey;
    constructor(storageKey = 'webssh.hosts.v1') {
        this.storageKey = storageKey;
        this.load();
    }
    load() {
        try {
            if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
                const raw = localStorage.getItem(this.storageKey);
                if (raw) {
                    const parsed = JSON.parse(raw);
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
        }
        catch {
            // Ignore malformed or unavailable storage without wiping other keys
        }
    }
    save() {
        try {
            if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
                localStorage.setItem(this.storageKey, JSON.stringify(Array.from(this.hosts.values())));
            }
        }
        catch {
            // Ignore unavailable storage
        }
    }
    upsert(profile) {
        this.hosts.set(profile.id, profile);
        this.save();
        return profile;
    }
    remove(id) {
        const deleted = this.hosts.delete(id);
        this.save();
        return deleted;
    }
    get(id) {
        return this.hosts.get(id);
    }
    list(query = '', folder, tag) {
        const q = query.trim().toLowerCase();
        return Array.from(this.hosts.values())
            .filter((h) => {
            if (folder && h.folder !== folder)
                return false;
            if (tag && !h.tags.includes(tag))
                return false;
            if (!q)
                return true;
            return (h.alias.toLowerCase().includes(q) ||
                h.host.toLowerCase().includes(q) ||
                h.user.toLowerCase().includes(q) ||
                h.tags.some((t) => t.toLowerCase().includes(q)));
        })
            .sort((a, b) => {
            if (a.favorite !== b.favorite)
                return a.favorite ? -1 : 1;
            return a.alias.localeCompare(b.alias);
        });
    }
    importSshConfig(configText, defaultUser = 'root') {
        const imported = parseOpenSshConfig(configText, defaultUser);
        for (const h of imported) {
            this.hosts.set(h.id, h);
        }
        this.save();
        return imported;
    }
}
function sanitizeHostProfile(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return null;
    }
    const obj = raw;
    const id = typeof obj.id === 'string' && obj.id.trim().length > 0 ? obj.id.trim() : null;
    const host = typeof obj.host === 'string' && obj.host.trim().length > 0 ? obj.host.trim() : null;
    if (!id || !host) {
        return null;
    }
    const alias = typeof obj.alias === 'string' && obj.alias.trim().length > 0 ? obj.alias.trim() : host;
    const user = typeof obj.user === 'string' && obj.user.trim().length > 0 ? obj.user.trim() : 'root';
    const port = typeof obj.port === 'number' && Number.isFinite(obj.port) && obj.port > 0 && obj.port <= 65535
        ? obj.port
        : 22;
    const tags = Array.isArray(obj.tags)
        ? obj.tags.filter((t) => typeof t === 'string')
        : [];
    const jumpHops = Array.isArray(obj.jumpHops)
        ? obj.jumpHops
            .filter((jh) => typeof jh === 'object' && jh !== null)
            .filter((jh) => typeof jh.host === 'string' && jh.host.length > 0)
            .map((jh) => ({
            host: String(jh.host),
            port: typeof jh.port === 'number' && Number.isFinite(jh.port) ? jh.port : 22,
            user: typeof jh.user === 'string' && jh.user.length > 0 ? jh.user : 'root'
        }))
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
        tmuxAutoAttach: typeof obj.tmuxAutoAttach === 'string' ? obj.tmuxAutoAttach : undefined,
        lastConnectedAt: typeof obj.lastConnectedAt === 'number' ? obj.lastConnectedAt : undefined
    };
}
function parseJumpHopSpec(spec, byAlias, defaultUser) {
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
export function parseOpenSshConfig(configText, defaultUser = 'root') {
    const blocks = [];
    let current = [];
    const lines = configText.split(String.fromCharCode(10));
    for (const rawLine of lines) {
        const stripped = rawLine.replace(/#.*$/, '').trim();
        if (!stripped)
            continue;
        const match = stripped.match(/^(\S+)\s+(.*)$/);
        if (!match)
            continue;
        const key = match[1].toLowerCase();
        const val = match[2].trim().replace(/^"|"$/g, '');
        if (key === 'host') {
            const aliases = val
                .split(/\s+/)
                .filter((a) => a.length > 0 && !a.includes('*') && !a.includes('?'));
            current = aliases.map((alias) => {
                const block = { alias };
                blocks.push(block);
                return block;
            });
            continue;
        }
        for (const block of current) {
            if (key === 'hostname') {
                block.hostName = val;
            }
            else if (key === 'user') {
                block.user = val;
            }
            else if (key === 'port') {
                const p = Number.parseInt(val, 10);
                if (Number.isFinite(p) && p > 0 && p <= 65535) {
                    block.port = p;
                }
            }
            else if (key === 'proxyjump') {
                block.proxyJump = val
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0 && s.toLowerCase() !== 'none');
            }
        }
    }
    const byAlias = new Map();
    for (const b of blocks) {
        byAlias.set(b.alias, b);
    }
    return blocks.map((b) => {
        const jumpHops = [];
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
//# sourceMappingURL=index.js.map