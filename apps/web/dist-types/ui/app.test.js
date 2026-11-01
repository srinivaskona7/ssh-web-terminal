import { jsx as _jsx } from "preact/jsx-runtime";
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from 'preact';
import { App } from './App';
describe('App UI Shell Integration Suite (M4-M8)', () => {
    it('renders workspace, switches themes, opens Command Palette, imports ~/.ssh/config, and toggles full screen + hover overlay', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(_jsx(App, {}), container);
        const workspaceRoot = container.querySelector('[data-testid="workspace-root"]');
        expect(workspaceRoot).toBeTruthy();
        const termViewport = container.querySelector('[data-testid="terminal-viewport"]');
        expect(termViewport?.textContent).toContain('Connected to edge-01.prod.internal');
        // Toggle immersive full-screen mode (uses 100dvh pseudo-fullscreen fallback in jsdom)
        const fsBtn = container.querySelector('[data-testid="toggle-fullscreen-btn"]');
        fsBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        const toast = container.querySelector('[data-testid="fullscreen-toast"]');
        expect(toast?.textContent).toContain('Press F11 or Esc to exit');
        // Hover top zone to reveal auto-hiding overlay bar
        const hoverZone = container.querySelector('[data-testid="fullscreen-top-hover-zone"]');
        expect(hoverZone).toBeTruthy();
        hoverZone.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
        const exitBtn = container.querySelector('[data-testid="overlay-exit-fullscreen-btn"]');
        expect(exitBtn).toBeTruthy();
        exitBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        // Navigate to Hosts screen and import ~/.ssh/config
        const navHosts = container.querySelector('[data-testid="nav-hosts"]');
        navHosts.click();
        await new Promise((r) => setTimeout(r, 10));
        const importBtn = container.querySelector('[data-testid="import-ssh-config-btn"]');
        importBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        const importedHostCard = container.querySelector('[data-testid="host-card-staging-web"]');
        expect(importedHostCard?.textContent).toContain('deploy@10.10.4.12:2222');
        // Trigger red blocking KEY CHANGED modal
        const mismatchBtn = container.querySelector('[data-testid="trigger-mismatch-modal-btn"]');
        mismatchBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        const hostKeyModal = container.querySelector('[data-testid="hostkey-modal"]');
        expect(hostKeyModal?.textContent).toContain('WARNING: REMOTE HOST KEY CHANGED');
        const confirmHostKey = container.querySelector('[data-testid="hostkey-confirm-btn"]');
        confirmHostKey.click();
        await new Promise((r) => setTimeout(r, 10));
        // Open Command Palette and navigate to SFTP Files
        const openPaletteBtn = container.querySelector('[data-testid="open-palette-btn"]');
        openPaletteBtn.click();
        await new Promise((r) => setTimeout(r, 10));
        const filesCmd = container.querySelector('[data-testid="palette-cmd-nav.files"]');
        filesCmd.click();
        await new Promise((r) => setTimeout(r, 10));
        const filesScreen = container.querySelector('[data-testid="screen-files"]');
        expect(filesScreen?.textContent).toContain('Dual-Pane SFTP File Manager');
        document.body.removeChild(container);
    });
});
//# sourceMappingURL=app.test.js.map