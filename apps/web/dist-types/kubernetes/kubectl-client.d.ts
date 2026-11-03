import type { RemoteSession } from '../session/remote-session.js';
/**
 * Kubernetes workspace, scoped strictly to an explicitly selected kubeconfig
 * context. The workspace never assumes cluster-admin: every action is whatever
 * the SSH user's kubeconfig is actually authorized to do, and errors are shown
 * verbatim.
 */
export interface KubeContext {
    name: string;
    current: boolean;
}
export interface PodSummary {
    namespace: string;
    name: string;
    phase: string;
    ready: string;
    restarts: number;
    node: string;
    createdAt: string;
    labels: Record<string, string>;
}
export interface WorkloadSummary {
    kind: string;
    namespace: string;
    name: string;
    ready: string;
    available: string;
    age: string;
}
export interface KubeEvent {
    type: string;
    reason: string;
    message: string;
    object: string;
    count: number;
    lastSeen: string;
}
export declare class KubernetesClient {
    private readonly session;
    private readonly context?;
    private readonly namespace;
    constructor(session: RemoteSession, context?: string | undefined, namespace?: string);
    private ns;
    available(): Promise<{
        ok: boolean;
        detail: string;
    }>;
    contexts(): Promise<KubeContext[]>;
    namespaces(): Promise<string[]>;
    pods(): Promise<PodSummary[]>;
    workloads(): Promise<WorkloadSummary[]>;
    events(): Promise<KubeEvent[]>;
    podLogs(pod: string, tail?: number, container?: string): Promise<string>;
    /** Client-side validation + server dry run. Nothing is applied. */
    applyPreview(manifest: string): Promise<{
        ok: boolean;
        diff: string;
    }>;
    apply(manifest: string): Promise<string>;
    scale(kind: 'deployment' | 'statefulset', name: string, replicas: number): Promise<string>;
    rolloutRestart(kind: 'deployment' | 'statefulset' | 'daemonset', name: string): Promise<string>;
    rolloutStatus(kind: string, name: string): Promise<string>;
    /**
     * Rollback is only offered for workloads whose controller supports
     * `rollout undo`. It cannot reverse database or external-state changes.
     */
    rollback(kind: 'deployment', name: string): Promise<string>;
}
//# sourceMappingURL=kubectl-client.d.ts.map