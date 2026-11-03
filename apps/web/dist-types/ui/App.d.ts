import type { JSX } from 'preact';
export type ScreenId = 'workspace' | 'features' | 'tunnels' | 'welcome' | 'vault' | 'hosts' | 'files' | 'editor' | 'snippets' | 'settings' | 'overview' | 'software' | 'containers' | 'kubernetes' | 'automations' | 'deployments' | 'activity';
export type ConnectionState = 'disconnected' | 'connected' | 'reconnecting' | 'offline' | 'resumed';
export type AuthMethod = 'Password' | 'Private Key (.pem / id_rsa)' | 'Argon2id Ed25519 Key';
export type KeyPermissionMode = '0400' | '0600' | '0644';
export type MenuId = 'terminal' | 'edit' | 'view' | 'security' | 'features' | 'more' | null;
export interface SessionTabItem {
    id: string;
    title: string;
    connected: boolean;
    channelId?: number;
}
export declare function App(): JSX.Element;
//# sourceMappingURL=App.d.ts.map