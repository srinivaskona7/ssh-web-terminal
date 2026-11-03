import type { RemoteSession } from '../session/remote-session.js';
/**
 * Docker-compatible container workflows over the SSH session.
 *
 * The daemon socket is never exposed over the network: every call is a CLI
 * invocation executed as the SSH user, subject to that user's own Docker
 * permissions. Privileged/host-namespace operations are surfaced, not hidden.
 */
export interface ContainerSummary {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    ports: string;
    createdAt: string;
    composeProject?: string;
    composeService?: string;
}
export interface ImageSummary {
    id: string;
    repository: string;
    tag: string;
    size: string;
    createdAt: string;
}
export interface VolumeSummary {
    name: string;
    driver: string;
    mountpoint: string;
    scope: string;
}
export interface NetworkSummary {
    id: string;
    name: string;
    driver: string;
    scope: string;
}
/** Docker's `--format '{{json .}}'` prints one JSON object per line. */
export declare function parseJsonLines<T>(text: string): T[];
export declare class DockerClient {
    private readonly session;
    constructor(session: RemoteSession);
    available(): Promise<{
        ok: boolean;
        detail: string;
    }>;
    listContainers(all?: boolean): Promise<ContainerSummary[]>;
    images(): Promise<ImageSummary[]>;
    volumes(): Promise<VolumeSummary[]>;
    networks(): Promise<NetworkSummary[]>;
    inspect(id: string): Promise<unknown>;
    logs(id: string, tail?: number): Promise<string>;
    start(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    restart(id: string): Promise<void>;
    private action;
    /** Validate a Compose file without changing anything. */
    validateCompose(filePath: string): Promise<{
        ok: boolean;
        detail: string;
    }>;
    composeUp(filePath: string): Promise<string>;
}
//# sourceMappingURL=docker-client.d.ts.map