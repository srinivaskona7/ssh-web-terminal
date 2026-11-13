#!/usr/bin/env node
// Fails when a stylesheet declares a property the browser does not know.
//
// CSS property names are case-insensitive, so `overflowWrap` is parsed as
// `overflowwrap`, matches nothing, and the declaration is dropped: the rule
// still parses, still ships, and silently does nothing. The camelCase spelling
// only works in a JS style object, never in a stylesheet.
//
// esbuild already knows the CSS property set and reports the exact position
// plus the intended spelling, so it is used as the oracle here instead of a
// hand-rolled property list that would rot.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const NL = String.fromCharCode(10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'test-results', 'playwright-report']);

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(fullPath, files);
    } else if (entry.name.endsWith('.css')) {
      files.push(fullPath);
    }
  }
  return files;
}

const violations = [];
let checked = 0;

for (const file of walk(rootDir)) {
  const content = fs.readFileSync(file, 'utf8');
  if (!content.trim()) continue;
  checked += 1;
  let result;
  try {
    result = transformSync(content, {
      loader: 'css',
      logLevel: 'silent',
      sourcefile: file
    });
  } catch (err) {
    violations.push(`${path.relative(rootDir, file)} CSS failed to parse: ${err.message}`);
    continue;
  }
  for (const warning of result.warnings) {
    if (warning.id !== 'unsupported-css-property') continue;
    const line = warning.location?.line ?? 0;
    const column = warning.location?.column ?? 0;
    const suggestion = warning.location?.suggestion;
    violations.push(
      `${path.relative(rootDir, file)}:${line}:${column} Unknown CSS property${suggestion ? ` (use "${suggestion}")` : ''}`
    );
  }
}

if (violations.length > 0) {
  console.error(`Unknown CSS properties found in ${violations.length} place(s):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error('Stylesheets use the kebab-case spelling; the camelCase form is silently dropped by browsers.');
  process.exit(1);
}

console.log(`CSS lint passed: ${checked} stylesheet(s) checked, no unknown properties.`);
