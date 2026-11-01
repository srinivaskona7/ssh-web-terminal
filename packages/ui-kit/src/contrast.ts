import { THEMES, THEME_IDS, type ThemeId, type ThemeTokens } from './generated/tokens.js';

export function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    const r = parseInt((clean[0] ?? '0') + (clean[0] ?? '0'), 16);
    const g = parseInt((clean[1] ?? '0') + (clean[1] ?? '0'), 16);
    const b = parseInt((clean[2] ?? '0') + (clean[2] ?? '0'), 16);
    return [r, g, b];
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [r, g, b];
}

export function relativeLuminance(hex: string): number {
  const [r8, g8, b8] = parseHexRgb(hex);
  const toLinear = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r8) + 0.7152 * toLinear(g8) + 0.0722 * toLinear(b8);
}

export function getContrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

export function meetsWcagAA(fgHex: string, bgHex: string, largeText = false): boolean {
  const ratio = getContrastRatio(fgHex, bgHex);
  return ratio >= (largeText ? 3.0 : 4.5);
}

export function auditThemeContrast(theme: ThemeTokens): {
  canvasPrimaryRatio: number;
  surfacePrimaryRatio: number;
  surfaceSecondaryRatio: number;
  terminalRatio: number;
  passesAA: boolean;
} {
  const canvasPrimaryRatio = getContrastRatio(theme.fgPrimary, theme.bgCanvas);
  const surfacePrimaryRatio = getContrastRatio(theme.fgPrimary, theme.bgSurface);
  const surfaceSecondaryRatio = getContrastRatio(theme.fgSecondary, theme.bgSurface);
  const terminalRatio = getContrastRatio(theme.terminalFg, theme.terminalBg);
  const passesAA =
    canvasPrimaryRatio >= 4.5 &&
    surfacePrimaryRatio >= 4.5 &&
    surfaceSecondaryRatio >= 4.5 &&
    terminalRatio >= 4.5;
  return {
    canvasPrimaryRatio,
    surfacePrimaryRatio,
    surfaceSecondaryRatio,
    terminalRatio,
    passesAA
  };
}

export function applyThemeToDocument(themeId: ThemeId, customTokens?: Partial<ThemeTokens>, doc: Document = document): void {
  const root = doc.documentElement;
  root.setAttribute('data-theme', themeId);
  const base = THEMES[themeId] ?? THEMES.dark;
  const merged: ThemeTokens = {
    ...base,
    ...customTokens,
    ansi: {
      ...base.ansi,
      ...(customTokens?.ansi ?? {})
    }
  };
  const camelToKebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  for (const [k, v] of Object.entries(merged)) {
    if (k === 'ansi' && typeof v === 'object' && v !== null) {
      for (const [ak, av] of Object.entries(v)) {
        root.style.setProperty(`--color-ansi-${camelToKebab(ak)}`, String(av));
      }
    } else if (typeof v === 'string') {
      root.style.setProperty(`--color-${camelToKebab(k)}`, v);
    }
  }
}

export { THEMES, THEME_IDS, type ThemeId, type ThemeTokens };
