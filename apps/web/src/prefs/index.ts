import { THEME_IDS, type ThemeId, getContrastRatio, meetsWcagAA } from '@webssh/ui-kit';

export const PREFERENCES_SCHEMA_VERSION = 2;
export const BUNDLED_PROGRAMMING_FONTS = [
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'IBM Plex Mono'
] as const;

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

export type Density = 'comfortable' | 'compact';

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
  /** Control density: comfortable (default) or compact. */
  density: Density;
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

export function createDefaultPreferences(): UserPreferencesV2 {
  return {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    activeThemeId: 'light',
    customThemes: {},
    typography: {
      fontFamily: 'JetBrains Mono',
      fontSize: 17,
      lineHeight: 1.25,
      letterSpacing: 0,
      ligatures: false
    },
    layoutPreset: 'sidebar-left',
    railWidthPx: 220,
    workspacePreset: 'terminal',
    density: 'comfortable',
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

function toFiniteNumber(val: unknown, fallback: number): number {
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

const VALID_LAYOUT_PRESETS: readonly LayoutPreset[] = [
  'sidebar-left',
  'sidebar-right',
  'bottom-files',
  'compact',
  'zen'
];

const VALID_CURSOR_SHAPES: readonly CursorShape[] = ['block', 'underline', 'bar'];

const VALID_WORKSPACE_PRESETS: readonly WorkspacePreset[] = ['terminal', 'develop', 'operate'];

export function clampPreferencesLimits(prefs: UserPreferencesV2): UserPreferencesV2 {
  const defaults = createDefaultPreferences();
  const typo =
    typeof prefs.typography === 'object' && prefs.typography !== null
      ? prefs.typography
      : defaults.typography;
  const surf =
    typeof prefs.surface === 'object' && prefs.surface !== null
      ? prefs.surface
      : defaults.surface;
  const lim =
    typeof prefs.storageLimits === 'object' && prefs.storageLimits !== null
      ? prefs.storageLimits
      : defaults.storageLimits;
  const customThemes =
    typeof prefs.customThemes === 'object' && prefs.customThemes !== null && !Array.isArray(prefs.customThemes)
      ? prefs.customThemes
      : {};
  const perHostOverrides =
    typeof prefs.perHostOverrides === 'object' && prefs.perHostOverrides !== null && !Array.isArray(prefs.perHostOverrides)
      ? prefs.perHostOverrides
      : {};

  const rawThemeId = typeof prefs.activeThemeId === 'string' ? prefs.activeThemeId.trim() : '';
  const isKnownTheme =
    (THEME_IDS as readonly string[]).includes(rawThemeId) ||
    Object.prototype.hasOwnProperty.call(customThemes, rawThemeId);

  const layoutPreset: LayoutPreset = VALID_LAYOUT_PRESETS.includes(prefs.layoutPreset)
    ? prefs.layoutPreset
    : defaults.layoutPreset;

  const cursorShape: CursorShape = VALID_CURSOR_SHAPES.includes(surf.cursorShape)
    ? surf.cursorShape
    : defaults.surface.cursorShape;

  return {
    ...defaults,
    ...prefs,
    schemaVersion: 2,
    activeThemeId: isKnownTheme ? rawThemeId : defaults.activeThemeId,
    customThemes,
    perHostOverrides,
    layoutPreset,
    vaultAutoLockMinutes: Math.min(120, Math.max(1, toFiniteNumber(prefs.vaultAutoLockMinutes, defaults.vaultAutoLockMinutes))),
    notificationsEnabled:
      typeof prefs.notificationsEnabled === 'boolean'
        ? prefs.notificationsEnabled
        : defaults.notificationsEnabled,
    typography: {
      fontFamily:
        typeof typo.fontFamily === 'string' && typo.fontFamily.trim().length > 0
          ? typo.fontFamily
          : defaults.typography.fontFamily,
      fontSize: Math.min(28, Math.max(10, toFiniteNumber(typo.fontSize, defaults.typography.fontSize))),
      lineHeight: Math.min(2.2, Math.max(1.0, toFiniteNumber(typo.lineHeight, defaults.typography.lineHeight))),
      letterSpacing: Math.min(4, Math.max(-1, toFiniteNumber(typo.letterSpacing, defaults.typography.letterSpacing))),
      ligatures: typeof typo.ligatures === 'boolean' ? typo.ligatures : defaults.typography.ligatures
    },
    surface: {
      ...surf,
      cursorShape,
      cursorBlink: typeof surf.cursorBlink === 'boolean' ? surf.cursorBlink : defaults.surface.cursorBlink,
      surfaceOpacity: Math.min(1.0, Math.max(0.5, toFiniteNumber(surf.surfaceOpacity, defaults.surface.surfaceOpacity)))
    },
    storageLimits: {
      maxScrollbackLines: Math.min(100_000, Math.max(1_000, toFiniteNumber(lim.maxScrollbackLines, defaults.storageLimits.maxScrollbackLines))),
      maxLocalStorageMiB: Math.min(1024, Math.max(32, toFiniteNumber(lim.maxLocalStorageMiB, defaults.storageLimits.maxLocalStorageMiB))),
      maxInFlightBufferMiB: Math.min(128, Math.max(8, toFiniteNumber(lim.maxInFlightBufferMiB, defaults.storageLimits.maxInFlightBufferMiB))),
      maxConcurrentTransfers: Math.min(6, Math.max(1, toFiniteNumber(lim.maxConcurrentTransfers, defaults.storageLimits.maxConcurrentTransfers))),
      maxRecordingMiB: Math.min(256, Math.max(8, toFiniteNumber(lim.maxRecordingMiB, defaults.storageLimits.maxRecordingMiB)))
    }
  };
}

export function migratePreferences(raw: unknown): UserPreferencesV2 {
  const defaults = createDefaultPreferences();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return defaults;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion === 2 || typeof obj.typography === 'object' || typeof obj.activeThemeId === 'string') {
    const rawTypo =
      typeof obj.typography === 'object' && obj.typography !== null && !Array.isArray(obj.typography)
        ? (obj.typography as Partial<TypographyPreferences>)
        : {};
    const rawSurface =
      typeof obj.surface === 'object' && obj.surface !== null && !Array.isArray(obj.surface)
        ? (obj.surface as Partial<SurfacePreferences>)
        : {};
    const rawLimits =
      typeof obj.storageLimits === 'object' && obj.storageLimits !== null && !Array.isArray(obj.storageLimits)
        ? (obj.storageLimits as Partial<StorageLimitPreferences>)
        : {};
    const rawCustomThemes =
      typeof obj.customThemes === 'object' && obj.customThemes !== null && !Array.isArray(obj.customThemes)
        ? (obj.customThemes as Record<string, CustomThemeDefinition>)
        : {};
    const rawOverrides =
      typeof obj.perHostOverrides === 'object' && obj.perHostOverrides !== null && !Array.isArray(obj.perHostOverrides)
        ? (obj.perHostOverrides as Record<string, HostPreferenceOverride>)
        : {};

    const merged: UserPreferencesV2 = {
      ...defaults,
      ...(obj as Partial<UserPreferencesV2>),
      typography: {
        ...defaults.typography,
        ...rawTypo
      },
      surface: {
        ...defaults.surface,
        ...rawSurface
      },
      storageLimits: {
        ...defaults.storageLimits,
        ...rawLimits
      },
      customThemes: rawCustomThemes,
      perHostOverrides: rawOverrides,
      schemaVersion: 2
    };
    if (!VALID_WORKSPACE_PRESETS.includes(merged.workspacePreset)) {
      merged.workspacePreset = defaults.workspacePreset;
    }
    const rawDensity = typeof merged.density === 'string' ? merged.density : '';
    if (rawDensity !== 'comfortable' && rawDensity !== 'compact') {
      merged.density = defaults.density;
    }
    merged.railWidthPx = Math.min(
      360,
      Math.max(120, toFiniteNumber(merged.railWidthPx, defaults.railWidthPx))
    );
    return clampPreferencesLimits(merged);
  }

  // Migrate from v1 schema
  const v1 = obj as LegacyUserPreferencesV1;
  const migrated: UserPreferencesV2 = {
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

export function validateCustomThemeContrast(theme: CustomThemeDefinition): {
  ratio: number;
  passesAA: boolean;
} {
  const ratio = getContrastRatio(theme.foreground, theme.background);
  return {
    ratio,
    passesAA: meetsWcagAA(theme.foreground, theme.background)
  };
}

export async function listAvailableFonts(): Promise<string[]> {
  const fonts = new Set<string>(BUNDLED_PROGRAMMING_FONTS);
  if (typeof window !== 'undefined' && 'queryLocalFonts' in window) {
    try {
      const queryFn = (window as unknown as { queryLocalFonts: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
      const localFonts = await queryFn();
      for (const f of localFonts) {
        if (f.family) {
          fonts.add(f.family);
        }
      }
    } catch {
      // Permission denied or unavailable; fall back to self-hosted WOFF2 fonts
    }
  }
  return Array.from(fonts);
}

const memoryStorageFallback = new Map<string, string>();

export class PreferencesStore {
  private state: UserPreferencesV2;
  private readonly storageKey: string;

  constructor(storageKey = 'webssh.preferences.v2') {
    this.storageKey = storageKey;
    this.state = this.loadFromStorage();
  }

  private loadFromStorage(): UserPreferencesV2 {
    try {
      const raw =
        typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
          ? localStorage.getItem(this.storageKey)
          : (memoryStorageFallback.get(this.storageKey) ?? null);
      if (raw) {
        return migratePreferences(JSON.parse(raw));
      }
    } catch {
      return createDefaultPreferences();
    }
    return createDefaultPreferences();
  }

  private persist(): void {
    const serialized = JSON.stringify(this.state);
    try {
      if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
        localStorage.setItem(this.storageKey, serialized);
        return;
      }
    } catch {
      // Fall back to in-memory map
    }
    memoryStorageFallback.set(this.storageKey, serialized);
  }

  get(): UserPreferencesV2 {
    return this.state;
  }

  update(patch: Partial<UserPreferencesV2>): UserPreferencesV2 {
    this.state = clampPreferencesLimits({
      ...this.state,
      ...patch,
      schemaVersion: 2
    });
    this.persist();
    return this.state;
  }

  saveCustomTheme(theme: CustomThemeDefinition): { ratio: number; passesAA: boolean } {
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

  setHostOverride(override: HostPreferenceOverride): UserPreferencesV2 {
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

  resolveForHost(hostId?: string): {
    themeId: string;
    fontFamily: string;
    fontSize: number;
    layoutPreset: LayoutPreset;
  } {
    const over = hostId ? this.state.perHostOverrides[hostId] : undefined;
    return {
      themeId: over?.themeId ?? this.state.activeThemeId,
      fontFamily: over?.fontFamily ?? this.state.typography.fontFamily,
      fontSize: over?.fontSize ?? this.state.typography.fontSize,
      layoutPreset: over?.layoutPreset ?? this.state.layoutPreset
    };
  }

  exportJson(): string {
    return JSON.stringify(this.state, null, 2);
  }

  importJson(jsonText: string): UserPreferencesV2 {
    const parsed: unknown = JSON.parse(jsonText);
    this.state = migratePreferences(parsed);
    this.persist();
    return this.state;
  }

  listThemeIds(): string[] {
    return [...THEME_IDS, ...Object.keys(this.state.customThemes)];
  }
}
