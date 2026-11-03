import { type ThemeId } from '@webssh/ui-kit';
export declare const PREFERENCES_SCHEMA_VERSION = 2;
export declare const BUNDLED_PROGRAMMING_FONTS: readonly ["JetBrains Mono", "Fira Code", "Source Code Pro", "IBM Plex Mono"];
export type LayoutPreset = 'sidebar-left' | 'sidebar-right' | 'bottom-files' | 'compact' | 'zen';
export type WorkspacePreset = 'terminal' | 'develop' | 'operate';
export type CursorShape = 'block' | 'underline' | 'bar';
export interface CustomAnsiPalette {
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
}
export interface CustomThemeDefinition {
    id: string;
    name: string;
    background: string;
    foreground: string;
    cursor: string;
    selection: string;
    ansi: CustomAnsiPalette;
}
export interface TypographyPreferences {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    letterSpacing: number;
    ligatures: boolean;
}
export interface SurfacePreferences {
    cursorShape: CursorShape;
    cursorBlink: boolean;
    surfaceOpacity: number;
    backgroundImageUrl?: string;
}
export interface StorageLimitPreferences {
    maxScrollbackLines: number;
    maxLocalStorageMiB: number;
    maxInFlightBufferMiB: number;
    maxConcurrentTransfers: number;
    maxRecordingMiB: number;
}
export interface HostPreferenceOverride {
    hostId: string;
    themeId?: string;
    fontFamily?: string;
    fontSize?: number;
    layoutPreset?: LayoutPreset;
}
export interface UserPreferencesV2 {
    schemaVersion: 2;
    activeThemeId: ThemeId | string;
    customThemes: Record<string, CustomThemeDefinition>;
    typography: TypographyPreferences;
    layoutPreset: LayoutPreset;
    /** Navigation rail width in CSS pixels (120–360). */
    railWidthPx: number;
    /** Named workspace preset: terminal-first, develop, or operate. */
    workspacePreset: WorkspacePreset;
    surface: SurfacePreferences;
    storageLimits: StorageLimitPreferences;
    perHostOverrides: Record<string, HostPreferenceOverride>;
    vaultAutoLockMinutes: number;
    notificationsEnabled: boolean;
}
export interface LegacyUserPreferencesV1 {
    schemaVersion?: 1;
    theme?: string;
    fontSize?: number;
    fontFamily?: string;
    layout?: LayoutPreset;
}
export declare function createDefaultPreferences(): UserPreferencesV2;
export declare function clampPreferencesLimits(prefs: UserPreferencesV2): UserPreferencesV2;
export declare function migratePreferences(raw: unknown): UserPreferencesV2;
export declare function validateCustomThemeContrast(theme: CustomThemeDefinition): {
    ratio: number;
    passesAA: boolean;
};
export declare function listAvailableFonts(): Promise<string[]>;
export declare class PreferencesStore {
    private state;
    private readonly storageKey;
    constructor(storageKey?: string);
    private loadFromStorage;
    private persist;
    get(): UserPreferencesV2;
    update(patch: Partial<UserPreferencesV2>): UserPreferencesV2;
    saveCustomTheme(theme: CustomThemeDefinition): {
        ratio: number;
        passesAA: boolean;
    };
    setHostOverride(override: HostPreferenceOverride): UserPreferencesV2;
    resolveForHost(hostId?: string): {
        themeId: string;
        fontFamily: string;
        fontSize: number;
        layoutPreset: LayoutPreset;
    };
    exportJson(): string;
    importJson(jsonText: string): UserPreferencesV2;
    listThemeIds(): string[];
}
//# sourceMappingURL=index.d.ts.map