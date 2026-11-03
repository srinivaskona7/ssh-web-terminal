/**
 * Server discovery and the typed capability model.
 *
 * Discovery is read-only: it never installs packages, edits configuration or
 * reads secret files. Everything here is derived from a single bounded POSIX
 * `sh` script whose output is parsed locally.
 */
/** Tools probed by name. Order is stable so the UI does not jump around. */
export const PROBED_TOOLS = [
    { id: 'git', name: 'Git', category: 'development' },
    { id: 'python3', name: 'Python 3', category: 'development' },
    { id: 'pip3', name: 'pip', category: 'development' },
    { id: 'node', name: 'Node.js', category: 'development' },
    { id: 'npm', name: 'npm', category: 'development' },
    { id: 'go', name: 'Go', category: 'development' },
    { id: 'rustc', name: 'Rust', category: 'development' },
    { id: 'cargo', name: 'Cargo', category: 'development' },
    { id: 'java', name: 'Java', category: 'development' },
    { id: 'php', name: 'PHP', category: 'development' },
    { id: 'ruby', name: 'Ruby', category: 'development' },
    { id: 'make', name: 'GNU make', category: 'build' },
    { id: 'gcc', name: 'GCC', category: 'build' },
    { id: 'docker', name: 'Docker Engine', category: 'containers' },
    { id: 'docker-compose', name: 'Docker Compose (v1)', category: 'containers' },
    { id: 'podman', name: 'Podman', category: 'containers' },
    { id: 'buildah', name: 'Buildah', category: 'containers' },
    { id: 'kubectl', name: 'kubectl', category: 'kubernetes' },
    { id: 'helm', name: 'Helm', category: 'kubernetes' },
    { id: 'k3s', name: 'k3s', category: 'kubernetes' },
    { id: 'ansible', name: 'Ansible', category: 'automation' },
    { id: 'terraform', name: 'Terraform', category: 'automation' },
    { id: 'nginx', name: 'NGINX', category: 'services' },
    { id: 'caddy', name: 'Caddy', category: 'services' },
    { id: 'systemctl', name: 'systemd', category: 'services' },
    { id: 'psql', name: 'PostgreSQL client', category: 'data' },
    { id: 'redis-cli', name: 'Redis client', category: 'data' },
    { id: 'sqlite3', name: 'SQLite', category: 'data' },
    { id: 'htop', name: 'htop', category: 'observability' },
    { id: 'curl', name: 'curl', category: 'observability' },
    { id: 'wget', name: 'wget', category: 'observability' },
    { id: 'jq', name: 'jq', category: 'observability' },
    { id: 'tmux', name: 'tmux', category: 'terminal' }
];
const SECTION = '@@WEBSSH';
/**
 * Single read-only probe. Every external command is either a builtin or a
 * tool invoked with a version flag; nothing mutates state. The script is
 * static — no user input is interpolated.
 */
export function buildDiscoveryScript() {
    const toolIds = PROBED_TOOLS.map((t) => t.id).join(' ');
    return [
        'export LC_ALL=C',
        `echo "${SECTION}:hostname"; hostname 2>/dev/null || uname -n`,
        `echo "${SECTION}:uname"; uname -s; uname -r; uname -m`,
        `echo "${SECTION}:osrelease"; cat /etc/os-release 2>/dev/null || true`,
        `echo "${SECTION}:cpu"; (nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0); grep -m1 "^model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2- || true`,
        `echo "${SECTION}:mem"; (free -m 2>/dev/null || true)`,
        `echo "${SECTION}:df"; df -Pk 2>/dev/null | tail -n +2 || true`,
        `echo "${SECTION}:id"; id 2>/dev/null || true`,
        'echo "@@WEBSSH:groups"; (id -Gn 2>/dev/null || echo)',
        'echo "@@WEBSSH:home"; printf "%s\\n" "$HOME"; printf "%s\\n" "${SHELL:-}"',
        `echo "${SECTION}:sudo"; if command -v sudo >/dev/null 2>&1; then echo yes; if sudo -n true 2>/dev/null; then echo nopasswd; else echo password; fi; else echo no; fi`,
        `echo "${SECTION}:pkg"; for m in apt-get dnf yum apk pacman zypper; do command -v "$m" >/dev/null 2>&1 && { echo "$m"; break; }; done`,
        `echo "${SECTION}:init"; if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then echo systemd; elif command -v rc-service >/dev/null 2>&1; then echo openrc; elif command -v service >/dev/null 2>&1; then echo service; else echo none; fi`,
        `echo "${SECTION}:tools"; for t in ${toolIds}; do p=$(command -v "$t" 2>/dev/null) && printf "TOOL %s %s\\n" "$t" "$p"; done`,
        `echo "${SECTION}:versions"; for t in ${toolIds}; do if command -v "$t" >/dev/null 2>&1; then v=$("$t" --version 2>/dev/null | head -n 1); [ -n "$v" ] && printf "VER %s %s\\n" "$t" "$v"; fi; done`,
        `echo "${SECTION}:ports"; (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true)`,
        `echo "${SECTION}:firewall"; if command -v ufw >/dev/null 2>&1; then echo ufw; ufw status 2>/dev/null | head -n 1; elif command -v firewall-cmd >/dev/null 2>&1; then echo firewalld; firewall-cmd --state 2>/dev/null; elif command -v nft >/dev/null 2>&1; then echo nft; elif command -v iptables >/dev/null 2>&1; then echo iptables; else echo none; fi`,
        `echo "${SECTION}:time"; (timedatectl 2>/dev/null | grep -i "synchronized" || chronyc tracking 2>/dev/null | grep -i "Leap status" || echo unknown)`,
        `echo "${SECTION}:reboot"; [ -f /var/run/reboot-required ] && echo yes || echo no`,
        `echo "${SECTION}:end"`
    ].join('\n');
}
function sections(stdout) {
    const map = new Map();
    let current = '_';
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
        if (line.startsWith(`${SECTION}:`)) {
            current = line.slice(SECTION.length + 1).trim();
            map.set(current, []);
            continue;
        }
        if (!map.has(current))
            map.set(current, []);
        map.get(current).push(line);
    }
    return map;
}
function firstVersionToken(text) {
    const match = text.match(/(\d+\.\d+(?:\.\d+)?(?:[-+~][\w.]+)?)/);
    return match?.[1];
}
export function parseCapabilities(stdout, hints = {}) {
    const s = sections(stdout);
    const lines = (key) => (s.get(key) ?? []).filter((l) => l.trim().length > 0);
    const uname = lines('uname');
    const osRelease = lines('osrelease');
    const osMap = new Map();
    for (const line of osRelease) {
        const idx = line.indexOf('=');
        if (idx === -1)
            continue;
        osMap.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^"|"$/g, ''));
    }
    const cpuLines = lines('cpu');
    const cores = Number.parseInt(cpuLines[0] ?? '0', 10) || 0;
    const cpuModel = (cpuLines[1] ?? '').trim();
    const memLines = lines('mem');
    let totalMiB = 0;
    let availableMiB = 0;
    let swapMiB = 0;
    for (const line of memLines) {
        const parts = line.split(/\s+/);
        if (parts[0] === 'Mem:') {
            totalMiB = Number.parseInt(parts[1] ?? '0', 10) || 0;
            availableMiB = Number.parseInt(parts[6] ?? parts[3] ?? '0', 10) || 0;
        }
        else if (parts[0] === 'Swap:') {
            swapMiB = Number.parseInt(parts[1] ?? '0', 10) || 0;
        }
    }
    const disks = [];
    for (const line of lines('df')) {
        const parts = line.split(/\s+/);
        if (parts.length < 6)
            continue;
        // df -Pk columns: filesystem blocks used available capacity mount
        const [filesystem, totalK, usedK, availK, percent, ...rest] = parts;
        if (!/^\d+$/.test(totalK ?? '') || !/^\d+$/.test(usedK ?? ''))
            continue;
        const mount = rest.join(' ');
        const total = Number.parseInt(totalK, 10);
        // Skip pseudo filesystems with zero capacity and the ubiquitous tmpfs noise.
        if (total === 0)
            continue;
        if (/^(tmpfs|devtmpfs|squashfs|overlay|udev)$/.test(filesystem))
            continue;
        disks.push({
            mount: mount || '/',
            filesystem: filesystem,
            totalMiB: Math.round(total / 1024),
            usedMiB: Math.round(Number.parseInt(usedK, 10) / 1024),
            availableMiB: Math.round(Number.parseInt(availK, 10) / 1024),
            usePercent: Number.parseInt((percent ?? '0').replace('%', ''), 10) || 0
        });
    }
    const idLine = (lines('id')[0] ?? '').trim();
    const idMatch = idLine.match(/uid=(\d+)\(([^)]*)\)/);
    const uid = idMatch ? Number.parseInt(idMatch[1], 10) : -1;
    const username = idMatch?.[2] ?? '';
    const homeLines = lines('home');
    const home = homeLines[0] ?? '';
    const shell = homeLines[1] ?? '';
    const groups = (lines('groups')[0] ?? '').split(/\s+/).filter(Boolean);
    const sudoLines = lines('sudo');
    const sudoAvailable = sudoLines[0] === 'yes';
    const sudoNopasswd = hints.sudoNopasswd ?? (sudoLines[1] === 'nopasswd' || uid === 0);
    const pkgLine = (lines('pkg')[0] ?? '').trim();
    const initLine = (lines('init')[0] ?? 'none').trim();
    const tools = {};
    for (const meta of PROBED_TOOLS) {
        tools[meta.id] = { id: meta.id, name: meta.name, state: 'unsupported' };
    }
    for (const line of lines('tools')) {
        const [, id, path] = line.split(/\s+/, 3);
        if (!id || !tools[id])
            continue;
        tools[id] = { ...tools[id], state: 'installed', path };
    }
    for (const line of lines('versions')) {
        const [, id, ...rest] = line.split(/\s+/);
        if (!id || !tools[id])
            continue;
        tools[id] = {
            ...tools[id],
            state: 'installed',
            version: firstVersionToken(rest.join(' '))
        };
    }
    const listeners = [];
    for (const line of lines('ports')) {
        const parts = line.split(/\s+/);
        if (parts.length < 4)
            continue;
        const stateIndex = parts.findIndex((p) => p === 'LISTEN' || p === 'LISTENING');
        const localIdx = stateIndex > 0 ? stateIndex - 1 : 3;
        const local = parts[localIdx] ?? '';
        const colon = local.lastIndexOf(':');
        if (colon === -1)
            continue;
        const address = local.slice(0, colon).replace(/^\[|\]$/g, '');
        const port = Number.parseInt(local.slice(colon + 1), 10);
        if (!Number.isFinite(port))
            continue;
        listeners.push({ protocol: 'tcp', address: address || '*', port });
    }
    const firewallLines = lines('firewall');
    const firewallTool = (firewallLines[0] ?? 'none').trim();
    const firewallStateText = firewallLines.slice(1).join(' ').toLowerCase();
    const firewallActive = firewallTool === 'none'
        ? null
        : firewallStateText.includes('active') || firewallStateText.includes('running')
            ? true
            : firewallStateText.length > 0
                ? false
                : null;
    const timeLine = lines('time').join(' ').toLowerCase();
    const synchronized = timeLine.includes('yes')
        ? true
        : timeLine.includes('no') || timeLine.includes('not')
            ? false
            : null;
    const warnings = [];
    if (cores === 0)
        warnings.push('Could not determine CPU core count.');
    if (totalMiB === 0)
        warnings.push('Could not read memory information.');
    if (!pkgLine)
        warnings.push('No supported package manager detected.');
    if (hints.sftpAvailable === false) {
        warnings.push('The SFTP subsystem is unavailable; file operations are disabled.');
    }
    const distro = osMap.get('NAME') ?? uname[0] ?? 'unknown';
    const osVersion = osMap.get('VERSION_ID') ?? '';
    return {
        schemaVersion: 1,
        collectedAt: Date.now(),
        hostname: (lines('hostname')[0] ?? '').trim(),
        os: {
            family: /linux/i.test(uname[0] ?? '') ? 'linux' : (uname[0] ?? 'unknown').toLowerCase(),
            distro,
            version: osVersion,
            kernel: uname[1] ?? '',
            arch: uname[2] ?? '',
            virtualization: undefined
        },
        cpu: { cores, model: cpuModel },
        memory: { totalMiB, availableMiB, swapMiB },
        disks,
        user: {
            name: username || hints.user || '',
            uid,
            groups,
            shell,
            home,
            isRoot: uid === 0
        },
        privilege: { sudoAvailable, sudoNopasswd, isRoot: uid === 0 },
        packages: {
            manager: pkgLine || null,
            repositories: pkgLine ? 'configured' : 'unknown'
        },
        init: { manager: initLine === 'none' ? null : initLine, systemd: initLine === 'systemd' },
        tools,
        listeners,
        firewall: { tool: firewallTool === 'none' ? null : firewallTool, active: firewallActive },
        time: { synchronized, detail: lines('time').join(' ').trim() },
        warnings
    };
}
/**
 * Run discovery against a live SSH session. Bounded to 20s and 4 MiB of
 * output; failures return a capabilities object carrying explicit warnings
 * rather than throwing — the workspace still works without discovery.
 */
export async function discoverServer(session, hints = {}) {
    let sftpAvailable = hints.sftpAvailable;
    if (sftpAvailable === undefined) {
        try {
            await session.getSftpClient();
            sftpAvailable = true;
        }
        catch {
            sftpAvailable = false;
        }
    }
    const result = await session.execCommand(buildDiscoveryScript(), 20_000);
    const capabilities = parseCapabilities(result.stdout, { ...hints, sftpAvailable });
    if (result.exitCode !== 0 && result.stderr) {
        capabilities.warnings.push(`Discovery script reported: ${result.stderr.trim().slice(0, 400)}`);
    }
    return capabilities;
}
//# sourceMappingURL=capabilities.js.map