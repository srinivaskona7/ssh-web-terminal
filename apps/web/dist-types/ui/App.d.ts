import type { JSX } from 'preact';
export type ScreenId = 'workspace' | 'features' | 'welcome' | 'vault' | 'hosts' | 'files' | 'editor' | 'snippets' | 'settings';
export type ConnectionState = 'disconnected' | 'connected' | 'reconnecting' | 'offline' | 'resumed';
export type AuthMethod = 'Argon2id Ed25519 Key' | 'Password';
export type MenuId = 'terminal' | 'edit' | 'view' | 'security' | 'features' | null;
export interface SessionTabItem {
    id: string;
    title: string;
    connected: boolean;
}
export interface FeatureCatalogItem {
    id: number;
    category: 'Connection' | 'Terminal' | 'Files' | 'Customization' | 'Security' | 'Productivity';
    title: string;
    description: string;
    targetScreen: ScreenId;
    actionLabel: string;
}
export declare const FIFTY_FEATURES_CATALOG: readonly FeatureCatalogItem[];
export declare function App(): JSX.Element;
//# sourceMappingURL=App.d.ts.map