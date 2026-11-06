import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PENDING_UPDATES_COMMAND,
  parseApkVersion,
  parseAptUpgradable,
  parseDnfCheckUpdate,
  parseUpdateinfoSecurity,
  parseZypperLu,
  pendingUpdatesTool
} from './pending-updates.js';
import { fakeSession } from './fake-session.js';

const M = '@@WEBSSH:';
const NOW = 1_715_000_000;

const APT_LIST = [
  'WARNING: apt does not have a stable CLI interface. Use with caution in scripts.',
  '',
  'Listing...',
  'libssl3/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]',
  'openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]',
  'tzdata/jammy-updates 2024a-0ubuntu0.22.04 all [upgradable from: 2023c-0ubuntu0.22.04.2]'
];

const DNF_LIST = [
  '',
  'kernel.x86_64                      5.14.0-427.13.1.el9_4         baseos',
  'openssl-libs.x86_64                1:3.0.7-27.el9                baseos',
  'python3-some-really-long-package-name.noarch',
  '                                   2.4.1-3.el9                   appstream',
  'Obsoleting Packages',
  'grub2-tools.x86_64                 1:2.06-77.el9                 baseos',
  '    grub2-tools.x86_64             1:2.06-70.el9                 @baseos'
];

const DNF_SECURITY = [
  'RHSA-2024:2264 Important/Sec. openssl-libs-1:3.0.7-27.el9.x86_64',
  'RHSA-2024:2394 Moderate/Sec.  kernel-5.14.0-427.13.1.el9_4.x86_64'
];

const ZYPPER = [
  'S | Repository           | Name | Current Version | Available Version | Arch',
  '--+----------------------+------+-----------------+-------------------+-------',
  'v | Main Update Repository | curl | 8.0.1-1.1       | 8.0.1-2.1         | x86_64'
];

const APK = ['Installed:                                Available:', 'busybox-1.36.1-r15                      < 1.36.1-r16', 'musl-1.2.4-r2                           < 1.2.4-r3'];

function out(pm: string, sections: Array<[string, string[], number]>, extra: string[] = [], reboot = 'no'): string {
  const lines = [`${M}reboot ${reboot}`, `${M}pm ${pm}`, ...extra];
  for (const [tag, body, code] of sections) lines.push(`${M}${tag}`, ...body, `${M}exit ${code}`);
  return lines.join('\n') + '\n';
}

function run(stdout: string) {
  const fake = fakeSession({ [PENDING_UPDATES_COMMAND]: { stdout } });
  return { fake, result: pendingUpdatesTool.run(fake.session, {}) };
}

describe('parsers', () => {
  it('reads apt list --upgradable and marks the -security suite', () => {
    const updates = parseAptUpgradable(APT_LIST);
    expect(updates).toHaveLength(3);
    expect(updates[0]).toEqual({
      name: 'libssl3',
      current: '3.0.2-0ubuntu1.14',
      available: '3.0.2-0ubuntu1.15',
      repository: 'jammy-updates,jammy-security',
      arch: 'amd64',
      security: true
    });
    expect(updates[2]!.security).toBe(false);
  });

  it('reads dnf check-update, joins wrapped names and stops at obsoletes', () => {
    const updates = parseDnfCheckUpdate(DNF_LIST);
    expect(updates.map((u) => u.name)).toEqual(['kernel', 'openssl-libs', 'python3-some-really-long-package-name']);
    expect(updates[1]).toEqual({ name: 'openssl-libs', current: null, available: '1:3.0.7-27.el9', repository: 'baseos', arch: 'x86_64', security: null });
  });

  it('reads security advisories from updateinfo', () => {
    expect([...parseUpdateinfoSecurity(DNF_SECURITY)].sort()).toEqual(['kernel', 'openssl-libs']);
    expect(parseUpdateinfoSecurity(['Last metadata expiration check: 0:01:00 ago.']).size).toBe(0);
  });

  it('reads the zypper table without its header', () => {
    expect(parseZypperLu(ZYPPER)).toEqual([
      { name: 'curl', current: '8.0.1-1.1', available: '8.0.1-2.1', repository: 'Main Update Repository', arch: 'x86_64', security: null }
    ]);
  });

  it('splits apk package names from versions', () => {
    expect(parseApkVersion(APK).map((u) => [u.name, u.current, u.available])).toEqual([
      ['busybox', '1.36.1-r15', '1.36.1-r16'],
      ['musl', '1.2.4-r2', '1.2.4-r3']
    ]);
  });
});

describe('pendingUpdatesTool.run', () => {
  it('sends exactly the previewed command, never apt update, with a long timeout', async () => {
    const { fake, result } = run(out('apt', [['list', APT_LIST, 0]], [`${M}age ${NOW} ${NOW - 3600}`]));
    await result;
    expect(fake.commands).toEqual(pendingUpdatesTool.preview({}));
    expect(PENDING_UPDATES_COMMAND).not.toMatch(/apt(-get)? update|upgrade -y|dnf (-\w+ )*upgrade/);
    expect(fake.options[0]!.timeoutMs).toBe(120_000);
  });

  it('apt: security updates are critical, others a warning, reboot a warning', async () => {
    const { result } = run(out('apt', [['list', APT_LIST, 0]], [`${M}age ${NOW} ${NOW - 3600}`], 'yes'));
    const r = await result;
    expect(r.status).toBe('ok');
    expect(r.summary).toBe('apt: 3 pending updates, 2 security; reboot required');
    expect(r.findings.map((f) => [f.severity, f.title])).toEqual([
      ['critical', '2 security updates pending'],
      ['warning', '1 other update pending'],
      ['warning', 'A reboot is required']
    ]);
    expect(r.tables.find((t) => t.id === 'summary')!.rows[0]).toEqual({ manager: 'apt', pending: 3, security: 2, reboot: 'yes', listAge: 0 });
    expect(r.notes.join(' ')).toMatch(/apt update was not run/);
  });

  it('apt: stale lists are a finding; an unreported age stays null', async () => {
    const stale = await run(out('apt', [['list', [], 0]], [`${M}age ${NOW} ${NOW - 10 * 86_400}`])).result;
    expect(stale.findings.map((f) => f.title)).toEqual(['The apt lists are 10 days old']);
    const unknown = await run(out('apt', [['list', [], 0]], [`${M}age ${NOW} `])).result;
    expect(unknown.tables.find((t) => t.id === 'summary')!.rows[0]!.listAge).toBeNull();
    expect(unknown.findings).toEqual([{ severity: 'ok', title: 'No pending updates' }]);
    expect(unknown.notes.join(' ')).toMatch(/age of the apt lists .* not reported/);
  });

  it('dnf: exit 100 means updates exist, and updateinfo marks security', async () => {
    const r = await run(out('dnf', [['list', DNF_LIST, 100], ['security', DNF_SECURITY, 0]])).result;
    expect(r.status).toBe('ok');
    const rows = r.tables.find((t) => t.id === 'updates')!.rows;
    expect(rows.map((row) => [row.package, row.security, row.current])).toEqual([
      ['kernel', 'yes', null],
      ['openssl-libs', 'yes', null],
      ['python3-some-really-long-package-name', 'no', null]
    ]);
  });

  it('dnf: a failed updateinfo is partial and claims no security count', async () => {
    const r = await run(out('dnf', [['list', DNF_LIST, 100], ['security', ['Error: Failed to download metadata'], 1]])).result;
    expect(r.status).toBe('partial');
    expect(r.notes.join(' ')).toMatch(/updateinfo failed \(Error: Failed to download metadata\)/);
    expect(r.tables.find((t) => t.id === 'updates')!.rows.every((row) => row.security === null)).toBe(true);
    expect(r.tables.find((t) => t.id === 'summary')!.rows[0]!.security).toBeNull();
  });

  it('dnf: exit 1 from check-update is an error, not "no updates"', async () => {
    const r = await run(out('dnf', [['list', ['Error: Cannot find a valid baseurl for repo: baseos'], 1], ['security', [], 1]])).result;
    expect(r.status).toBe('error');
    expect(r.summary).toBe('dnf could not list updates: Error: Cannot find a valid baseurl for repo: baseos');
    expect(r.findings).toEqual([]);
  });

  it('zypper and apk report updates without inventing a security split', async () => {
    const zypper = await run(out('zypper', [['list', ZYPPER, 0]])).result;
    expect(zypper.findings.map((f) => f.title)).toEqual(['1 other update pending']);
    expect(zypper.notes.join(' ')).toMatch(/does not classify/);
    const apk = await run(out('apk', [['list', APK, 0]])).result;
    expect(apk.tables.find((t) => t.id === 'summary')!.rows[0]).toMatchObject({ pending: 2, security: null });
  });

  it('permission denied while listing is partial with a note', async () => {
    const r = await run(out('zypper', [['list', ['Permission denied: /var/cache/zypp/raw'], 5]])).result;
    expect(r.status).toBe('partial');
    expect(r.notes.join(' ')).toMatch(/run as root/);
    expect(r.tables).toEqual([]);
  });

  it('no package manager is unavailable', async () => {
    const r = await run(`${M}reboot no\n${M}pm none\n`).result;
    expect(r.status).toBe('unavailable');
    expect(r.findings).toEqual([]);
  });

  it('a transport failure is an error that carries the message', async () => {
    const fake = fakeSession({ [PENDING_UPDATES_COMMAND]: new Error('SSH_EXEC_TIMEOUT: no answer') });
    const r = await pendingUpdatesTool.run(fake.session, {});
    expect(r.status).toBe('error');
    expect(r.summary).toMatch(/SSH_EXEC_TIMEOUT/);
  });
});

// The script itself, run by a real POSIX shell against stub binaries.
describe.skipIf(process.platform === 'win32')('the probe script under /bin/sh', () => {
  const stubs = mkdtempSync(join(tmpdir(), 'pending-updates-'));
  // The command is `sh -c '...'`, so the stub PATH must find sh itself.
  symlinkSync('/bin/sh', join(stubs, 'sh'));
  afterAll(() => rmSync(stubs, { recursive: true, force: true }));

  function stub(name: string, body: string): void {
    const path = join(stubs, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }

  function shell(): string {
    return execFileSync('/bin/sh', ['-c', PENDING_UPDATES_COMMAND], { env: { PATH: stubs }, encoding: 'utf8' });
  }

  it('runs the apt branch and reports the exit code', async () => {
    stub('date', `echo ${NOW}`);
    stub('stat', `echo ${NOW - 86_400}`);
    stub('apt', `[ "$1 $2" = "list --upgradable" ] || exit 9\nprintf '%s\\n' 'Listing...' '${APT_LIST[3]}'`);
    const stdout = shell();
    expect(stdout).toContain(`${M}pm apt`);
    expect(stdout).toContain(`${M}age ${NOW} ${NOW - 86_400}`);
    const r = await run(stdout).result;
    expect(r.summary).toMatch(/^apt: 1 pending update, 1 security/);
  });

  it('runs the dnf branch and keeps exit 100', async () => {
    rmSync(join(stubs, 'apt'));
    stub('dnf', `if [ "$2" = "check-update" ]; then echo 'kernel.x86_64 5.14.0-427.el9 baseos'; exit 100; fi\necho 'RHSA-2024:1 Important/Sec. kernel-5.14.0-427.el9.x86_64'`);
    const stdout = shell();
    expect(stdout).toContain(`${M}exit 100`);
    const r = await run(stdout).result;
    expect(r.status).toBe('ok');
    expect(r.findings[0]!.title).toBe('1 security update pending');
  });
});
