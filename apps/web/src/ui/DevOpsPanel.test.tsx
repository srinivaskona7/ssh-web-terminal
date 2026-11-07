// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { DevOpsPanel } from './DevOpsPanel';
import type { ModuleContext } from './ServerModules';

const disconnected: ModuleContext = { session: null, capabilities: null, onDiscover: async () => null, discoveryBusy: false, discoveryError: null };

describe('DevOpsPanel', () => {
  it('shows disconnected state', () => {
    const container = document.createElement('div');
    render(<DevOpsPanel ctx={disconnected} />, container);
    expect(container.querySelector('[data-testid="screen-devops"]')).toBeNull();
  });
  it('lists tools when connected', () => {
    const ctx = { session: { isConnected: () => true, exec: async () => ({ stdout: '', stderr: 'not found', exitCode: 127 }) }, capabilities: null, onDiscover: async () => null, discoveryBusy: false, discoveryError: null } as unknown as ModuleContext;
    const container = document.createElement('div');
    render(<DevOpsPanel ctx={ctx} />, container);
    expect(container.querySelector('[data-testid="devops-tool-listening-ports"]')).toBeTruthy();
  });
});
