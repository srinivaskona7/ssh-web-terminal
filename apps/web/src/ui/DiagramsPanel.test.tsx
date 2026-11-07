// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { DiagramsPanel } from './DiagramsPanel';
import type { ModuleContext } from './ServerModules';

const disconnected: ModuleContext = { session: null, capabilities: null, onDiscover: async () => null, discoveryBusy: false, discoveryError: null };

describe('DiagramsPanel', () => {
  it('shows disconnected state', () => {
    const container = document.createElement('div');
    render(<DiagramsPanel ctx={disconnected} />, container);
    expect(container.querySelector('[data-testid="screen-diagrams"]')).toBeNull();
  });
});
