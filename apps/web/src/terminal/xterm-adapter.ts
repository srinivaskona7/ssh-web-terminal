import { Terminal, type ITheme } from '@xterm/xterm';
// xterm's own stylesheet: without it the helper textarea renders as a visible
// white box over the terminal and the selection/scroll layers are unpositioned.
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SerializeAddon } from '@xterm/addon-serialize';

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

export class XtermPaneAdapter {
  public readonly terminal: Terminal;
  public readonly fitAddon: FitAddon;
  public readonly searchAddon: SearchAddon;
  public readonly serializeAddon: SerializeAddon;
  private activeRenderer: TerminalRendererMode = 'dom';
  private resizeObserver: ResizeObserver | null = null;
  private readonly onRendererChange?: (mode: TerminalRendererMode) => void;

  constructor(options: XtermAdapterOptions) {
    this.onRendererChange = options.onRendererChange;
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
    this.serializeAddon = new SerializeAddon();
    const webLinksAddon = new WebLinksAddon();
    const unicode11Addon = new Unicode11Addon();

    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(this.serializeAddon);
    this.terminal.loadAddon(webLinksAddon);
    this.terminal.loadAddon(unicode11Addon);
    this.terminal.unicode.activeVersion = '11';

    // Ctrl/Cmd+F and Ctrl/Cmd+K belong to the app (find bar, command palette).
    // xterm's keydown handler calls stopPropagation() for Ctrl+letter on
    // Windows/Linux, so a document listener never sees them and the control
    // byte is typed into the remote shell instead. Returning false leaves the
    // event to bubble untouched.
    this.terminal.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'f' || key === 'k') return false;
      }
      return true;
    });

    if (options.onData) {
      this.terminal.onData(options.onData);
    }
    if (options.onResize) {
      this.terminal.onResize(({ cols, rows }) => options.onResize?.(cols, rows));
    }
  }

  get rendererMode(): TerminalRendererMode {
    return this.activeRenderer;
  }

  async mount(container: HTMLElement, preferred: 'auto' | TerminalRendererMode = 'auto'): Promise<TerminalRendererMode> {
    this.terminal.open(container);

    if (preferred === 'auto' || preferred === 'webgl') {
      try {
        const { WebglAddon } = await import('@xterm/addon-webgl');
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          // Context loss is expected on GPU resets and tab suspension. Drop the
          // dead renderer and mount a real fallback rather than relabelling.
          try {
            webgl.dispose();
          } catch {
            // Already gone.
          }
          void this.tryCanvasFallback().then(() => {
            if (this.activeRenderer !== 'canvas') this.activeRenderer = 'dom';
            this.onRendererChange?.(this.activeRenderer);
          });
        });
        this.terminal.loadAddon(webgl);
        this.activeRenderer = 'webgl';
      } catch {
        await this.tryCanvasFallback();
      }
    } else if (preferred === 'canvas') {
      await this.tryCanvasFallback();
    } else {
      this.activeRenderer = 'dom';
    }

    try {
      this.fitAddon.fit();
    } catch {
      // Ignore fit error when container has 0 dimensions in headless tests
    }

    this.resizeObserver = new ResizeObserver(() => {
      try {
        this.fitAddon.fit();
      } catch {
        // Ignore fit error when detached
      }
    });
    this.resizeObserver.observe(container);

    this.onRendererChange?.(this.activeRenderer);
    return this.activeRenderer;
  }

  private async tryCanvasFallback(): Promise<void> {
    try {
      const { CanvasAddon } = await import('@xterm/addon-canvas');
      this.terminal.loadAddon(new CanvasAddon());
      this.activeRenderer = 'canvas';
    } catch {
      this.activeRenderer = 'dom';
    }
  }

  private pendingBytes: Uint8Array[] = [];
  private flushId: number | null = null;

  writeBytes(data: Uint8Array): void {
    this.pendingBytes.push(data);
    if (this.flushId === null) {
      this.flushId = requestAnimationFrame(() => {
        this.flushId = null;
        const chunks = this.pendingBytes;
        this.pendingBytes = [];
        for (const c of chunks) this.terminal.write(c);
      });
    }
  }

  writeText(text: string): void {
    this.terminal.write(text);
  }

  /**
   * The visible buffer as plain text. The WebGL and canvas renderers draw no
   * text into the DOM, so browser tests (and support diagnostics) read the
   * emulator buffer rather than the viewport's textContent.
   */
  readScreenText(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i += 1) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  }

  exportTranscript(): string {
    return this.serializeAddon.serialize({ scrollback: 1000 });
  }

  findNext(term: string, regex = false, caseSensitive = false): boolean {
    return this.searchAddon.findNext(term, { regex, caseSensitive });
  }

  focus(): void {
    this.terminal.focus();
  }

  findPrevious(term: string, regex = false, caseSensitive = false): boolean {
    return this.searchAddon.findPrevious(term, { regex, caseSensitive });
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.terminal.dispose();
  }
}
