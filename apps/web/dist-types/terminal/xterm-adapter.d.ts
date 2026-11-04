import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
export type TerminalRendererMode = 'webgl' | 'canvas' | 'dom';
export interface XtermAdapterOptions {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    cursorStyle: 'block' | 'underline' | 'bar';
    cursorBlink: boolean;
    scrollback: number;
    theme: ITheme;
    preferredRenderer?: 'auto' | TerminalRendererMode;
    onData?: (data: string) => void;
    onResize?: (cols: number, rows: number) => void;
    /** Reports the renderer actually in use, including after a context loss. */
    onRendererChange?: (mode: TerminalRendererMode) => void;
}
export declare class XtermPaneAdapter {
    readonly terminal: Terminal;
    readonly fitAddon: FitAddon;
    readonly searchAddon: SearchAddon;
    private activeRenderer;
    private resizeObserver;
    private readonly onRendererChange?;
    constructor(options: XtermAdapterOptions);
    get rendererMode(): TerminalRendererMode;
    mount(container: HTMLElement, preferred?: 'auto' | TerminalRendererMode): Promise<TerminalRendererMode>;
    private tryCanvasFallback;
    writeBytes(data: Uint8Array): void;
    writeText(text: string): void;
    findNext(term: string, regex?: boolean, caseSensitive?: boolean): boolean;
    dispose(): void;
}
//# sourceMappingURL=xterm-adapter.d.ts.map