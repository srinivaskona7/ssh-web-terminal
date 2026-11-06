import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { TerminalPane } from './TerminalPane';

function baseProps() {
  return {
    paneId: 'pane-1',
    channelId: 3,
    transport: null,
    active: true,
    label: 'Terminal 1 terminal',
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 1.45,
    cursorStyle: 'block' as const,
    cursorBlink: true,
    scrollback: 1000,
    theme: { background: '#000', foreground: '#fff', cursor: '#fff' },
    onAdapter: vi.fn()
  };
}

describe('TerminalPane', () => {
  it('renders a labelled pane host and does not mount an emulator in jsdom', () => {
    const container = document.createElement('div');
    render(<TerminalPane {...baseProps()} testId="pane-under-test" />, container);

    const host = container.querySelector('[data-testid="pane-under-test"]');
    expect(host).toBeTruthy();
    expect(host?.getAttribute('role')).toBe('group');
    expect(host?.getAttribute('aria-label')).toBe('Terminal 1 terminal');
    expect(host?.getAttribute('data-pane-id')).toBe('pane-1');
    // jsdom has no canvas; the component must not pretend to mount one.
    expect(container.querySelector('.xterm')).toBeNull();

    render(null, container);
  });

  it('accepts a transport and channel without throwing when unmounted', () => {
    const transport = {
      isConnected: true,
      sendPtyText: vi.fn(() => true),
      resizeChannel: vi.fn()
    };
    const container = document.createElement('div');
    render(<TerminalPane {...baseProps()} transport={transport} />, container);
    expect(container.querySelector('[data-testid="xterm-pane"]')?.getAttribute('data-pane-id')).toBe(
      'pane-1'
    );
    render(null, container);
  });
});

describe('sendPaneInput broadcast routing', () => {
  const makeTransport = () => ({
    isConnected: true,
    sendPtyText: vi.fn(() => true),
    resizeChannel: vi.fn()
  });

  it('sends only to the pane channel when broadcast is off', async () => {
    const { sendPaneInput } = await import('./TerminalPane');
    const transport = makeTransport();
    sendPaneInput(transport, 3, 'ls', null);
    expect(transport.sendPtyText.mock.calls).toEqual([[3, 'ls']]);
  });

  it('mirrors the same bytes to the paired channel when broadcast is on', async () => {
    const { sendPaneInput } = await import('./TerminalPane');
    const transport = makeTransport();
    sendPaneInput(transport, 3, 'a', 7);
    expect(transport.sendPtyText.mock.calls).toEqual([
      [3, 'a'],
      [7, 'a']
    ]);
  });

  it('never double-sends when the pane is paired with itself', async () => {
    const { sendPaneInput } = await import('./TerminalPane');
    const transport = makeTransport();
    sendPaneInput(transport, 3, 'x', 3);
    expect(transport.sendPtyText).toHaveBeenCalledTimes(1);
  });

  it('drops input when there is no live transport or channel', async () => {
    const { sendPaneInput } = await import('./TerminalPane');
    const transport = makeTransport();
    sendPaneInput(null, 3, 'x', 7);
    sendPaneInput({ ...transport, isConnected: false }, 3, 'x', 7);
    sendPaneInput(transport, null, 'x', 7);
    expect(transport.sendPtyText).not.toHaveBeenCalled();
  });
});
