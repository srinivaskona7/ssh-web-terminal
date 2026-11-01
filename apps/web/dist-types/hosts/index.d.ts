import type { JumpHop } from '@webssh/protocol';
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
    jumpHops: JumpHop[];
    tmuxAutoAttach?: string;
    lastConnectedAt?: number;
}
export declare class HostRegistry {
    private readonly hosts;
    private readonly storageKey;
    constructor(storageKey?: string);
    private load;
    private save;
    upsert(profile: HostProfile): HostProfile;
    remove(id: string): boolean;
    get(id: string): HostProfile | undefined;
    list(query?: string, folder?: string, tag?: string): HostProfile[];
    importSshConfig(configText: string, defaultUser?: string): HostProfile[];
}
/**
 * Parses an OpenSSH `~/.ssh/config` file into saved host profiles, resolving ProxyJump chains.
 */
export declare function parseOpenSshConfig(configText: string, defaultUser?: string): HostProfile[];
//# sourceMappingURL=index.d.ts.map