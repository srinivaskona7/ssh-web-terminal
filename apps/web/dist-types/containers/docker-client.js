import { posixQuote } from '../recipes/engine.js';
const CONTAINER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
function assertRef(value, what) {
    const trimmed = value.trim();
    if (!CONTAINER_ID.test(trimmed) || trimmed.startsWith('-')) {
        throw new Error(`Invalid ${what} "${value}"`);
    }
    return trimmed;
}
/** Docker's `--format '{{json .}}'` prints one JSON object per line. */
export function parseJsonLines(text) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{'))
            continue;
        try {
            out.push(JSON.parse(trimmed));
        }
        catch {
            // Skip malformed lines rather than failing the whole listing.
        }
    }
    return out;
}
export class DockerClient {
    session;
    constructor(session) {
        this.session = session;
    }
    async available() {
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
                detail: (daemon.stderr || daemon.stdout).trim() ||
                    'Docker CLI is installed, but the daemon is unreachable for this user'
            };
        }
        return { ok: true, detail: `Docker ${daemon.stdout.trim()}` };
    }
    async listContainers(all = true) {
        const format = '{{json .}}';
        const result = await this.session.exec(`docker ps ${all ? '--all' : ''} --no-trunc --format ${posixQuote(format)}`, { timeoutMs: 30_000 });
        if (result.exitCode !== 0) {
            throw new Error(`docker ps failed: ${(result.stderr || result.stdout).trim()}`);
        }
        return parseJsonLines(result.stdout).map((row) => ({
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
    async images() {
        const result = await this.session.exec(`docker images --format ${posixQuote('{{json .}}')}`, { timeoutMs: 30_000 });
        if (result.exitCode !== 0) {
            throw new Error(`docker images failed: ${(result.stderr || result.stdout).trim()}`);
        }
        return parseJsonLines(result.stdout).map((row) => ({
            id: row['ID'] ?? '',
            repository: row['Repository'] ?? '',
            tag: row['Tag'] ?? '',
            size: row['Size'] ?? '',
            createdAt: row['CreatedAt'] ?? ''
        }));
    }
    async volumes() {
        const result = await this.session.exec(`docker volume ls --format ${posixQuote('{{json .}}')}`, { timeoutMs: 30_000 });
        if (result.exitCode !== 0)
            throw new Error((result.stderr || result.stdout).trim());
        return parseJsonLines(result.stdout).map((row) => ({
            name: row['Name'] ?? '',
            driver: row['Driver'] ?? '',
            mountpoint: row['Mountpoint'] ?? '',
            scope: row['Scope'] ?? ''
        }));
    }
    async networks() {
        const result = await this.session.exec(`docker network ls --format ${posixQuote('{{json .}}')}`, { timeoutMs: 30_000 });
        if (result.exitCode !== 0)
            throw new Error((result.stderr || result.stdout).trim());
        return parseJsonLines(result.stdout).map((row) => ({
            id: row['ID'] ?? '',
            name: row['Name'] ?? '',
            driver: row['Driver'] ?? '',
            scope: row['Scope'] ?? ''
        }));
    }
    async inspect(id) {
        const ref = assertRef(id, 'container reference');
        const result = await this.session.exec(`docker inspect ${posixQuote(ref)}`, {
            timeoutMs: 30_000
        });
        if (result.exitCode !== 0)
            throw new Error((result.stderr || result.stdout).trim());
        try {
            return JSON.parse(result.stdout);
        }
        catch {
            throw new Error('docker inspect returned invalid JSON');
        }
    }
    async logs(id, tail = 200) {
        const ref = assertRef(id, 'container reference');
        const safeTail = Math.max(1, Math.min(10_000, Math.floor(tail)));
        const result = await this.session.exec(`docker logs --tail ${safeTail} ${posixQuote(ref)} 2>&1`, { timeoutMs: 60_000 });
        return result.stdout + result.stderr;
    }
    async start(id) {
        await this.action('start', id);
    }
    async stop(id) {
        await this.action('stop', id);
    }
    async restart(id) {
        await this.action('restart', id);
    }
    async action(verb, id) {
        const ref = assertRef(id, 'container reference');
        const result = await this.session.exec(`docker ${verb} ${posixQuote(ref)}`, {
            timeoutMs: 90_000
        });
        if (result.exitCode !== 0) {
            throw new Error(`docker ${verb} failed: ${(result.stderr || result.stdout).trim()}`);
        }
    }
    /** Validate a Compose file without changing anything. */
    async validateCompose(filePath) {
        const result = await this.session.exec(`docker compose -f ${posixQuote(filePath)} config --quiet`, { timeoutMs: 60_000 });
        return { ok: result.exitCode === 0, detail: (result.stderr || result.stdout).trim() };
    }
    async composeUp(filePath) {
        const result = await this.session.exec(`docker compose -f ${posixQuote(filePath)} up -d --remove-orphans`, { timeoutMs: 15 * 60_000 });
        if (result.exitCode !== 0) {
            throw new Error(`docker compose up failed: ${(result.stderr || result.stdout).trim()}`);
        }
        return result.stdout + result.stderr;
    }
}
//# sourceMappingURL=docker-client.js.map