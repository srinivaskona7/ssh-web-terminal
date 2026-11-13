import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const TARGET_DIRS = [
  path.join(rootDir, 'packages', 'ui-kit', 'src'),
  path.join(rootDir, 'apps', 'web', 'src')
];

const EXEMPT_PATH_SEGMENTS = [
  path.join('packages', 'ui-kit', 'src', 'generated'),
  '.test.ts',
  '.test.tsx'
];

const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RAW_STYLE_DIMENSION_RE = /\b(?:border-radius|padding|margin|gap|font-size)\s*:\s*(?!0\b|var\(|calc\(|inherit|unset|auto)[0-9]+px\b/g;

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (/\.(css|tsx|ts)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

let violations = [];

for (const dir of TARGET_DIRS) {
  for (const file of walk(dir)) {
    if (EXEMPT_PATH_SEGMENTS.some((seg) => file.includes(seg))) continue;
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(NL);
    lines.forEach((line, idx) => {
      if (line.includes('lint-tokens-ignore')) return;
      if (file.endsWith('.css')) {
        const hexMatches = line.match(HEX_COLOR_RE);
        if (hexMatches) {
          violations.push(`${path.relative(rootDir, file)}:${idx + 1} Forbidden hardcoded hex color in CSS: ${hexMatches.join(', ')}`);
        }
        const dimMatches = line.match(RAW_STYLE_DIMENSION_RE);
        if (dimMatches) {
          violations.push(`${path.relative(rootDir, file)}:${idx + 1} Forbidden hardcoded px value in CSS (use token var): ${dimMatches.join(', ')}`);
        }
      } else if (file.endsWith('.tsx')) {
        const hexMatches = line.match(HEX_COLOR_RE);
        if (hexMatches) {
          violations.push(`${path.relative(rootDir, file)}:${idx + 1} Forbidden hardcoded hex color in TSX component: ${hexMatches.join(', ')}`);
        }
      }
    });
  }
}

// A var(--x) that nothing declares resolves to nothing, silently: the declaration drops to its initial
// value. Declarations come from every stylesheet (generated tokens included) and from '--x' literals in
// code, which covers setProperty('--x', …) and style={{ '--x': … }}.
const declared = new Set();
const uses = [];
for (const dir of TARGET_DIRS) {
  for (const file of walk(dir)) {
    const content = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.css')) {
      for (const m of content.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]);
      content.split(NL).forEach((line, idx) => {
        if (line.includes('lint-tokens-ignore')) return;
        for (const m of line.matchAll(/var\(\s*(--[\w-]+)/g)) uses.push([file, idx + 1, m[1]]);
      });
    } else {
      for (const m of content.matchAll(/['"`](--[\w-]+)['"`]/g)) declared.add(m[1]);
    }
  }
}
for (const [file, line, name] of uses) {
  if (!declared.has(name)) violations.push(`${path.relative(rootDir, file)}:${line} Undefined custom property: ${name}`);
}

if (violations.length > 0) {
  console.error('Design Token Lint Violations Found:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
} else {
  console.log('Token lint passed: 0 hardcoded design values and 0 undefined custom properties in UI components and stylesheets.');
}
