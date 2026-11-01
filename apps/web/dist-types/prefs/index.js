import { THEME_IDS, getContrastRatio, meetsWcagAA } from '@webssh/ui-kit';
export const PREFERENCES_SCHEMA_VERSION = 2;
export const BUNDLED_PROGRAMMING_FONTS = [
    'JetBrains Mono',
    'Fira Code',
    'Source Code Pro',
    'IBM Plex Mono'
];
export function createDefaultPreferences() {
    return {
        schemaVersion: PREFERENCES_SCHEMA_VERSION,
        activeThemeId: 'dark',
        customThemes: {},
        typography: {
            fontFamily: 'JetBrains Mono',
            fontSize: 13,
            lineHeight: 1.45,
            letterSpacing: 0,
            ligatures: true
        },
        layoutPreset: 'sidebar-left',
        surface: {
            cursorShape: 'block',
            cursorBlink: true,
            surfaceOpacity: 1.0
        },
        storageLimits: {
            maxScrollbackLines: 10_000,
            maxLocalStorageMiB: 256,
            maxInFlightBufferMiB: 32,
            maxConcurrentTransfers: 3,
            maxRecordingMiB: 64
        },
        perHostOverrides: {},
        vaultAutoLockMinutes: 15,
        notificationsEnabled: true
    };
}
export function clampPreferencesLimits(prefs) {
    return {
        ...prefs,
        typography: {
            ...prefs.typography,
            fontSize: Math.min(28, Math.max(10, prefs.typography.fontSize)),
            lineHeight: Math.min(2.2, Math.max(1.0, prefs.typography.lineHeight)),
            letterSpacing: Math.min(4, Math.max(-1, prefs.typography.letterSpacing))
        },
        surface: {
            ...prefs.surface,
            surfaceOpacity: Math.min(1.0, Math.max(0.5, prefs.surface.surfaceOpacity))
        },
        storageLimits: {
            maxScrollbackLines: Math.min(100_000, Math.max(1_000, prefs.storageLimits.maxScrollbackLines)),
            maxLocalStorageMiB: Math.min(1024, Math.max(32, prefs.storageLimits.maxLocalStorageMiB)),
            maxInFlightBufferMiB: Math.min(128, Math.max(8, prefs.storageLimits.maxInFlightBufferMiB)),
            maxConcurrentTransfers: Math.min(6, Math.max(1, prefs.storageLimits.maxConcurrentTransfers)),
            maxRecordingMiB: Math.min(256, Math.max(8, prefs.storageLimits.maxRecordingMiB))
        }
    };
}
export function migratePreferences(raw) {
    const defaults = createDefaultPreferences();
    if (typeof raw !== 'object' || raw === null) {
        return defaults;
    }
    const obj = raw;
    if (obj.schemaVersion === 2) {
        const merged = {
            ...defaults,
            ...obj,
            typography: {
                ...defaults.typography,
                ...(obj.typography ?? {})
            },
            surface: {
                ...defaults.surface,
                ...(obj.surface ?? {})
            },
            storageLimits: {
                ...defaults.storageLimits,
                ...(obj.storageLimits ?? {})
            },
            customThemes: obj.customThemes ?? {},
            perHostOverrides: obj.perHostOverrides ?? {},
            schemaVersion: 2
        };
        return clampPreferencesLimits(merged);
    }
    // Migrate from v1 schema
    const v1 = obj;
    const migrated = {
        ...defaults,
        activeThemeId: typeof v1.theme === 'string' && v1.theme.length > 0 ? v1.theme : defaults.activeThemeId,
        layoutPreset: v1.layout ?? defaults.layoutPreset,
        typography: {
            ...defaults.typography,
            fontSize: typeof v1.fontSize === 'number' ? v1.fontSize : defaults.typography.fontSize,
            fontFamily: typeof v1.fontFamily === 'string' ? v1.fontFamily : defaults.typography.fontFamily
        }
    };
    return clampPreferencesLimits(migrated);
}
export function validateCustomThemeContrast(theme) {
    const ratio = getContrastRatio(theme.foreground, theme.background);
    return {
        ratio,
        passesAA: meetsWcagAA(theme.foreground, theme.background)
    };
}
export async function listAvailableFonts() {
    const fonts = new Set(BUNDLED_PROGRAMMING_FONTS);
    if (typeof window !== 'undefined' && 'queryLocalFonts' in window) {
        try {
            const queryFn = window.queryLocalFonts;
            const localFonts = await queryFn();
            for (const f of localFonts) {
                if (f.family) {
                    fonts.add(f.family);
                }
            }
        }
        catch {
            // Permission denied or unavailable; fall back to self-hosted WOFF2 fonts
        }
    }
    return Array.from(fonts);
}
const memoryStorageFallback = new Map();
export class PreferencesStore {
    state;
    storageKey;
    constructor(storageKey = 'webssh.preferences.v2') {
        this.storageKey = storageKey;
        this.state = this.loadFromStorage();
    }
    loadFromStorage() {
        try {
            const raw = typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
                ? localStorage.getItem(this.storageKey)
                : (memoryStorageFallback.get(this.storageKey) ?? null);
            if (raw) {
                return migratePreferences(JSON.parse(raw));
            }
        }
        catch {
            return createDefaultPreferences();
        }
        return createDefaultPreferences();
    }
    persist() {
        const serialized = JSON.stringify(this.state);
        try {
            if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
                localStorage.setItem(this.storageKey, serialized);
                return;
            }
        }
        catch {
            // Fall back to in-memory map
        }
        memoryStorageFallback.set(this.storageKey, serialized);
    }
    get() {
        return this.state;
    }
    update(patch) {
        this.state = clampPreferencesLimits({
            ...this.state,
            ...patch,
            schemaVersion: 2
        });
        this.persist();
        return this.state;
    }
    saveCustomTheme(theme) {
        const check = validateCustomThemeContrast(theme);
        this.state = {
            ...this.state,
            customThemes: {
                ...this.state.customThemes,
                [theme.id]: theme
            }
        };
        this.persist();
        return check;
    }
    setHostOverride(override) {
        this.state = {
            ...this.state,
            perHostOverrides: {
                ...this.state.perHostOverrides,
                [override.hostId]: override
            }
        };
        this.persist();
        return this.state;
    }
    resolveForHost(hostId) {
        const over = hostId ? this.state.perHostOverrides[hostId] : undefined;
        return {
            themeId: over?.themeId ?? this.state.activeThemeId,
            fontFamily: over?.fontFamily ?? this.state.typography.fontFamily,
            fontSize: over?.fontSize ?? this.state.typography.fontSize,
            layoutPreset: over?.layoutPreset ?? this.state.layoutPreset
        };
    }
    exportJson() {
        return JSON.stringify(this.state, null, 2);
    }
    importJson(jsonText) {
        const parsed = JSON.parse(jsonText);
        this.state = migratePreferences(parsed);
        this.persist();
        return this.state;
    }
    listThemeIds() {
        return [...THEME_IDS, ...Object.keys(this.state.customThemes)];
    }
}
//# sourceMappingURL=index.js.map