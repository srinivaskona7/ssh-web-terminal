const DEFAULT_SUGGESTIONS = [
    'help',
    'connect root@edge-01.prod.internal',
    'connect ubuntu@10.0.0.5',
    'pubkey',
    'font 17',
    'font 20',
    'clear',
    'vault',
    'split',
    'features',
    'telemetry',
    'tunnels',
    'playbooks',
    'kubectl get pods -A',
    'docker ps --format "table {{.Names}}	{{.Status}}"',
    'systemctl status nginx --no-pager',
    'journalctl -p err -n 50 --no-pager',
    'ss -tulnp',
    'tail -f /var/log/nginx/error.log'
];
export function computeGhostAutocomplete(currentInput, history = []) {
    const trimmed = currentInput;
    if (!trimmed || trimmed.length === 0)
        return '';
    const lower = trimmed.toLowerCase();
    // Search recent history first (reverse order)
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const item = history[i];
        if (item && item.toLowerCase().startsWith(lower) && item.length > trimmed.length) {
            return item.slice(trimmed.length);
        }
    }
    for (const candidate of DEFAULT_SUGGESTIONS) {
        if (candidate.toLowerCase().startsWith(lower) && candidate.length > trimmed.length) {
            return candidate.slice(trimmed.length);
        }
    }
    return '';
}
const DANGEROUS_PATTERNS = [
    { pattern: /\brm\s+(-[rRfF]+\s+)+(\/|\/\*|~)(\s|$)/i, reason: 'Recursive root or home directory deletion (rm -rf /)' },
    { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: 'Filesystem formatting command (mkfs)' },
    { pattern: /\bdd\s+.*of=\/dev\//i, reason: 'Raw block device overwrite (dd of=/dev/...)' },
    { pattern: /\bdrop\s+(database|table)\b/i, reason: 'Destructive SQL schema drop (DROP DATABASE/TABLE)' },
    { pattern: /\bchmod\s+(-R\s+)?777\s+\//i, reason: 'World-writable root permission change (chmod 777 /)' },
    { pattern: /\bshutdown\b|\breboot\b/i, reason: 'System power state change (shutdown/reboot)' }
];
export function detectDangerousCommand(command) {
    const trimmed = command.trim();
    for (const entry of DANGEROUS_PATTERNS) {
        if (entry.pattern.test(trimmed)) {
            return { dangerous: true, reason: entry.reason };
        }
    }
    return { dangerous: false, reason: '' };
}
export function redactSecretsInText(text, enabled) {
    if (!enabled)
        return text;
    return text
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA••••••••••••••••')
        .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, 'eyJ•••REDACTED_JWT•••')
        .replace(/(password|passwd|secret|token|api_key)\s*[:=]\s*[^\s"']+/gi, '$1=••••••••REDACTED••••••••')
        .replace(/AAAAC3NzaC1lZDI1NTE5[a-zA-Z0-9+/=]{12,}/g, 'AAAAC3NzaC1lZDI1NTE5•••REDACTED_KEY•••');
}
export function formatChmodOctal(perms) {
    const owner = (perms.ownerRead ? 4 : 0) + (perms.ownerWrite ? 2 : 0) + (perms.ownerExec ? 1 : 0);
    const group = (perms.groupRead ? 4 : 0) + (perms.groupWrite ? 2 : 0) + (perms.groupExec ? 1 : 0);
    const pub = (perms.publicRead ? 4 : 0) + (perms.publicWrite ? 2 : 0) + (perms.publicExec ? 1 : 0);
    const sym = [
        '-',
        perms.ownerRead ? 'r' : '-',
        perms.ownerWrite ? 'w' : '-',
        perms.ownerExec ? 'x' : '-',
        perms.groupRead ? 'r' : '-',
        perms.groupWrite ? 'w' : '-',
        perms.groupExec ? 'x' : '-',
        perms.publicRead ? 'r' : '-',
        perms.publicWrite ? 'w' : '-',
        perms.publicExec ? 'x' : '-'
    ].join('');
    return {
        octal: `0${owner}${group}${pub}`,
        symbolic: sym
    };
}
export function computeSideBySideDiff(originalText, modifiedText) {
    const nl = String.fromCharCode(10);
    const origLines = originalText.split(nl);
    const modLines = modifiedText.split(nl);
    const maxLen = Math.max(origLines.length, modLines.length);
    const result = [];
    for (let i = 0; i < maxLen; i += 1) {
        const before = origLines[i] ?? '';
        const after = modLines[i] ?? '';
        let status = 'unchanged';
        if (i >= origLines.length) {
            status = 'added';
        }
        else if (i >= modLines.length) {
            status = 'removed';
        }
        else if (before !== after) {
            status = 'modified';
        }
        result.push({
            lineNumber: i + 1,
            before,
            after,
            status
        });
    }
    return result;
}
export const DATABASE_TUNNEL_TEMPLATES = [
    {
        name: 'PostgreSQL Primary',
        type: 'L',
        bindAddress: '127.0.0.1',
        localPort: 5432,
        remoteHost: '127.0.0.1',
        remotePort: 5432,
        active: true,
        bytesTransferred: 184320
    },
    {
        name: 'MySQL Replica',
        type: 'L',
        bindAddress: '127.0.0.1',
        localPort: 3306,
        remoteHost: '127.0.0.1',
        remotePort: 3306,
        active: true,
        bytesTransferred: 92160
    },
    {
        name: 'Redis Cluster',
        type: 'L',
        bindAddress: '127.0.0.1',
        localPort: 6379,
        remoteHost: '127.0.0.1',
        remotePort: 6379,
        active: true,
        bytesTransferred: 65536
    },
    {
        name: 'Prometheus Metrics',
        type: 'L',
        bindAddress: '127.0.0.1',
        localPort: 9090,
        remoteHost: '127.0.0.1',
        remotePort: 9090,
        active: true,
        bytesTransferred: 311296
    },
    {
        name: 'Dynamic SOCKS5 Proxy',
        type: 'D',
        bindAddress: '127.0.0.1',
        localPort: 1080,
        remoteHost: '*',
        remotePort: 0,
        active: true,
        bytesTransferred: 524288
    }
];
//# sourceMappingURL=advanced-features.js.map