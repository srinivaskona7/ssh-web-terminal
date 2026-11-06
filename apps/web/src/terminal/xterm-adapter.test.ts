import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  // jsdom has no ResizeObserver; the adapter observes its container on mount.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  );
});

let webglShouldFail = false;
let lastContextLoss: (() => void) | null = null;

class FakeTerminal {
  options: Record<string, unknown> = {};
  unicode = { activeVersion: '' };
  disposed = false;
  loaded: unknown[] = [];
  keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  constructor(_opts?: unknown) {}
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }
  loadAddon(addon: unknown): void {
    if (webglShouldFail && addon instanceof WebglAddon) throw new Error('webgl unavailable');
    this.loaded.push(addon);
  }
  open(): void {}
  focus(): void {}
  dispose(): void {
    this.disposed = true;
  }
  onData(): { dispose: () => void } {
    return { dispose: () => {} };
  }
  onResize(): { dispose: () => void } {
    return { dispose: () => {} };
  }
}

class WebglAddon {
  onContextLoss(cb: () => void): void {
    lastContextLoss = cb;
  }
  dispose(): void {
    lastContextLoss = null;
  }
}
class CanvasAddon {}
class FitAddon {
  fit(): void {}
}
class SearchAddon {
  findPrevious(): boolean {
    return true;
  }
  findNext(): boolean {
    return false;
  }
}
class WebLinksAddon {}
class Unicode11Addon {}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon }));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon }));

const { XtermPaneAdapter } = await import('./xterm-adapter');

function options(onRendererChange?: (mode: string) => void) {
  return {
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 1.2,
    cursorStyle: 'block' as const,
    cursorBlink: true,
    scrollback: 1000,
    theme: {},
    onRendererChange
  };
}

const container = () => ({ clientWidth: 800, clientHeight: 600 }) as unknown as HTMLElement;

afterEach(() => {
  webglShouldFail = false;
  lastContextLoss = null;
});

describe('XtermPaneAdapter renderer selection', () => {
  it('falls back to canvas when the WebGL addon cannot load', async () => {
    webglShouldFail = true;
    const modes: string[] = [];
    const adapter = new XtermPaneAdapter(options((m) => modes.push(m)));
    const mode = await adapter.mount(container(), 'auto');

    expect(mode).toBe('canvas');
    expect(adapter.rendererMode).toBe('canvas');
    expect(modes).toEqual(['canvas']);
  });

  it('mounts a real fallback and reports it after a WebGL context loss', async () => {
    const modes: string[] = [];
    const adapter = new XtermPaneAdapter(options((m) => modes.push(m)));
    const mode = await adapter.mount(container(), 'auto');
    expect(mode).toBe('webgl');
    expect(lastContextLoss).toBeTypeOf('function');

    lastContextLoss?.();
    await vi.waitFor(() => expect(adapter.rendererMode).toBe('canvas'));

    expect(modes.at(-1)).toBe('canvas');
  });
});

describe('XtermPaneAdapter search and focus delegation', () => {
  it('delegates both search directions with the caller options', async () => {
    const adapter = new XtermPaneAdapter(options());
    await adapter.mount(container(), 'auto');

    const search = adapter['searchAddon'] as unknown as {
      findNext: ReturnType<typeof vi.fn>;
      findPrevious: ReturnType<typeof vi.fn>;
    };
    search.findNext = vi.fn(() => false);
    search.findPrevious = vi.fn(() => true);

    expect(adapter.findNext('error', true, true)).toBe(false);
    expect(search.findNext).toHaveBeenCalledWith('error', { regex: true, caseSensitive: true });
    expect(adapter.findPrevious('error')).toBe(true);
    expect(search.findPrevious).toHaveBeenCalledWith('error', {
      regex: false,
      caseSensitive: false
    });
  });

  it('focuses the emulator so Esc can hand typing back to the shell', async () => {
    const adapter = new XtermPaneAdapter(options());
    await adapter.mount(container(), 'auto');
    const terminal = adapter['terminal'] as unknown as { focus: ReturnType<typeof vi.fn> };
    terminal.focus = vi.fn();
    adapter.focus();
    expect(terminal.focus).toHaveBeenCalledOnce();
  });
});

describe('XtermPaneAdapter leaves app shortcuts alone', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('declines Ctrl/Cmd+F and Ctrl/Cmd+K so the app handlers receive them', () => {
    const adapter = new XtermPaneAdapter(options());
    const handler = (adapter['terminal'] as unknown as FakeTerminal).keyHandler;
    expect(handler).toBeTypeOf('function');

    // Ctrl+letter is exactly what xterm would otherwise consume and
    // stopPropagation(), typing \x06 into the remote shell.
    expect(handler!(key({ key: 'f', ctrlKey: true }))).toBe(false);
    expect(handler!(key({ key: 'F', ctrlKey: true }))).toBe(false);
    expect(handler!(key({ key: 'k', metaKey: true }))).toBe(false);
  });

  it('keeps Ctrl+Shift+F (full-screen) and plain typing inside the emulator', () => {
    const adapter = new XtermPaneAdapter(options());
    const handler = (adapter['terminal'] as unknown as FakeTerminal).keyHandler!;

    expect(handler(key({ key: 'f', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(handler(key({ key: 'f' }))).toBe(true);
    expect(handler(key({ key: 'f', ctrlKey: true, altKey: true }))).toBe(true);
  });
});
