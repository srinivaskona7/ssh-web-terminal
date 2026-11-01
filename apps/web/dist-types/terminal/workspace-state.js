export class WorkspaceManager {
    tabs = [];
    activeTabId = null;
    broadcastEnabled = false;
    nextChannelId = 1;
    getTabs() {
        return this.tabs.map((t) => ({ ...t }));
    }
    getActiveTab() {
        if (!this.activeTabId)
            return null;
        return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
    }
    get isBroadcastEnabled() {
        return this.broadcastEnabled;
    }
    setBroadcastInput(enabled) {
        this.broadcastEnabled = enabled;
    }
    createTab(title, sessionId = crypto.randomUUID(), environmentTag) {
        const paneId = `pane-${crypto.randomUUID()}`;
        const tabId = `tab-${crypto.randomUUID()}`;
        const leaf = {
            kind: 'leaf',
            paneId,
            sessionId,
            title,
            channelId: this.nextChannelId++
        };
        const tab = {
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
    activateTab(tabId) {
        const found = this.tabs.find((t) => t.id === tabId);
        if (!found)
            return false;
        this.activeTabId = tabId;
        found.hasUnreadActivity = false;
        return true;
    }
    renameTab(tabId, newTitle) {
        const trimmed = newTitle.trim();
        if (!trimmed)
            return false;
        const found = this.tabs.find((t) => t.id === tabId);
        if (!found)
            return false;
        found.title = trimmed;
        return true;
    }
    reorderTabs(fromIndex, toIndex) {
        if (fromIndex < 0 ||
            fromIndex >= this.tabs.length ||
            toIndex < 0 ||
            toIndex >= this.tabs.length) {
            return false;
        }
        const [moved] = this.tabs.splice(fromIndex, 1);
        if (!moved)
            return false;
        this.tabs.splice(toIndex, 0, moved);
        return true;
    }
    closeTab(tabId) {
        const idx = this.tabs.findIndex((t) => t.id === tabId);
        if (idx < 0)
            return false;
        this.tabs.splice(idx, 1);
        if (this.activeTabId === tabId) {
            const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
            this.activeTabId = next ? next.id : null;
        }
        return true;
    }
    splitPane(tabId, targetPaneId, direction, newTitle = 'Shell', newSessionId = crypto.randomUUID()) {
        const tab = this.tabs.find((t) => t.id === tabId);
        if (!tab)
            return null;
        const newPaneId = `pane-${crypto.randomUUID()}`;
        const newLeaf = {
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
        if (!replaced.changed)
            return null;
        tab.rootPane = replaced.node;
        tab.activePaneId = newPaneId;
        return newPaneId;
    }
    closePane(tabId, targetPaneId) {
        const tab = this.tabs.find((t) => t.id === tabId);
        if (!tab)
            return false;
        if (tab.rootPane.kind === 'leaf') {
            if (tab.rootPane.paneId === targetPaneId) {
                return this.closeTab(tabId);
            }
            return false;
        }
        const nextRoot = removePaneFromTree(tab.rootPane, targetPaneId);
        if (!nextRoot)
            return false;
        tab.rootPane = nextRoot;
        const leaves = collectLeafPanes(tab.rootPane);
        if (!leaves.some((l) => l.paneId === tab.activePaneId) && leaves[0]) {
            tab.activePaneId = leaves[0].paneId;
        }
        return true;
    }
    resizeSplit(tabId, splitId, ratio) {
        const tab = this.tabs.find((t) => t.id === tabId);
        if (!tab)
            return false;
        const clamped = Math.max(0.15, Math.min(0.85, ratio));
        return updateSplitRatio(tab.rootPane, splitId, clamped);
    }
    /**
     * Returns target channel IDs for keyboard input: either all panes in the active tab (when broadcast is enabled)
     * or only the active pane's channel ID.
     */
    resolveInputTargetChannels() {
        const tab = this.getActiveTab();
        if (!tab)
            return [];
        const leaves = collectLeafPanes(tab.rootPane);
        if (this.broadcastEnabled) {
            return leaves.map((l) => l.channelId);
        }
        const active = leaves.find((l) => l.paneId === tab.activePaneId) ?? leaves[0];
        return active ? [active.channelId] : [];
    }
}
export function collectLeafPanes(node) {
    if (node.kind === 'leaf')
        return [node];
    return [...collectLeafPanes(node.first), ...collectLeafPanes(node.second)];
}
function replacePaneInTree(node, targetPaneId, replacer) {
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
function removePaneFromTree(node, targetPaneId) {
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
function updateSplitRatio(node, splitId, ratio) {
    if (node.kind === 'leaf')
        return false;
    if (node.splitId === splitId) {
        node.ratio = ratio;
        return true;
    }
    return updateSplitRatio(node.first, splitId, ratio) || updateSplitRatio(node.second, splitId, ratio);
}
/**
 * Controls Immersive Full-Screen Mode (`F11`, `Cmd/Ctrl+Shift+F`, `Shift+Esc`),
 * top-edge 6px hover zone with 300ms dwell, 3-second entry toast, Keyboard Lock API (`Escape`),
 * and `100dvh` pseudo-fullscreen fallback when native Fullscreen API is unavailable.
 */
export class FullScreenController {
    state = {
        isFullScreen: false,
        isPseudoFullScreenFallback: false,
        isZenMode: false,
        isTopHoverOverlayVisible: false,
        showEntryToast: false
    };
    hoverTimer = null;
    toastTimer = null;
    listeners = new Set();
    getState() {
        return { ...this.state };
    }
    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    emit() {
        const snap = this.getState();
        for (const fn of this.listeners) {
            fn(snap);
        }
    }
    async enterFullScreen(targetEl) {
        let usedNative = false;
        if (targetEl && typeof targetEl.requestFullscreen === 'function') {
            try {
                await targetEl.requestFullscreen();
                usedNative = true;
            }
            catch {
                usedNative = false;
            }
        }
        // Attempt Keyboard Lock API for 'Escape' so vim/tmux/htop receive Escape directly
        const navWithKeyboard = navigator;
        if (navWithKeyboard.keyboard?.lock) {
            try {
                await navWithKeyboard.keyboard.lock(['Escape']);
            }
            catch {
                // Fallback when unsupported
            }
        }
        this.state.isFullScreen = true;
        this.state.isPseudoFullScreenFallback = !usedNative;
        this.state.isTopHoverOverlayVisible = false;
        this.state.showEntryToast = true;
        if (this.toastTimer)
            clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            this.state.showEntryToast = false;
            this.emit();
        }, 3000);
        this.emit();
        return this.getState();
    }
    async exitFullScreen() {
        if (typeof document !== 'undefined' && document.fullscreenElement && document.exitFullscreen) {
            try {
                await document.exitFullscreen();
            }
            catch {
                // Ignore if already exited
            }
        }
        const navWithKeyboard = navigator;
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
    async toggleFullScreen(targetEl) {
        if (this.state.isFullScreen) {
            return this.exitFullScreen();
        }
        return this.enterFullScreen(targetEl);
    }
    toggleZenMode() {
        this.state.isZenMode = !this.state.isZenMode;
        this.emit();
        return this.getState();
    }
    /**
     * Reveals the auto-hiding top bar when pointer dwells within the top 6px edge for 300ms.
     */
    handlePointerMove(clientY) {
        if (!this.state.isFullScreen)
            return;
        if (clientY <= 6) {
            if (!this.hoverTimer && !this.state.isTopHoverOverlayVisible) {
                this.hoverTimer = setTimeout(() => {
                    this.hoverTimer = null;
                    this.state.isTopHoverOverlayVisible = true;
                    this.emit();
                }, 300);
            }
        }
        else if (clientY > 44) {
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
    async handleKeyDown(e, targetEl) {
        if (e.key === 'F11' ||
            ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f')) {
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
/**
 * Detects OSC 133 shell integration markers (`\x1b]133;C\x07` start, `\x1b]133;D;exitCode\x07` end)
 * and BEL (`\x07`) notifications for background tabs.
 */
export class CommandCompletionDetector {
    commandStartedAt = null;
    thresholdMs;
    constructor(thresholdMs = 10_000) {
        this.thresholdMs = thresholdMs;
    }
    inspectPtyOutput(text, nowMs = Date.now()) {
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
                const durationMs = this.commandStartedAt !== null ? Math.max(0, nowMs - this.commandStartedAt) : this.thresholdMs;
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
//# sourceMappingURL=workspace-state.js.map