import { posixQuote } from '../recipes/engine.js';
function assertPath(path, label) {
    if (!path || !/^(?:\/|~\/)[^\u0000-\u001f]*$/.test(path)) {
        throw new Error(`${label} must be an absolute path (or ~/...)`);
    }
    return path;
}
export const AUTOMATION_TEMPLATES = [
    {
        id: 'backup-directory',
        version: '1.0.0',
        title: 'Timestamped directory backup',
        description: 'Creates a compressed archive in ~/webssh-backups and optionally prunes archives older than the retention window.',
        destructive: false,
        fields: [
            { id: 'target', label: 'Directory to back up', placeholder: '/var/www/app', required: true },
            { id: 'retentionDays', label: 'Keep archives for (days)', required: false, default: 14 }
        ],
        build(input) {
            const target = assertPath(input.target, 'Backup target');
            const days = Math.max(1, Math.min(3650, Math.floor(input.retentionDays ?? 14)));
            const name = target.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '') || 'backup';
            return [
                '#!/bin/sh',
                'set -eu',
                'mkdir -p "$HOME/webssh-backups"',
                `tar -czf "$HOME/webssh-backups/${name}-$(date +%Y%m%d-%H%M%S).tar.gz" ${posixQuote(target)}`,
                `find "$HOME/webssh-backups" -name ${posixQuote(`${name}-*.tar.gz`)} -type f -mtime +${days} -print -delete`
            ].join('\n');
        }
    },
    {
        id: 'log-cleanup',
        version: '1.0.0',
        title: 'Truncate old log files',
        description: 'Empties log files older than the retention window instead of deleting them, so open file handles keep working.',
        destructive: true,
        fields: [
            { id: 'target', label: 'Log directory', placeholder: '/var/log/myapp', required: true },
            { id: 'retentionDays', label: 'Older than (days)', required: false, default: 30 },
            { id: 'dryRun', label: 'Dry run (list only)', required: false, default: true }
        ],
        build(input) {
            const target = assertPath(input.target, 'Log directory');
            const days = Math.max(1, Math.min(3650, Math.floor(input.retentionDays ?? 30)));
            const action = input.dryRun === false ? '-exec truncate -s 0 {} \\;' : '-print';
            return [
                '#!/bin/sh',
                'set -eu',
                `find ${posixQuote(target)} -type f -name '*.log' -mtime +${days} ${action}`
            ].join('\n');
        }
    },
    {
        id: 'http-health-check',
        version: '1.0.0',
        title: 'HTTP health check',
        description: 'Requests a URL and exits non-zero when the response is not 2xx. Suitable for cron or a deployment gate.',
        destructive: false,
        fields: [
            { id: 'url', label: 'Health URL', placeholder: 'http://127.0.0.1:3000/health', required: true }
        ],
        build(input) {
            const url = (input.url ?? '').trim();
            if (!/^https?:\/\/[^\s"']+$/.test(url)) {
                throw new Error('Health URL must start with http:// or https:// and contain no spaces');
            }
            return [
                '#!/bin/sh',
                'set -eu',
                `code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 ${posixQuote(url)})`,
                'case "$code" in 2*) echo "healthy ($code)"; exit 0;; *) echo "unhealthy ($code)"; exit 1;; esac'
            ].join('\n');
        }
    },
    {
        id: 'artifact-cleanup',
        version: '1.0.0',
        title: 'Remove stale build artifacts',
        description: 'Deletes temporary files matching a suffix older than the retention window. Dry run by default.',
        destructive: true,
        fields: [
            { id: 'target', label: 'Project directory', placeholder: '/srv/app', required: true },
            { id: 'retentionDays', label: 'Older than (days)', required: false, default: 7 },
            { id: 'dryRun', label: 'Dry run (list only)', required: false, default: true }
        ],
        build(input) {
            const target = assertPath(input.target, 'Project directory');
            const days = Math.max(1, Math.min(3650, Math.floor(input.retentionDays ?? 7)));
            const action = input.dryRun === false ? '-delete' : '-print';
            return [
                '#!/bin/sh',
                'set -eu',
                `find ${posixQuote(target)} -type f \\( -name '*.tmp' -o -name '*.part' -o -name '*.log.old' \\) -mtime +${days} ${action}`
            ].join('\n');
        }
    },
    {
        id: 'deployment-gate',
        version: '1.0.0',
        title: 'Deployment verification gate',
        description: 'Checks the deployed revision and service state before declaring a deployment healthy.',
        destructive: false,
        fields: [
            { id: 'workdir', label: 'Deployed project directory', placeholder: '/srv/app', required: true },
            { id: 'url', label: 'Health URL (optional)', placeholder: 'http://127.0.0.1:3000/health', required: false }
        ],
        build(input) {
            const workdir = assertPath(input.workdir, 'Project directory');
            const lines = [
                '#!/bin/sh',
                'set -eu',
                `cd ${posixQuote(workdir)}`,
                'echo "revision: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"'
            ];
            if (input.url) {
                const url = input.url.trim();
                if (!/^https?:\/\/[^\s"']+$/.test(url))
                    throw new Error('Health URL is invalid');
                lines.push(`code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 ${posixQuote(url)})`, 'case "$code" in 2*) echo "health: $code";; *) echo "health: $code"; exit 1;; esac');
            }
            return lines.join('\n');
        }
    }
];
export function getAutomationTemplate(id) {
    return AUTOMATION_TEMPLATES.find((t) => t.id === id);
}
//# sourceMappingURL=templates.js.map