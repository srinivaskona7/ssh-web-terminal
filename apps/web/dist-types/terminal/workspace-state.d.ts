export type SplitDirection = 'horizontal' | 'vertical';
export type PaneNode = {
    kind: 'leaf';
    paneId: string;
    sessionId: string;
    title: string;
    channelId: number;
} | {
    kind: 'split';
    splitId: string;
    direction: SplitDirection;
    ratio: number;
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
export declare class WorkspaceManager {
    private tabs;
    private activeTabId;
    private broadcastEnabled;
    private nextChannelId;
    getTabs(): WorkspaceTab[];
    getActiveTab(): WorkspaceTab | null;
    get isBroadcastEnabled(): boolean;
    setBroadcastInput(enabled: boolean): void;
    createTab(title: string, sessionId?: string, environmentTag?: 'prod' | 'staging' | 'dev'): WorkspaceTab;
    activateTab(tabId: string): boolean;
    renameTab(tabId: string, newTitle: string): boolean;
    reorderTabs(fromIndex: number, toIndex: number): boolean;
    closeTab(tabId: string): boolean;
    splitPane(tabId: string, targetPaneId: string, direction: SplitDirection, newTitle?: string, newSessionId?: string): string | null;
    closePane(tabId: string, targetPaneId: string): boolean;
    resizeSplit(tabId: string, splitId: string, ratio: number): boolean;
    /**
     * Returns target channel IDs for keyboard input: either all panes in the active tab (when broadcast is enabled)
     * or only the active pane's channel ID.
     */
    resolveInputTargetChannels(): number[];
}
export declare function collectLeafPanes(node: PaneNode): Array<Extract<PaneNode, {
    kind: 'leaf';
}>>;
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
export declare class FullScreenController {
    private state;
    private hoverTimer;
    private toastTimer;
    private listeners;
    getState(): FullScreenState;
    subscribe(fn: (state: FullScreenState) => void): () => void;
    private emit;
    enterFullScreen(targetEl?: HTMLElement | null): Promise<FullScreenState>;
    exitFullScreen(): Promise<FullScreenState>;
    toggleFullScreen(targetEl?: HTMLElement | null): Promise<FullScreenState>;
    toggleZenMode(): FullScreenState;
    /**
     * Reveals the auto-hiding top bar when pointer dwells within the top 6px edge for 300ms.
     */
    handlePointerMove(clientY: number): void;
    /**
     * Handles keyboard shortcuts:
     * - F11 or Cmd/Ctrl+Shift+F -> toggle full screen
     * - Shift+Escape -> exit full screen (while plain Escape is forwarded to PTY)
     */
    handleKeyDown(e: {
        key: string;
        shiftKey?: boolean;
        ctrlKey?: boolean;
        metaKey?: boolean;
        preventDefault?: () => void;
    }, targetEl?: HTMLElement | null): Promise<boolean>;
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
export declare class CommandCompletionDetector {
    private commandStartedAt;
    private thresholdMs;
    constructor(thresholdMs?: number);
    inspectPtyOutput(text: string, nowMs?: number): CommandCompletionEvent | null;
}
//# sourceMappingURL=workspace-state.d.ts.map