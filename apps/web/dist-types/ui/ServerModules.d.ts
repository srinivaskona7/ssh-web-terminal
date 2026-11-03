/**
 * Workspace module screens: server overview, software catalog, containers,
 * Kubernetes, automations and durable job activity.
 *
 * Every panel reads real data through the shared `RemoteSession` contract. No
 * metrics are invented: when a probe fails the panel says so and explains what
 * must be installed or granted.
 */
import type { JSX } from 'preact';
import { type ServerCapabilities } from '../discovery/capabilities.js';
import type { WorkspaceRemoteSession } from '../session/adapters.js';
export interface ModuleContext {
    session: WorkspaceRemoteSession | null;
    capabilities: ServerCapabilities | null;
    onDiscover: () => Promise<ServerCapabilities | null>;
    discoveryBusy: boolean;
    discoveryError: string | null;
}
export declare function OverviewPanel({ ctx }: {
    ctx: ModuleContext;
}): JSX.Element;
export declare function SoftwarePanel({ ctx }: {
    ctx: ModuleContext;
}): JSX.Element;
export declare function ContainersPanel({ ctx }: {
    ctx: ModuleContext;
}): JSX.Element;
export declare function KubernetesPanel({ ctx }: {
    ctx: ModuleContext;
}): JSX.Element;
export declare function AutomationsPanel({ ctx }: {
    ctx: ModuleContext;
}): JSX.Element;
export declare function ActivityPanel({ ctx }: {
    ctx: ModuleContext;
}): JSX.Element;
export declare function DeploymentsPanel({ ctx }: {
    ctx: ModuleContext;
}): JSX.Element;
export declare function runDiscovery(session: WorkspaceRemoteSession): Promise<ServerCapabilities>;
//# sourceMappingURL=ServerModules.d.ts.map