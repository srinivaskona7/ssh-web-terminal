import { posixQuote } from '../recipes/engine.js';
const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i;
function assertName(value, what) {
    const trimmed = value.trim();
    if (!NAME_RE.test(trimmed))
        throw new Error(`Invalid ${what} "${value}"`);
    return trimmed;
}
function kubectl(args, context, namespace) {
    const parts = ['kubectl'];
    if (context)
        parts.push('--context', posixQuote(assertName(context, 'context')));
    if (namespace)
        parts.push('--namespace', posixQuote(assertName(namespace, 'namespace')));
    parts.push(...args.map(posixQuote));
    return parts.join(' ');
}
function parseJson(text, action) {
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error(`${action} returned invalid JSON`);
    }
}
export class KubernetesClient {
    session;
    context;
    namespace;
    constructor(session, context, namespace = 'default') {
        this.session = session;
        this.context = context;
        this.namespace = namespace;
    }
    ns() {
        return assertName(this.namespace, 'namespace');
    }
    async available() {
        const result = await this.session.exec('kubectl version --client --output=json', {
            timeoutMs: 20_000
        });
        if (result.exitCode !== 0) {
            return { ok: false, detail: (result.stderr || result.stdout).trim() || 'kubectl is not installed' };
        }
        const canI = await this.session.exec(kubectl(['auth', 'can-i', 'list', 'pods', '--all-namespaces'], this.context), { timeoutMs: 20_000 });
        const allowed = canI.stdout.trim() === 'yes';
        return {
            ok: true,
            detail: `${result.stdout.trim().slice(0, 200)}${allowed ? '' : ' — no cluster-wide pod visibility; namespace-scoped features only'}`
        };
    }
    async contexts() {
        const result = await this.session.exec('kubectl config view -o jsonpath={.contexts[*].name}', {
            timeoutMs: 20_000
        });
        if (result.exitCode !== 0) {
            throw new Error((result.stderr || result.stdout).trim() || 'Unable to read kubeconfig');
        }
        const current = await this.session.exec('kubectl config current-context', { timeoutMs: 15_000 });
        const currentName = current.stdout.trim();
        return result.stdout
            .split(/\s+/)
            .filter(Boolean)
            .map((name) => ({ name, current: name === currentName }));
    }
    async namespaces() {
        const result = await this.session.exec(kubectl(['get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}'], this.context), { timeoutMs: 30_000 });
        if (result.exitCode !== 0) {
            throw new Error((result.stderr || result.stdout).trim() || 'Unable to list namespaces');
        }
        return result.stdout.split(/\s+/).filter(Boolean);
    }
    async pods() {
        const result = await this.session.exec(kubectl(['get', 'pods', '-o', 'json'], this.context, this.ns()), { timeoutMs: 45_000 });
        if (result.exitCode !== 0) {
            throw new Error((result.stderr || result.stdout).trim() || 'Unable to list pods');
        }
        const payload = parseJson(result.stdout, 'kubectl get pods');
        return (payload.items ?? []).map((item) => {
            const statuses = item.status?.containerStatuses ?? [];
            const readyContainers = statuses.filter((s) => s.ready).length;
            return {
                namespace: item.metadata?.namespace ?? this.ns(),
                name: item.metadata?.name ?? '',
                phase: item.status?.phase ?? 'Unknown',
                ready: `${readyContainers}/${statuses.length}`,
                restarts: statuses.reduce((sum, s) => sum + (s.restartCount ?? 0), 0),
                node: item.spec?.nodeName ?? '',
                createdAt: item.metadata?.creationTimestamp ?? '',
                labels: item.metadata?.labels ?? {}
            };
        });
    }
    async workloads() {
        const kinds = ['deployments', 'statefulsets', 'daemonsets'];
        const out = [];
        for (const kind of kinds) {
            const result = await this.session.exec(kubectl(['get', kind, '-o', 'json'], this.context, this.ns()), { timeoutMs: 45_000 });
            if (result.exitCode !== 0)
                continue;
            const payload = parseJson(result.stdout, `kubectl get ${kind}`);
            for (const item of payload.items ?? []) {
                const replicas = item.status?.replicas ?? 0;
                out.push({
                    kind: kind.replace(/s$/, ''),
                    namespace: item.metadata?.namespace ?? this.ns(),
                    name: item.metadata?.name ?? '',
                    ready: String(item.status?.readyReplicas ?? 0),
                    available: `${item.status?.availableReplicas ?? 0}/${replicas}`,
                    age: item.metadata?.creationTimestamp ?? ''
                });
            }
        }
        return out;
    }
    async events() {
        const result = await this.session.exec(kubectl(['get', 'events', '--sort-by=.lastTimestamp', '-o', 'json'], this.context, this.ns()), { timeoutMs: 45_000 });
        if (result.exitCode !== 0) {
            throw new Error((result.stderr || result.stdout).trim() || 'Unable to list events');
        }
        const payload = parseJson(result.stdout, 'kubectl get events');
        return (payload.items ?? [])
            .map((item) => ({
            type: item.type ?? '',
            reason: item.reason ?? '',
            message: item.message ?? '',
            object: `${item.involvedObject?.kind ?? ''}/${item.involvedObject?.name ?? ''}`,
            count: item.count ?? 1,
            lastSeen: item.lastTimestamp ?? ''
        }))
            .slice(-200)
            .reverse();
    }
    async podLogs(pod, tail = 200, container) {
        const safePod = assertName(pod, 'pod name');
        const args = ['logs', safePod, `--tail=${Math.max(1, Math.min(10_000, tail))}`];
        if (container)
            args.push('-c', assertName(container, 'container name'));
        const result = await this.session.exec(kubectl(args, this.context, this.ns()), {
            timeoutMs: 60_000
        });
        if (result.exitCode !== 0) {
            throw new Error((result.stderr || result.stdout).trim() || 'Unable to read pod logs');
        }
        return result.stdout;
    }
    /** Client-side validation + server dry run. Nothing is applied. */
    async applyPreview(manifest) {
        const result = await this.session.exec(`printf %s ${posixQuote(btoa(manifest))} | base64 -d | kubectl --context ${posixQuote(assertName(this.context ?? 'default', 'context'))} diff -f - 2>&1`, { timeoutMs: 60_000 });
        // `kubectl diff` exits 1 when there are differences, which is not an error.
        return { ok: result.exitCode === 0 || result.exitCode === 1, diff: result.stdout + result.stderr };
    }
    async apply(manifest) {
        const result = await this.session.exec(`printf %s ${posixQuote(btoa(manifest))} | base64 -d | kubectl --context ${posixQuote(assertName(this.context ?? 'default', 'context'))} apply -f -`, { timeoutMs: 120_000 });
        if (result.exitCode !== 0) {
            throw new Error((result.stderr || result.stdout).trim() || 'kubectl apply failed');
        }
        return result.stdout + result.stderr;
    }
    async scale(kind, name, replicas) {
        const safeName = assertName(name, `${kind} name`);
        const count = Math.max(0, Math.min(1000, Math.floor(replicas)));
        const result = await this.session.exec(kubectl(['scale', `${kind}/${safeName}`, `--replicas=${count}`], this.context, this.ns()), { timeoutMs: 120_000 });
        if (result.exitCode !== 0) {
            throw new Error((result.stderr || result.stdout).trim() || 'kubectl scale failed');
        }
        return result.stdout + result.stderr;
    }
    async rolloutRestart(kind, name) {
        const safeName = assertName(name, `${kind} name`);
        const result = await this.session.exec(kubectl(['rollout', 'restart', `${kind}/${safeName}`], this.context, this.ns()), { timeoutMs: 120_000 });
        if (result.exitCode !== 0) {
            throw new Error((result.stderr || result.stdout).trim() || 'rollout restart failed');
        }
        return result.stdout + result.stderr;
    }
    async rolloutStatus(kind, name) {
        const safeKind = assertName(kind, 'workload kind').toLowerCase();
        const safeName = assertName(name, 'workload name');
        const result = await this.session.exec(kubectl(['rollout', 'status', `${safeKind}/${safeName}`, '--timeout=120s'], this.context, this.ns()), { timeoutMs: 150_000 });
        return (result.stdout + result.stderr).trim();
    }
    /**
     * Rollback is only offered for workloads whose controller supports
     * `rollout undo`. It cannot reverse database or external-state changes.
     */
    async rollback(kind, name) {
        const safeName = assertName(name, 'deployment name');
        const result = await this.session.exec(kubectl(['rollout', 'undo', `${kind}/${safeName}`], this.context, this.ns()), { timeoutMs: 150_000 });
        if (result.exitCode !== 0) {
            throw new Error((result.stderr || result.stdout).trim() || 'rollout undo failed');
        }
        return result.stdout + result.stderr;
    }
}
//# sourceMappingURL=kubectl-client.js.map