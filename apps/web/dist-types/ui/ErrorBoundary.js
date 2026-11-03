import { jsx as _jsx, jsxs as _jsxs } from "preact/jsx-runtime";
import { Component } from 'preact';
import { Badge, Button, Card } from '@webssh/ui-kit';
import { redactSecretsInText } from './advanced-features';
/**
 * Sanitizes any error or diagnostic string to ensure private keys, tokens,
 * passwords, query parameters, and terminal buffer contents are never included.
 */
export function sanitizeDiagnosticMessage(raw) {
    const text = raw instanceof Error
        ? `${raw.name}: ${raw.message}`
        : typeof raw === 'string'
            ? raw
            : 'Unexpected application error';
    const singleLine = text.replace(/\s+/g, ' ').trim().slice(0, 280);
    const redacted = redactSecretsInText(singleLine, true);
    return redacted
        .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*/gi, '[REDACTED_KEY]')
        .replace(/(?:password|passphrase|secret|token|authorization)\s*[:=]\s*\S+/gi, '[REDACTED_CREDENTIAL]');
}
export function buildSafeDiagnosticReport(reason) {
    const buildVersion = (typeof window !== 'undefined' &&
        (window.__WEBSSH_BUILD__ || window.__WEBSSH_BUILD_VERSION__)) ||
        '1.0.0';
    let localStorageAvailable = false;
    try {
        localStorageAvailable = typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function';
    }
    catch {
        localStorageAvailable = false;
    }
    let indexedDbAvailable = false;
    try {
        indexedDbAvailable = typeof indexedDB !== 'undefined' && indexedDB !== null;
    }
    catch {
        indexedDbAvailable = false;
    }
    return {
        buildVersion,
        timestamp: new Date().toISOString(),
        pathname: typeof window !== 'undefined' ? window.location.pathname : '/',
        online: typeof navigator !== 'undefined' ? Boolean(navigator.onLine) : true,
        serviceWorkerControlled: typeof navigator !== 'undefined' && 'serviceWorker' in navigator
            ? Boolean(navigator.serviceWorker.controller)
            : false,
        reason: sanitizeDiagnosticMessage(reason),
        storageStatus: {
            localStorageAvailable,
            indexedDbAvailable
        }
    };
}
/**
 * Clears only Service Worker registrations and HTTP CacheStorage entries (`webssh-studio-shell*`),
 * strictly preserving `localStorage` (saved hosts, preferences) and `IndexedDB` (KeyVault keys & known_hosts).
 */
export async function repairApplicationAssetCaches() {
    let unregisteredServiceWorkers = 0;
    const deletedCaches = [];
    try {
        if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (const reg of registrations) {
                if (reg.active) {
                    reg.active.postMessage({ type: 'CLEAR_ASSET_CACHE' });
                }
                const ok = await reg.unregister();
                if (ok)
                    unregisteredServiceWorkers++;
            }
        }
    }
    catch {
        // Ignore SW unregister errors in restricted contexts
    }
    try {
        if (typeof window !== 'undefined' && 'caches' in window) {
            const keys = await window.caches.keys();
            for (const key of keys) {
                if (key.startsWith('webssh-studio-shell')) {
                    const deleted = await window.caches.delete(key);
                    if (deleted)
                        deletedCaches.push(key);
                }
            }
        }
    }
    catch {
        // Ignore CacheStorage errors in restricted contexts
    }
    return { unregisteredServiceWorkers, deletedCaches };
}
export class AppErrorBoundary extends Component {
    state = {
        error: null,
        copied: false,
        repairing: false
    };
    static getDerivedStateFromError(error) {
        return { error };
    }
    componentDidCatch(error) {
        this.setState({ error });
        if (typeof window !== 'undefined' && typeof window.__websshMarkReady === 'function') {
            window.__websshMarkReady();
        }
    }
    handleRetryRender = () => {
        this.setState({ error: null, copied: false });
    };
    handleRepairCachesAndReload = async () => {
        this.setState({ repairing: true });
        await repairApplicationAssetCaches();
        if (typeof window !== 'undefined') {
            const nextUrl = new URL(window.location.href);
            nextUrl.searchParams.set('repaired', String(Date.now()));
            window.location.replace(nextUrl.toString());
        }
    };
    handleCopyDiagnostics = () => {
        const report = buildSafeDiagnosticReport(this.state.error);
        const json = JSON.stringify(report, null, 2);
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            void navigator.clipboard.writeText(json).catch(() => undefined);
        }
        this.setState({ copied: true });
    };
    render() {
        if (!this.state.error) {
            return this.props.children;
        }
        const report = buildSafeDiagnosticReport(this.state.error);
        const diagnosticJson = JSON.stringify(report, null, 2);
        return (_jsx("div", { className: "webssh-app", "data-testid": "error-boundary-fallback", children: _jsx("div", { className: "webssh-panel-content", children: _jsxs(Card, { danger: true, testId: "error-boundary-card", children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }, children: [_jsx("h1", { style: { margin: 0 }, children: "WebSSH Studio encountered a rendering error" }), _jsxs(Badge, { tone: "danger", testId: "error-boundary-version", children: ["Build ", report.buildVersion] })] }), _jsxs("p", { "data-testid": "error-boundary-reason", children: [report.reason, ". Your saved SSH hosts, non-extractable Vault keys, and user preferences are intact."] }), _jsxs("div", { style: { display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-3)' }, children: [_jsx(Button, { variant: "primary", onClick: this.handleRetryRender, testId: "error-boundary-retry-btn", children: "Retry Render" }), _jsx(Button, { variant: "default", disabled: this.state.repairing, onClick: () => void this.handleRepairCachesAndReload(), testId: "error-boundary-repair-cache-btn", children: this.state.repairing ? 'Repairing Asset Cache…' : 'Repair Asset Cache & Reload' }), _jsx(Button, { variant: "ghost", onClick: this.handleCopyDiagnostics, testId: "error-boundary-copy-diag-btn", children: this.state.copied ? 'Copied Diagnostics' : 'Copy Safe Diagnostics' })] }), _jsx("pre", { "data-testid": "error-boundary-diagnostics", style: {
                                marginTop: 'var(--space-3)',
                                padding: 'var(--space-2)',
                                overflowX: 'auto',
                                backgroundColor: 'var(--color-bg-canvas)',
                                borderRadius: 'var(--radius-sm)',
                                fontSize: 'var(--font-size-xs)'
                            }, children: diagnosticJson })] }) }) }));
    }
}
//# sourceMappingURL=ErrorBoundary.js.map