#!/usr/bin/env node
// Fails when a tracked text file contains CRLF line endings.
//
// .gitattributes normalizes line endings on commit, but an editor or a scripted
// patch can still write CRLF into the working tree. A file with mixed or CRLF
// endings turns a three-line patch into a whole-file diff, so the check reads
// the working tree, not the index.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|pdf|zip|gz|tgz|wasm)$/i;

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const offenders = [];
let checked = 0;
for (const file of tracked) {
  if (BINARY_EXTENSIONS.test(file)) continue;
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    // Deleted in the working tree but still in the index; nothing to check.
    continue;
  }
  if (bytes.includes(0)) continue;
  checked += 1;
  if (bytes.includes('\r\n')) offenders.push(file);
}

if (offenders.length > 0) {
  console.error(`CRLF line endings in ${offenders.length} tracked file(s):`);
  for (const file of offenders) console.error(`  ${file}`);
  console.error('Convert them to LF; .gitattributes keeps them LF from then on.');
  process.exit(1);
}

console.log(`Line endings: ${checked} tracked text files checked, all LF.`);
