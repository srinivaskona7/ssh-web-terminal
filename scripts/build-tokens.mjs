import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const designTokensPath = path.join(rootDir, 'design', 'tokens.json');
const pkgTokensPath = path.join(rootDir, 'packages', 'ui-kit', 'tokens.json');

const pkgTokens = JSON.parse(fs.readFileSync(pkgTokensPath, 'utf8'));
if (fs.existsSync(designTokensPath)) {
  const designTokens = JSON.parse(fs.readFileSync(designTokensPath, 'utf8'));
  pkgTokens.spacing = { ...pkgTokens.spacing, ...designTokens.spacing };
  pkgTokens.radius = { ...pkgTokens.radius, ...designTokens.radius };
  pkgTokens.elevation = { ...pkgTokens.elevation, ...designTokens.elevation };
  pkgTokens.motion = { ...pkgTokens.motion, ...designTokens.motion };
  pkgTokens.typography = { ...pkgTokens.typography, ...designTokens.typography };
  pkgTokens.studio = { ...(pkgTokens.studio || {}), ...(designTokens.studio || {}) };
  pkgTokens.themes = { ...pkgTokens.themes, ...designTokens.themes };
}

function camelToKebab(str) {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function renderThemeVars(theme) {
  const lines = [];
  for (const [key, value] of Object.entries(theme)) {
    if (key === 'ansi' && typeof value === 'object' && value !== null) {
      for (const [ansiKey, ansiVal] of Object.entries(value)) {
        lines.push(`  --color-ansi-${camelToKebab(ansiKey)}: ${ansiVal};`);
      }
    } else {
      lines.push(`  --color-${camelToKebab(key)}: ${value};`);
    }
  }
  return lines.join(NL);
}

const rootLines = [
  '/* Auto-generated from packages/ui-kit/tokens.json — DO NOT EDIT MANUALLY */',
  ':root {'
];

for (const [key, val] of Object.entries(pkgTokens.spacing)) {
  rootLines.push(`  --space-${camelToKebab(key)}: ${val};`);
}
for (const [key, val] of Object.entries(pkgTokens.radius)) {
  rootLines.push(`  --radius-${camelToKebab(key)}: ${val};`);
}
for (const [key, val] of Object.entries(pkgTokens.border)) {
  rootLines.push(`  --border-${camelToKebab(key)}: ${val};`);
}
for (const [key, val] of Object.entries(pkgTokens.elevation)) {
  rootLines.push(`  --elevation-${camelToKebab(key)}: ${val};`);
}
for (const [key, val] of Object.entries(pkgTokens.motion)) {
  rootLines.push(`  --motion-${camelToKebab(key)}: ${val};`);
}
for (const [key, val] of Object.entries(pkgTokens.typography)) {
  rootLines.push(`  --font-${camelToKebab(key)}: ${val};`);
}
if (pkgTokens.studio) {
  for (const [key, val] of Object.entries(pkgTokens.studio)) {
    rootLines.push(`  --studio-${camelToKebab(key)}: ${val};`);
  }
}

rootLines.push(renderThemeVars(pkgTokens.themes.dark));
rootLines.push('}');
rootLines.push('');

for (const [themeName, themeObj] of Object.entries(pkgTokens.themes)) {
  rootLines.push(`[data-theme="${themeName}"] {`);
  rootLines.push(renderThemeVars(themeObj));
  rootLines.push('}');
  rootLines.push('');
}

rootLines.push('@media (prefers-reduced-motion: reduce) {');
rootLines.push('  :root {');
rootLines.push('    --motion-fast: 0ms;');
rootLines.push('    --motion-normal: 0ms;');
rootLines.push('    --motion-max: 0ms;');
rootLines.push('  }');
rootLines.push('}');
rootLines.push('');

const distDir = path.join(rootDir, 'packages', 'ui-kit', 'dist');
const srcGeneratedDir = path.join(rootDir, 'packages', 'ui-kit', 'src', 'generated');
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(srcGeneratedDir, { recursive: true });

const cssContent = rootLines.join(NL);
fs.writeFileSync(path.join(distDir, 'tokens.css'), cssContent, 'utf8');
fs.writeFileSync(path.join(srcGeneratedDir, 'tokens.css'), cssContent, 'utf8');

const themeNames = Object.keys(pkgTokens.themes);
const tsContent = `// Auto-generated from packages/ui-kit/tokens.json — DO NOT EDIT MANUALLY

export interface AnsiPalette {
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

export interface ThemeTokens {
  bgCanvas: string;
  bgSurface: string;
  bgElevated: string;
  bgOverlay: string;
  fgPrimary: string;
  fgSecondary: string;
  fgMuted: string;
  borderSubtle: string;
  borderStrong: string;
  accentPrimary: string;
  accentHover: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
  terminalBg: string;
  terminalFg: string;
  terminalCursor: string;
  terminalSelection: string;
  ansi: AnsiPalette;
}

export type ThemeId = ${themeNames.map((n) => `'${n}'`).join(' | ')};

export const THEME_IDS: readonly ThemeId[] = ${JSON.stringify(themeNames)} as const;

export const TOKENS = ${JSON.stringify(pkgTokens, null, 2)} as const;

export const THEMES: Record<ThemeId, ThemeTokens> = TOKENS.themes;
`;

fs.writeFileSync(path.join(srcGeneratedDir, 'tokens.ts'), tsContent, 'utf8');
console.log(`Built tokens.css and tokens.ts (${themeNames.length} themes).`);
