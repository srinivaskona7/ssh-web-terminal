export declare const DEFAULT_RECORDING_CAP_BYTES: number;
export declare const HARD_MAX_RECORDING_CAP_BYTES: number;
export interface CommandItem {
    id: string;
    title: string;
    category: 'Connection' | 'Terminal' | 'Files' | 'View' | 'Security' | 'Preferences';
    shortcut?: string;
    keywords?: string[];
    run: () => void | Promise<void>;
}
/**
 * Fuzzy-scores a query against a target string. Returns -1 if not all characters appear in order.
 */
export declare function fuzzyScore(query: string, target: string): number;
export declare class CommandPaletteRegistry {
    private readonly commands;
    register(item: CommandItem): void;
    search(query: string): CommandItem[];
    execute(id: string): void | Promise<void>;
}
export interface Snippet {
    id: string;
    name: string;
    command: string;
    description?: string;
    tags: string[];
}
export declare function extractSnippetVariables(template: string): string[];
export declare function interpolateSnippet(template: string, values: Record<string, string>): string;
export declare class SnippetLibrary {
    private readonly snippets;
    constructor(initial?: Snippet[]);
    upsert(snippet: Snippet): Snippet;
    remove(id: string): boolean;
    list(query?: string): Snippet[];
}
export declare class BroadcastManager {
    private enabled;
    private readonly targetPaneIds;
    setEnabled(enabled: boolean): void;
    isEnabled(): boolean;
    toggleTargetPane(paneId: string): boolean;
    getTargets(): string[];
    dispatchInput(input: string, writer: (paneId: string, data: string) => void): number;
}
export interface AsciicastHeader {
    version: 2;
    width: number;
    height: number;
    timestamp: number;
    title?: string;
}
export type AsciicastEvent = [number, 'o' | 'i', string];
export declare class AsciicastRecorder {
    private readonly header;
    private readonly events;
    private readonly startTimeMs;
    private readonly maxBytes;
    private currentBytes;
    private capped;
    constructor(width: number, height: number, title?: string, maxBytes?: number, startTimeMs?: number);
    recordOutput(data: string, nowMs?: number): boolean;
    recordInput(data: string, nowMs?: number): boolean;
    private appendEvent;
    isCapped(): boolean;
    getByteLength(): number;
    exportCast(): string;
}
export declare function parseAsciicastV2(castText: string): {
    header: AsciicastHeader;
    events: AsciicastEvent[];
    durationSec: number;
};
export declare function scrubAsciicastOutput(events: AsciicastEvent[], targetTimeSec: number): string;
export interface KeybindingEntry {
    actionId: string;
    description: string;
    shortcut: string;
}
export interface KeybindingConflict {
    shortcut: string;
    actionIds: string[];
}
export declare function normalizeShortcut(shortcut: string): string;
export declare class KeybindingRegistry {
    private readonly bindings;
    constructor(defaults?: KeybindingEntry[]);
    rebind(actionId: string, newShortcut: string, description?: string): KeybindingConflict[];
    detectConflicts(): KeybindingConflict[];
    list(): KeybindingEntry[];
}
export interface CompletionNotification {
    exitCode: number;
    reason: 'osc133' | 'bell';
    timestamp: number;
}
/**
 * Inspects PTY output stream for OSC 133 command completion (`\x1b]133;D;<exitCode>\x07`) or bell (`\x07`).
 */
export declare function detectCommandCompletion(ptyChunk: string): CompletionNotification | null;
export declare const SPECIAL_KEYS_ROW: readonly ["Esc", "Tab", "Ctrl", "Alt", "Up", "Down", "Left", "Right"];
export type SpecialKeyLabel = (typeof SPECIAL_KEYS_ROW)[number];
export declare function translateSpecialKey(key: SpecialKeyLabel): string;
//# sourceMappingURL=productivity.d.ts.map