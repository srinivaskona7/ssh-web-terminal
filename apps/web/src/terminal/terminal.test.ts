import { describe, expect, it, vi } from 'vitest';
import {
  CommandCompletionDetector,
  FullScreenController,
  WorkspaceManager,
  collectLeafPanes
} from './index.js';

describe('Terminal Workspace, Split Panes & Immersive Full-Screen (M4)', () => {
  it('manages tabs, split-pane binary trees, and broadcast input channels', () => {
    const ws = new WorkspaceManager();
    const tab = ws.createTab('prod-db-01', 'sess-1', 'prod');
    expect(ws.getTabs().length).toBe(1);

    const secondPaneId = ws.splitPane(tab.id, tab.activePaneId, 'vertical', 'prod-db-01-logs', 'sess-2');
    expect(secondPaneId).toBeTruthy();

    const activeTab = ws.getActiveTab()!;
    const leaves = collectLeafPanes(activeTab.rootPane);
    expect(leaves.length).toBe(2);

    // Single-pane input target by default
    expect(ws.resolveInputTargetChannels().length).toBe(1);

    // Broadcast input targets all leaf panes in the active tab
    ws.setBroadcastInput(true);
    expect(ws.resolveInputTargetChannels().length).toBe(2);

    // Rename & reorder tabs
    const tab2 = ws.createTab('staging-web', 'sess-3', 'staging');
    expect(ws.renameTab(tab2.id, 'staging-api')).toBe(true);
    expect(ws.reorderTabs(1, 0)).toBe(true);
    expect(ws.getTabs()[0]!.title).toBe('staging-api');

    // Close split pane
    expect(ws.closePane(tab.id, secondPaneId!)).toBe(true);
    expect(collectLeafPanes(ws.getTabs()[1]!.rootPane).length).toBe(1);
  });

  it('handles Immersive Full-Screen Mode, 300ms top-edge hover reveal, Shift+Esc exit, and 100dvh fallback', async () => {
    vi.useFakeTimers();
    try {
      const fs = new FullScreenController();

      // Enter full screen without native Fullscreen API -> activates 100dvh pseudo-fullscreen fallback + 3s toast
      const entered = await fs.enterFullScreen(null);
      expect(entered.isFullScreen).toBe(true);
      expect(entered.isPseudoFullScreenFallback).toBe(true);
      expect(entered.showEntryToast).toBe(true);
      expect(entered.isTopHoverOverlayVisible).toBe(false);

      // Hover at top edge (y=2px) for 300ms reveals auto-hiding top bar
      fs.handlePointerMove(2);
      vi.advanceTimersByTime(310);
      expect(fs.getState().isTopHoverOverlayVisible).toBe(true);

      // Moving pointer down hides top bar
      fs.handlePointerMove(120);
      expect(fs.getState().isTopHoverOverlayVisible).toBe(false);

      // After 3 seconds, entry toast auto-dismisses
      vi.advanceTimersByTime(3000);
      expect(fs.getState().showEntryToast).toBe(false);

      // Plain Escape does NOT exit full screen (reserved for vim/tmux)
      const handledPlainEsc = await fs.handleKeyDown({ key: 'Escape', shiftKey: false });
      expect(handledPlainEsc).toBe(false);
      expect(fs.getState().isFullScreen).toBe(true);

      // Shift+Escape exits full screen
      const handledShiftEsc = await fs.handleKeyDown({ key: 'Escape', shiftKey: true });
      expect(handledShiftEsc).toBe(true);
      expect(fs.getState().isFullScreen).toBe(false);

      // Zen Mode toggles chrome visibility inside normal window
      expect(fs.toggleZenMode().isZenMode).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('detects OSC 133 long-running command completion and BEL notifications', () => {
    const detector = new CommandCompletionDetector(10_000);
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);

    expect(detector.inspectPtyOutput(`${esc}]133;C${bel}`, 1_000)).toBeNull();
    const done = detector.inspectPtyOutput(`${esc}]133;D;0${bel}`, 15_500);
    expect(done).toEqual({
      exitCode: 0,
      durationMs: 14_500,
      triggeredBy: 'osc133'
    });

    const bellEvt = detector.inspectPtyOutput(`Alert!${bel}`, 20_000);
    expect(bellEvt?.triggeredBy).toBe('bell');
  });
});
