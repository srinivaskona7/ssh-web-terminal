#!/usr/bin/env node
/**
 * Type-check the Worker without assuming where TypeScript was installed.
 *
 * Cloudflare Workers Builds runs with the project root set to `apps/relay`.
 * A repo-root `npm ci` hoists TypeScript to the root `node_modules`, while a
 * build that only installed this workspace has it locally — and an install that
 * omitted dev dependencies has neither. Resolve in that order and only then fall
 * back to fetching the pinned compiler, so the build never dies with the
 * unhelpful `tsc: not found`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const relayDir = resolve(here, '..');
// Production builds exclude tests; root CI still checks the test configuration.
const tscArgs = ['-p', resolve(relayDir, 'tsconfig.build.json'), '--noEmit'];

const candidates = [
  resolve(relayDir, '../../node_modules/typescript/bin/tsc'),
  resolve(relayDir, 'node_modules/typescript/bin/tsc')
];

for (const candidate of candidates) {
  if (!existsSync(candidate)) continue;
  const result = spawnSync(process.execPath, [candidate, ...tscArgs], {
    stdio: 'inherit',
    cwd: relayDir
  });
  process.exit(result.status ?? 1);
}

console.log('TypeScript not installed locally; using the pinned compiler via npx.');
const result = spawnSync(
  'npx',
  ['--yes', '--package=typescript@5.7.2', 'tsc', ...tscArgs],
  { stdio: 'inherit', cwd: relayDir }
);
if (result.error) {
  console.error(`Failed to run tsc: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
