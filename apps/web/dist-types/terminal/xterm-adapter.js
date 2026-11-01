import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
export class XtermPaneAdapter {
    terminal;
    fitAddon;
    searchAddon;
    activeRenderer = 'dom';
    resizeObserver = null;
    constructor(options) {
        this.terminal = new Terminal({
            fontFamily: options.fontFamily,
            fontSize: options.fontSize,
            lineHeight: options.lineHeight,
            cursorStyle: options.cursorStyle,
            cursorBlink: options.cursorBlink,
            scrollback: options.scrollback,
            allowProposedApi: true,
            theme: options.theme
        });
        this.fitAddon = new FitAddon();
        this.searchAddon = new SearchAddon();
        const webLinksAddon = new WebLinksAddon();
        const unicode11Addon = new Unicode11Addon();
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(this.searchAddon);
        this.terminal.loadAddon(webLinksAddon);
        this.terminal.loadAddon(unicode11Addon);
        this.terminal.unicode.activeVersion = '11';
        if (options.onData) {
            this.terminal.onData(options.onData);
        }
        if (options.onResize) {
            this.terminal.onResize(({ cols, rows }) => options.onResize?.(cols, rows));
        }
    }
    get rendererMode() {
        return this.activeRenderer;
    }
    async mount(container, preferred = 'auto') {
        this.terminal.open(container);
        if (preferred === 'auto' || preferred === 'webgl') {
            try {
                const { WebglAddon } = await import('@xterm/addon-webgl');
                const webgl = new WebglAddon();
                webgl.onContextLoss(() => {
                    webgl.dispose();
                    this.activeRenderer = 'canvas';
                });
                this.terminal.loadAddon(webgl);
                this.activeRenderer = 'webgl';
            }
            catch {
                await this.tryCanvasFallback();
            }
        }
        else if (preferred === 'canvas') {
            await this.tryCanvasFallback();
        }
        else {
            this.activeRenderer = 'dom';
        }
        try {
            this.fitAddon.fit();
        }
        catch {
            // Ignore fit error when container has 0 dimensions in headless tests
        }
        this.resizeObserver = new ResizeObserver(() => {
            try {
                this.fitAddon.fit();
            }
            catch {
                // Ignore fit error when detached
            }
        });
        this.resizeObserver.observe(container);
        return this.activeRenderer;
    }
    async tryCanvasFallback() {
        try {
            const { CanvasAddon } = await import('@xterm/addon-canvas');
            this.terminal.loadAddon(new CanvasAddon());
            this.activeRenderer = 'canvas';
        }
        catch {
            this.activeRenderer = 'dom';
        }
    }
    writeBytes(data) {
        this.terminal.write(data);
    }
    writeText(text) {
        this.terminal.write(text);
    }
    findNext(term, regex = false, caseSensitive = false) {
        return this.searchAddon.findNext(term, { regex, caseSensitive });
    }
    dispose() {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.terminal.dispose();
    }
}
//# sourceMappingURL=xterm-adapter.js.map