import { Component, type ComponentChildren } from 'preact';
declare global {
    interface Window {
        __WEBSSH_BUILD_VERSION__?: string;
        __websshMarkReady?: () => void;
        __websshReportStartupError?: (reason: string) => void;
        __websshRepairAssetCacheAndReload?: () => Promise<void>;
    }
}
export interface DiagnosticReport {
    buildVersion: string;
    timestamp: string;
    pathname: string;
    online: boolean;
    serviceWorkerControlled: boolean;
    reason: string;
    storageStatus: {
        localStorageAvailable: boolean;
        indexedDbAvailable: boolean;
    };
}
/**
 * Sanitizes any error or diagnostic string to ensure private keys, tokens,
 * passwords, query parameters, and terminal buffer contents are never included.
 */
export declare function sanitizeDiagnosticMessage(raw: unknown): string;
export declare function buildSafeDiagnosticReport(reason: unknown): DiagnosticReport;
/**
 * Clears only Service Worker registrations and HTTP CacheStorage entries (`webssh-studio-shell*`),
 * strictly preserving `localStorage` (saved hosts, preferences) and `IndexedDB` (KeyVault keys & known_hosts).
 */
export declare function repairApplicationAssetCaches(): Promise<{
    unregisteredServiceWorkers: number;
    deletedCaches: string[];
}>;
interface AppErrorBoundaryProps {
    children: ComponentChildren;
}
interface AppErrorBoundaryState {
    error: Error | null;
    copied: boolean;
    repairing: boolean;
}
export declare class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
    state: AppErrorBoundaryState;
    static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState>;
    componentDidCatch(error: Error): void;
    private handleRetryRender;
    private handleRepairCachesAndReload;
    private handleCopyDiagnostics;
    render(): ComponentChildren;
}
export {};
//# sourceMappingURL=ErrorBoundary.d.ts.map