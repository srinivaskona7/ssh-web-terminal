// Disposable-host verification helper (Step 20.8).
// Usage: WEBSSH_HOST=1.2.3.4 WEBSSH_USER=ec2-user node scripts/verify-real-server.mjs
// Probes a real host over SSH and prints a checklist. Does NOT fake results:
// failures are reported as failures. Intended to be run manually with creds
// from the environment, never hardcoded.
import { spawnSync } from 'node:child_process';

const host = process.env.WEBSSH_HOST;
const user = process.env.WEBSSH_USER ?? 'ec2-user';
const port = process.env.WEBSSH_PORT ?? '22';
if (!host) {
  console.error('Set WEBSSH_HOST (and optionally WEBSSH_USER, WEBSSH_PORT).');
  process.exit(2);
}
const target = `${user}@${host}`;
const checks = [
  ['uname -s', 'Linux'],
  ['pwd', '/'],
  ['printf hello', 'hello'],
  ['sh -c "exit 3"', null, 3],
];

let failed = 0;
for (const [cmd, expect, code] of checks) {
  const res = spawnSync('ssh', ['-p', port, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', target, cmd], { encoding: 'utf8', timeout: 15000 });
  const ok = (code ? res.status === code : (res.stdout ?? '').includes(expect ?? ''));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ssh ${target} "${cmd}"  exit=${res.status} out=${(res.stdout ?? '').trim().slice(0, 80)}`);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed} check(s) failed — do not mark Verified.` : '\nAll checks passed — update docs/FEATURES.md with proof.');
process.exit(failed ? 1 : 0);
