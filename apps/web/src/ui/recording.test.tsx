// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { App } from './App';

/**
 * The recording UI is wiring, not transport: it must never offer to record a
 * session that is not connected, and it must say plainly that nothing has been
 * captured yet instead of showing a sample as if it were the user's own.
 */
describe('Session recording UI', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('refuses to record while disconnected and shows an empty recording state', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<App />, container);

    (container.querySelector('[data-testid="nav-terminal"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 150));

    const recordBtn = container.querySelector('[data-testid="toggle-recording-btn"]') as HTMLButtonElement;
    expect(recordBtn).toBeTruthy();
    expect(recordBtn.disabled).toBe(true);

    (container.querySelector('[data-testid="nav-snippets"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 150));

    const panel = container.querySelector('[data-testid="screen-snippets"]');
    expect(panel?.textContent).toContain('No recording yet');
    expect(container.querySelector('[data-testid="download-recording-btn"]')).toBeNull();
    // The demo card stays honestly labelled as a sample, never as the user's.
    expect(panel?.textContent).toContain('Sample recording — not output from your server.');

    document.body.removeChild(container);
  });
});
