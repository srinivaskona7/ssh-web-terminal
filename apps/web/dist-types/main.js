import { jsx as _jsx } from "preact/jsx-runtime";
import { render } from 'preact';
import '@webssh/ui-kit/tokens.css';
import '@webssh/ui-kit/ui-kit.css';
import './ui/app.css';
import { App } from './ui/App';
import { AppErrorBoundary } from './ui/ErrorBoundary';
function isServiceWorkerSupportedContext() {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
        return false;
    }
    return (window.location.protocol === 'https:' ||
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1');
}
if (isServiceWorkerSupportedContext()) {
    window.addEventListener('load', () => {
        void navigator.serviceWorker
            .register('./sw.js', { updateViaCache: 'none' })
            .then((reg) => {
            // Check for updated service worker without forcing a page reload on active sessions
            void reg.update().catch(() => undefined);
        })
            .catch(() => {
            // Offline SW registration optional in restricted contexts
        });
    });
}
const root = document.getElementById('app');
if (root) {
    try {
        render(_jsx(AppErrorBoundary, { children: _jsx(App, {}) }), root);
        if (typeof window !== 'undefined' && typeof window.__websshMarkReady === 'function') {
            window.__websshMarkReady();
        }
    }
    catch (err) {
        if (typeof window !== 'undefined' && typeof window.__websshReportStartupError === 'function') {
            window.__websshReportStartupError(err instanceof Error ? err.message : String(err));
        }
    }
}
//# sourceMappingURL=main.js.map