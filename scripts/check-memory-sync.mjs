// Verify CLAUDE.md / GEMINI.md / AGENTS.md stay identical and point at memory/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md'];
const contents = files.map((f) => fs.readFileSync(path.join(rootDir, f), 'utf8'));

const firstMismatch = contents[0] !== contents[1] || contents[1] !== contents[2];
if (firstMismatch) {
  console.error('Memory sync failed: CLAUDE.md / GEMINI.md / AGENTS.md are not identical.');
  console.error('Keep them identical — edit one and copy to the other two.');
  process.exit(1);
}

for (const chunk of [
  'Synchronized with `memory/MEMORY.md`',
  'Start every session by reading `memory/MEMORY.md`',
]) {
  if (!contents[0].includes(chunk)) {
    console.error(`Memory sync failed: missing "${chunk}" in agent entry files.`);
    process.exit(1);
  }
}

const memoryIndex = fs.readFileSync(path.join(rootDir, 'memory', 'MEMORY.md'), 'utf8');
for (const doc of [
  'ARCHITECTURE_OVERVIEW.md',
  'MODULE_MAP.md',
  'PROTOCOL_DATA_FLOW.md',
  'SECURITY_MODEL.md',
  'UI_DESIGN_SYSTEM.md',
  'DEPLOYMENT_CI.md',
  'WORKSPACE_ADDITIONS_2026-11.md',
  'FEATURE_CLAIMS.md',
]) {
  if (!memoryIndex.includes(doc)) {
    console.error(`Memory sync failed: memory/MEMORY.md does not index ${doc}`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(rootDir, 'memory', doc))) {
    console.error(`Memory sync failed: memory/${doc} missing`);
    process.exit(1);
  }
}

console.log('Memory sync ok: CLAUDE/GEMINI/AGENTS identical and memory index complete.');
