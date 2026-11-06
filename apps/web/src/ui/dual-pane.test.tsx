// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { App } from './App';

/**
 * The local pane is backed by the File System Access API, which the native
 * browser picker cannot be driven through in Playwright. These tests stub the
 * API so the listing path is exercised, and prove the honest fallback when the
 * API does not exist at all.
 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

const fakeDirectory = () => {
  const dir = { kind: 'directory', name: 'proj' };
  const file = {
    kind: 'file',
    name: 'notes.txt',
    getFile: async () => ({ size: 12, name: 'notes.txt', arrayBuffer: async () => new ArrayBuffer(12) })
  };
  return {
    name: 'proj',
    kind: 'directory' as const,
    async *values() {
      yield dir;
      yield file;
    }
  };
};

const mountFiles = async (container: HTMLElement): Promise<void> => {
  render(<App />, container);
  (container.querySelector('[data-testid="nav-files"]') as HTMLButtonElement).click();
  await settle();
};

describe('Dual-pane SFTP local folder', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  it('says the API is missing instead of rendering a fake local listing', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    await mountFiles(container);

    const pane = container.querySelector('[data-testid="sftp-local-pane"]');
    expect(container.querySelector('[data-testid="sftp-dual-pane"]')).toBeTruthy();
    expect(pane?.textContent).toContain('no File System Access API');
    const pick = container.querySelector('[data-testid="sftp-pick-local-dir"]') as HTMLButtonElement;
    expect(pick.disabled).toBe(true);
    expect(container.querySelector('[data-testid^="sftp-local-row-"]')).toBeNull();

    document.body.removeChild(container);
  });

  it('lists the chosen folder from the File System Access API', async () => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = vi.fn(async () =>
      fakeDirectory()
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    await mountFiles(container);

    const pick = container.querySelector('[data-testid="sftp-pick-local-dir"]') as HTMLButtonElement;
    expect(pick.disabled).toBe(false);
    pick.click();
    await settle();
    await settle();

    expect(container.querySelector('[data-testid="sftp-local-row-proj"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="sftp-local-row-notes.txt"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="sftp-local-status"]')?.textContent).toContain(
      '2 local entries in proj'
    );
    expect(container.querySelector('[data-testid="sftp-clear-local-dir"]')).toBeTruthy();

    document.body.removeChild(container);
  });
});
