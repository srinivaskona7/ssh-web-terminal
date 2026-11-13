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

type ColorKey = Exclude<keyof ThemeTokens, 'ansi'>;

// Colours the UI sets as text on each of the three backgrounds (badges sit on bgElevated, inputs on bgCanvas).
const TEXT_KEYS: readonly ColorKey[] = ['fgPrimary', 'fgSecondary', 'fgMuted', 'accentPrimary', 'statusSuccess', 'statusWarning', 'statusDanger'];
const BACKGROUND_KEYS: readonly ColorKey[] = ['bgCanvas', 'bgSurface', 'bgElevated'];
// [text, background] pairs where a status or accent colour is the fill: primary and danger buttons, menu hover.
const LABEL_PAIRS: ReadonlyArray<readonly [ColorKey, ColorKey]> = [
  ['accentText', 'accentPrimary'],
  ['accentText', 'accentHover'],
  ['bgCanvas', 'accentPrimary'],
  ['bgCanvas', 'statusDanger'],
  ['terminalFg', 'terminalBg']
];

/**
 * WCAG 2.2 AA audit of the pairs the UI actually renders: 4.5:1 for text (1.4.3) and 3:1 for the
 * form-control border (1.4.11). `failures` names each pair below its minimum.
 */
export function auditThemeContrast(theme: ThemeTokens): {
  canvasPrimaryRatio: number;
  surfacePrimaryRatio: number;
  surfaceSecondaryRatio: number;
  terminalRatio: number;
  failures: string[];
  passesAA: boolean;
} {
  const failures: string[] = [];
  const check = (fg: ColorKey, bg: ColorKey, min: number): void => {
    const ratio = getContrastRatio(theme[fg], theme[bg]);
    if (ratio < min) failures.push(`${fg} on ${bg} ${ratio}:1 < ${min}:1`);
  };
  for (const bg of BACKGROUND_KEYS) {
    for (const fg of TEXT_KEYS) check(fg, bg, 4.5);
    check('borderControl', bg, 3);
  }
  for (const [fg, bg] of LABEL_PAIRS) check(fg, bg, 4.5);
  return {
    canvasPrimaryRatio: getContrastRatio(theme.fgPrimary, theme.bgCanvas),
    surfacePrimaryRatio: getContrastRatio(theme.fgPrimary, theme.bgSurface),
    surfaceSecondaryRatio: getContrastRatio(theme.fgSecondary, theme.bgSurface),
    terminalRatio: getContrastRatio(theme.terminalFg, theme.terminalBg),
    failures,
    passesAA: failures.length === 0
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
