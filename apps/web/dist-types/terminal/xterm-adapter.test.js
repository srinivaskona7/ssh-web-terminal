import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
beforeAll(() => {
    // jsdom has no ResizeObserver; the adapter observes its container on mount.
    vi.stubGlobal('ResizeObserver', class {
        observe() { }
        disconnect() { }
    });
});
let webglShouldFail = false;
let lastContextLoss = null;
class FakeTerminal {
    options = {};
    unicode = { activeVersion: '' };
    disposed = false;
    loaded = [];
    constructor(_opts) { }
    loadAddon(addon) {
        if (webglShouldFail && addon instanceof WebglAddon)
            throw new Error('webgl unavailable');
        this.loaded.push(addon);
    }
    open() { }
    dispose() {
        this.disposed = true;
    }
    onData() {
        return { dispose: () => { } };
    }
    onResize() {
        return { dispose: () => { } };
    }
}
class WebglAddon {
    onContextLoss(cb) {
        lastContextLoss = cb;
    }
    dispose() {
        lastContextLoss = null;
    }
}
class CanvasAddon {
}
class FitAddon {
    fit() { }
}
class SearchAddon {
    findNext() {
        return false;
    }
}
class WebLinksAddon {
}
class Unicode11Addon {
}
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon }));
const { XtermPaneAdapter } = await import('./xterm-adapter');
function options(onRendererChange) {
    return {
        fontFamily: 'monospace',
        fontSize: 14,
        lineHeight: 1.2,
        cursorStyle: 'block',
        cursorBlink: true,
        scrollback: 1000,
        theme: {},
        onRendererChange
    };
}
const container = () => ({ clientWidth: 800, clientHeight: 600 });
afterEach(() => {
    webglShouldFail = false;
    lastContextLoss = null;
});
describe('XtermPaneAdapter renderer selection', () => {
    it('falls back to canvas when the WebGL addon cannot load', async () => {
        webglShouldFail = true;
        const modes = [];
        const adapter = new XtermPaneAdapter(options((m) => modes.push(m)));
        const mode = await adapter.mount(container(), 'auto');
        expect(mode).toBe('canvas');
        expect(adapter.rendererMode).toBe('canvas');
        expect(modes).toEqual(['canvas']);
    });
    it('mounts a real fallback and reports it after a WebGL context loss', async () => {
        const modes = [];
        const adapter = new XtermPaneAdapter(options((m) => modes.push(m)));
        const mode = await adapter.mount(container(), 'auto');
        expect(mode).toBe('webgl');
        expect(lastContextLoss).toBeTypeOf('function');
        lastContextLoss?.();
        await vi.waitFor(() => expect(adapter.rendererMode).toBe('canvas'));
        expect(modes.at(-1)).toBe('canvas');
    });
});
//# sourceMappingURL=xterm-adapter.test.js.map