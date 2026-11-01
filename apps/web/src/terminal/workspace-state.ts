export type SplitDirection = 'horizontal' | 'vertical';

export type PaneNode =
  | {
      kind: 'leaf';
      paneId: string;
      sessionId: string;
      title: string;
      channelId: number;
    }
  | {
      kind: 'split';
      splitId: string;
      direction: SplitDirection;
      ratio: number; // 0.15 .. 0.85
      first: PaneNode;
      second: PaneNode;
    };

export interface WorkspaceTab {
  id: string;
  title: string;
  environmentTag?: 'prod' | 'staging' | 'dev';
  rootPane: PaneNode;
  activePaneId: string;
  hasUnreadActivity: boolean;
}

export class WorkspaceManager {
  private tabs: WorkspaceTab[] = [];
  private activeTabId: string | null = null;
  private broadcastEnabled = false;
  private nextChannelId = 1;

  getTabs(): WorkspaceTab[] {
    return this.tabs.map((t) => ({ ...t }));
  }

  getActiveTab(): WorkspaceTab | null {
    if (!this.activeTabId) return null;
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  }

  get isBroadcastEnabled(): boolean {
    return this.broadcastEnabled;
  }

  setBroadcastInput(enabled: boolean): void {
    this.broadcastEnabled = enabled;
  }

  createTab(title: string, sessionId: string = crypto.randomUUID(), environmentTag?: 'prod' | 'staging' | 'dev'): WorkspaceTab {
    const paneId = `pane-${crypto.randomUUID()}`;
    const tabId = `tab-${crypto.randomUUID()}`;
    const leaf: PaneNode = {
      kind: 'leaf',
      paneId,
      sessionId,
      title,
      channelId: this.nextChannelId++
    };
    const tab: WorkspaceTab = {
      id: tabId,
      title,
      environmentTag,
      rootPane: leaf,
      activePaneId: paneId,
      hasUnreadActivity: false
    };
    this.tabs.push(tab);
    this.activeTabId = tabId;
    return tab;
  }

  activateTab(tabId: string): boolean {
    const found = this.tabs.find((t) => t.id === tabId);
    if (!found) return false;
    this.activeTabId = tabId;
    found.hasUnreadActivity = false;
    return true;
  }

  renameTab(tabId: string, newTitle: string): boolean {
    const trimmed = newTitle.trim();
    if (!trimmed) return false;
    const found = this.tabs.find((t) => t.id === tabId);
    if (!found) return false;
    found.title = trimmed;
    return true;
  }

  reorderTabs(fromIndex: number, toIndex: number): boolean {
    if (
      fromIndex < 0 ||
      fromIndex >= this.tabs.length ||
      toIndex < 0 ||
      toIndex >= this.tabs.length
    ) {
      return false;
    }
    const [moved] = this.tabs.splice(fromIndex, 1);
    if (!moved) return false;
    this.tabs.splice(toIndex, 0, moved);
    return true;
  }

  closeTab(tabId: string): boolean {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return false;
    this.tabs.splice(idx, 1);
    if (this.activeTabId === tabId) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activeTabId = next ? next.id : null;
    }
    return true;
  }

  splitPane(
    tabId: string,
    targetPaneId: string,
    direction: SplitDirection,
    newTitle = 'Shell',
    newSessionId: string = crypto.randomUUID()
  ): string | null {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return null;

    const newPaneId = `pane-${crypto.randomUUID()}`;
    const newLeaf: PaneNode = {
      kind: 'leaf',
      paneId: newPaneId,
      sessionId: newSessionId,
      title: newTitle,
      channelId: this.nextChannelId++
    };

    const replaced = replacePaneInTree(tab.rootPane, targetPaneId, (targetLeaf) => ({
      kind: 'split',
      splitId: `split-${crypto.randomUUID()}`,
      direction,
      ratio: 0.5,
      first: targetLeaf,
      second: newLeaf
    }));

    if (!replaced.changed) return null;
    tab.rootPane = replaced.node;
    tab.activePaneId = newPaneId;
    return newPaneId;
  }

  closePane(tabId: string, targetPaneId: string): boolean {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return false;
    if (tab.rootPane.kind === 'leaf') {
      if (tab.rootPane.paneId === targetPaneId) {
        return this.closeTab(tabId);
      }
      return false;
    }
    const nextRoot = removePaneFromTree(tab.rootPane, targetPaneId);
    if (!nextRoot) return false;
    tab.rootPane = nextRoot;
    const leaves = collectLeafPanes(tab.rootPane);
    if (!leaves.some((l) => l.paneId === tab.activePaneId) && leaves[0]) {
      tab.activePaneId = leaves[0].paneId;
    }
    return true;
  }

  resizeSplit(tabId: string, splitId: string, ratio: number): boolean {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return false;
    const clamped = Math.max(0.15, Math.min(0.85, ratio));
    return updateSplitRatio(tab.rootPane, splitId, clamped);
  }

  /**
   * Returns target channel IDs for keyboard input: either all panes in the active tab (when broadcast is enabled)
   * or only the active pane's channel ID.
   */
  resolveInputTargetChannels(): number[] {
    const tab = this.getActiveTab();
    if (!tab) return [];
    const leaves = collectLeafPanes(tab.rootPane);
    if (this.broadcastEnabled) {
      return leaves.map((l) => l.channelId);
    }
    const active = leaves.find((l) => l.paneId === tab.activePaneId) ?? leaves[0];
    return active ? [active.channelId] : [];
  }
}

export function collectLeafPanes(node: PaneNode): Array<Extract<PaneNode, { kind: 'leaf' }>> {
  if (node.kind === 'leaf') return [node];
  return [...collectLeafPanes(node.first), ...collectLeafPanes(node.second)];
}

function replacePaneInTree(
  node: PaneNode,
  targetPaneId: string,
  replacer: (leaf: Extract<PaneNode, { kind: 'leaf' }>) => PaneNode
): { node: PaneNode; changed: boolean } {
  if (node.kind === 'leaf') {
    if (node.paneId === targetPaneId) {
      return { node: replacer(node), changed: true };
    }
    return { node, changed: false };
  }
  const left = replacePaneInTree(node.first, targetPaneId, replacer);
  if (left.changed) {
    return { node: { ...node, first: left.node }, changed: true };
  }
  const right = replacePaneInTree(node.second, targetPaneId, replacer);
  if (right.changed) {
    return { node: { ...node, second: right.node }, changed: true };
  }
  return { node, changed: false };
}

function removePaneFromTree(node: PaneNode, targetPaneId: string): PaneNode | null {
  if (node.kind === 'leaf') {
    return node.paneId === targetPaneId ? null : node;
  }
  if (node.first.kind === 'leaf' && node.first.paneId === targetPaneId) {
    return node.second;
  }
  if (node.second.kind === 'leaf' && node.second.paneId === targetPaneId) {
    return node.first;
  }
  const nextFirst = removePaneFromTree(node.first, targetPaneId);
  if (nextFirst && nextFirst !== node.first) {
    return { ...node, first: nextFirst };
  }
  const nextSecond = removePaneFromTree(node.second, targetPaneId);
  if (nextSecond && nextSecond !== node.second) {
    return { ...node, second: nextSecond };
  }
  return null;
}

function updateSplitRatio(node: PaneNode, splitId: string, ratio: number): boolean {
  if (node.kind === 'leaf') return false;
  if (node.splitId === splitId) {
    node.ratio = ratio;
    return true;
  }
  return updateSplitRatio(node.first, splitId, ratio) || updateSplitRatio(node.second, splitId, ratio);
}

export interface FullScreenState {
  isFullScreen: boolean;
  isPseudoFullScreenFallback: boolean;
  isZenMode: boolean;
  isTopHoverOverlayVisible: boolean;
  showEntryToast: boolean;
}

/**
 * Controls Immersive Full-Screen Mode (`F11`, `Cmd/Ctrl+Shift+F`, `Shift+Esc`),
 * top-edge 6px hover zone with 300ms dwell, 3-second entry toast, Keyboard Lock API (`Escape`),
 * and `100dvh` pseudo-fullscreen fallback when native Fullscreen API is unavailable.
 */
export class FullScreenController {
  private state: FullScreenState = {
    isFullScreen: false,
    isPseudoFullScreenFallback: false,
    isZenMode: false,
    isTopHoverOverlayVisible: false,
    showEntryToast: false
  };

  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(state: FullScreenState) => void>();

  getState(): FullScreenState {
    return { ...this.state };
  }

  subscribe(fn: (state: FullScreenState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.getState();
    for (const fn of this.listeners) {
      fn(snap);
    }
  }

  async enterFullScreen(targetEl?: HTMLElement | null): Promise<FullScreenState> {
    let usedNative = false;
    if (targetEl && typeof targetEl.requestFullscreen === 'function') {
      try {
        await targetEl.requestFullscreen();
        usedNative = true;
      } catch {
        usedNative = false;
      }
    }

    // Attempt Keyboard Lock API for 'Escape' so vim/tmux/htop receive Escape directly
    const navWithKeyboard = navigator as Navigator & {
      keyboard?: { lock?: (keys: string[]) => Promise<void>; unlock?: () => void };
    };
    if (navWithKeyboard.keyboard?.lock) {
      try {
        await navWithKeyboard.keyboard.lock(['Escape']);
      } catch {
        // Fallback when unsupported
      }
    }

    this.state.isFullScreen = true;
    this.state.isPseudoFullScreenFallback = !usedNative;
    this.state.isTopHoverOverlayVisible = false;
    this.state.showEntryToast = true;

    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.state.showEntryToast = false;
      this.emit();
    }, 3000);

    this.emit();
    return this.getState();
  }

  async exitFullScreen(): Promise<FullScreenState> {
    if (typeof document !== 'undefined' && document.fullscreenElement && document.exitFullscreen) {
      try {
        await document.exitFullscreen();
      } catch {
        // Ignore if already exited
      }
    }

    const navWithKeyboard = navigator as Navigator & {
      keyboard?: { unlock?: () => void };
    };
    navWithKeyboard.keyboard?.unlock?.();

    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }

    this.state.isFullScreen = false;
    this.state.isPseudoFullScreenFallback = false;
    this.state.isTopHoverOverlayVisible = false;
    this.state.showEntryToast = false;
    this.emit();
    return this.getState();
  }

  async toggleFullScreen(targetEl?: HTMLElement | null): Promise<FullScreenState> {
    if (this.state.isFullScreen) {
      return this.exitFullScreen();
    }
    return this.enterFullScreen(targetEl);
  }

  toggleZenMode(): FullScreenState {
    this.state.isZenMode = !this.state.isZenMode;
    this.emit();
    return this.getState();
  }

  /**
   * Reveals the auto-hiding top bar when pointer dwells within the top 6px edge for 300ms.
   */
  handlePointerMove(clientY: number): void {
    if (!this.state.isFullScreen) return;

    if (clientY <= 6) {
      if (!this.hoverTimer && !this.state.isTopHoverOverlayVisible) {
        this.hoverTimer = setTimeout(() => {
          this.hoverTimer = null;
          this.state.isTopHoverOverlayVisible = true;
          this.emit();
        }, 300);
      }
    } else if (clientY > 44) {
      if (this.hoverTimer) {
        clearTimeout(this.hoverTimer);
        this.hoverTimer = null;
      }
      if (this.state.isTopHoverOverlayVisible) {
        this.state.isTopHoverOverlayVisible = false;
        this.emit();
      }
    }
  }

  /**
   * Handles keyboard shortcuts:
   * - F11 or Cmd/Ctrl+Shift+F -> toggle full screen
   * - Shift+Escape -> exit full screen (while plain Escape is forwarded to PTY)
   */
  async handleKeyDown(e: {
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    preventDefault?: () => void;
  }, targetEl?: HTMLElement | null): Promise<boolean> {
    if (
      e.key === 'F11' ||
      ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f')
    ) {
      e.preventDefault?.();
      await this.toggleFullScreen(targetEl);
      return true;
    }

    if (this.state.isFullScreen && e.shiftKey && e.key === 'Escape') {
      e.preventDefault?.();
      await this.exitFullScreen();
      return true;
    }

    return false;
  }
}

export interface CommandCompletionEvent {
  exitCode: number;
  durationMs: number;
  triggeredBy: 'osc133' | 'bell';
}

/**
 * Detects OSC 133 shell integration markers (`\x1b]133;C\x07` start, `\x1b]133;D;exitCode\x07` end)
 * and BEL (`\x07`) notifications for background tabs.
 */
export class CommandCompletionDetector {
  private commandStartedAt: number | null = null;
  private thresholdMs: number;

  constructor(thresholdMs = 10_000) {
    this.thresholdMs = thresholdMs;
  }

  inspectPtyOutput(text: string, nowMs = Date.now()): CommandCompletionEvent | null {
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);

    const startMarker = `${esc}]133;C${bel}`;
    if (text.includes(startMarker)) {
      this.commandStartedAt = nowMs;
    }

    const endPrefix = `${esc}]133;D`;
    const endIdx = text.indexOf(endPrefix);
    if (endIdx >= 0) {
      const belIdx = text.indexOf(bel, endIdx);
      if (belIdx > endIdx) {
        const inner = text.slice(endIdx + endPrefix.length, belIdx);
        const exitCode = inner.startsWith(';') ? Number.parseInt(inner.slice(1), 10) || 0 : 0;
        const durationMs =
          this.commandStartedAt !== null ? Math.max(0, nowMs - this.commandStartedAt) : this.thresholdMs;
        this.commandStartedAt = null;
        if (durationMs >= this.thresholdMs) {
          return { exitCode, durationMs, triggeredBy: 'osc133' };
        }
      }
    }

    if (text.includes(bel) && !text.includes(`${esc}]`)) {
      return { exitCode: 0, durationMs: this.thresholdMs, triggeredBy: 'bell' };
    }

    return null;
  }
}
