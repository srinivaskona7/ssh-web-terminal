/**
 * Pending package updates, read from the package manager's own cache. One
 * script detects apt, dnf, yum, zypper or apk and asks it what is upgradable.
 * It never refreshes the apt lists (`apt update`), so the answer is only as
 * fresh as the lists, and the lists' age is reported next to it.
 */
import { isPermissionDenied, makeResult, runEvidence } from '../../exec.js';
import type { DevOpsTool, Finding, ResultTable } from '../../types.js';
import { SBIN_PATH, SECTION_MARK, shScript, splitSections, type ScriptSection } from '../system/shell-script.js';
import { errorText, firstLines } from './json.js';

export type PackageManager = 'apt' | 'dnf' | 'yum' | 'zypper' | 'apk';

export interface PendingUpdate {
  name: string;
  /** Installed version; dnf and yum do not print it. */
  current: string | null;
  available: string;
  repository: string | null;
  arch: string | null;
  /** null when the package manager gives no security classification. */
  security: boolean | null;
}

/** apt lists older than this are reported as stale. */
export const STALE_LIST_DAYS = 7;
export const PENDING_UPDATES_TIMEOUT_MS = 120_000;

const M = SECTION_MARK;
// Each section prints its command's output, then `exit <code>`.
const section = (tag: string, command: string): string => `echo "${M}${tag}"; ${command} 2>&1; echo "${M}exit $?"`;

const SCRIPT = [
  SBIN_PATH,
  `if [ -e /var/run/reboot-required ]; then echo "${M}reboot yes"; else echo "${M}reboot no"; fi`,
  `if command -v apt >/dev/null 2>&1; then echo "${M}pm apt"; echo "${M}age $(date +%s) $(stat -c %Y /var/lib/apt/lists 2>/dev/null)"; ${section('list', 'apt list --upgradable')}`,
  `elif command -v dnf >/dev/null 2>&1; then echo "${M}pm dnf"; ${section('list', 'dnf -q check-update')}; ${section('security', 'dnf -q updateinfo list --security')}`,
  `elif command -v yum >/dev/null 2>&1; then echo "${M}pm yum"; ${section('list', 'yum -q check-update')}; ${section('security', 'yum -q updateinfo list security')}`,
  `elif command -v zypper >/dev/null 2>&1; then echo "${M}pm zypper"; ${section('list', 'zypper -q lu')}`,
  `elif command -v apk >/dev/null 2>&1; then echo "${M}pm apk"; ${section('list', 'apk version -l "<"')}`,
  `else echo "${M}pm none"; fi`
].join('; ');

export const PENDING_UPDATES_COMMAND = shScript(SCRIPT);

/** `openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]` */
export function parseAptUpgradable(lines: string[]): PendingUpdate[] {
  const updates: PendingUpdate[] = [];
  for (const line of lines) {
    const match = /^(\S+?)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from: ([^\]]+)\]/.exec(line.trim());
    if (!match) continue;
    const suites = match[2]!.split(',');
    updates.push({
      name: match[1]!,
      current: match[5]!.trim(),
      available: match[3]!,
      repository: match[2]!,
      arch: match[4]!,
      security: suites.some((suite) => /-security$/.test(suite))
    });
  }
  return updates;
}

/**
 * `dnf/yum check-update`: `name.arch  version  repo`, wrapped onto two lines
 * when the name is long. Obsoletes listed after "Obsoleting Packages" are not
 * updates of their own and are skipped.
 */
export function parseDnfCheckUpdate(lines: string[]): PendingUpdate[] {
  const updates: PendingUpdate[] = [];
  let carry: string[] = [];
  for (const line of lines) {
    if (/^Obsoleting Packages/i.test(line.trim())) break;
    if (/^Security:|^Last metadata/i.test(line.trim())) continue;
    const tokens = [...carry, ...line.trim().split(/\s+/).filter(Boolean)];
    carry = [];
    if (tokens.length === 1 && /\.[A-Za-z0-9_]+$/.test(tokens[0]!)) {
      carry = tokens;
      continue;
    }
    if (tokens.length !== 3) continue;
    const dot = tokens[0]!.lastIndexOf('.');
    if (dot <= 0 || !/^[\d]/.test(tokens[1]!.replace(/^\d+:/, '0'))) continue;
    updates.push({
      name: tokens[0]!.slice(0, dot),
      current: null,
      available: tokens[1]!,
      repository: tokens[2]!,
      arch: tokens[0]!.slice(dot + 1),
      security: null
    });
  }
  return updates;
}

/**
 * `updateinfo list` rows: `RHSA-2024:1234 Important/Sec. openssl-1:3.0.7-27.el9.x86_64`
 * (dnf 5 prints the type and severity as separate columns). Returns the names
 * of packages with a security advisory.
 */
export function parseUpdateinfoSecurity(lines: string[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 3 || !/^[A-Za-z][A-Za-z0-9]*-[\w:.-]*\d/.test(tokens[0]!)) continue;
    const nevra = /^(.+)-(?:\d+:)?[^-]+-[^-]+\.[^.]+$/.exec(tokens[tokens.length - 1]!);
    if (nevra) names.add(nevra[1]!);
  }
  return names;
}

/** `v | Main Update | curl | 8.0.1-1.1 | 8.0.1-2.1 | x86_64` */
export function parseZypperLu(lines: string[]): PendingUpdate[] {
  const updates: PendingUpdate[] = [];
  for (const line of lines) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 6 || cells[2] === 'Name' || /^-+\+/.test(line)) continue;
    updates.push({
      name: cells[2]!,
      current: cells[3] || null,
      available: cells[4]!,
      repository: cells[1] || null,
      arch: cells[5] || null,
      security: null
    });
  }
  return updates;
}

/** `busybox-1.36.1-r15   < 1.36.1-r16` */
export function parseApkVersion(lines: string[]): PendingUpdate[] {
  const updates: PendingUpdate[] = [];
  for (const line of lines) {
    const match = /^(\S+)\s+<\s+(\S+)/.exec(line.trim());
    if (!match) continue;
    const split = /^(.+?)-(\d[^-]*-r\d+)$/.exec(match[1]!);
    updates.push({
      name: split ? split[1]! : match[1]!,
      current: split ? split[2]! : null,
      available: match[2]!,
      repository: null,
      arch: null,
      security: null
    });
  }
  return updates;
}

interface ListSection {
  lines: string[];
  exitCode: number | null;
}

/** The output lines of a section and the exit code its trailer reported. */
function readSection(sections: ScriptSection[], tag: string): ListSection | null {
  const index = sections.findIndex((s) => s.tag === tag);
  if (index < 0) return null;
  const trailer = sections[index + 1];
  const exitCode = trailer?.tag === 'exit' && /^\d+$/.test(trailer.arg) ? Number(trailer.arg) : null;
  return { lines: sections[index]!.lines, exitCode };
}

/** check-update exits 100 when updates exist and 0 when there are none. */
function listSucceeded(pm: PackageManager, exitCode: number | null): boolean {
  if (exitCode === 0) return true;
  return (pm === 'dnf' || pm === 'yum') && exitCode === 100;
}

function parseList(pm: PackageManager, lines: string[]): PendingUpdate[] {
  if (pm === 'apt') return parseAptUpgradable(lines);
  if (pm === 'dnf' || pm === 'yum') return parseDnfCheckUpdate(lines);
  if (pm === 'zypper') return parseZypperLu(lines);
  return parseApkVersion(lines);
}

function names(updates: PendingUpdate[], limit = 10): string {
  const shown = updates.slice(0, limit).map((u) => u.name).join(', ');
  return updates.length > limit ? `${shown} and ${updates.length - limit} more` : shown;
}

export const pendingUpdatesTool: DevOpsTool = {
  id: 'pending-updates',
  group: 'delivery',
  title: 'Pending updates',
  description:
    'Lists upgradable packages from apt, dnf, yum, zypper or apk, marks security updates where the package manager classifies them, and checks whether a reboot is required. Never refreshes the package lists.',
  requires: ['apt, dnf, yum, zypper or apk'],
  preview: () => [PENDING_UPDATES_COMMAND],
  async run(session) {
    let probe: Awaited<ReturnType<typeof runEvidence>>;
    try {
      probe = await runEvidence(session, PENDING_UPDATES_COMMAND, PENDING_UPDATES_TIMEOUT_MS);
    } catch (err) {
      return makeResult('error', `Could not check for updates: ${errorText(err)}`);
    }
    const evidence = [probe.evidence];
    const { sections } = splitSections(probe.stdout);
    const pmArg = sections.find((s) => s.tag === 'pm')?.arg;
    if (!pmArg) {
      return makeResult('error', `The update probe printed no result: ${firstLines(probe.stderr || probe.stdout) || `exit ${probe.exitCode}`}`, { evidence });
    }
    if (pmArg === 'none') {
      return makeResult('unavailable', 'No supported package manager (apt, dnf, yum, zypper, apk) is installed', { evidence });
    }
    const pm = pmArg as PackageManager;
    const reboot = sections.find((s) => s.tag === 'reboot')?.arg;
    const notes: string[] = [];
    const findings: Finding[] = [];

    const list = readSection(sections, 'list');
    if (!list || !listSucceeded(pm, list.exitCode)) {
      const message = firstLines(list?.lines.join('\n') ?? '') || `exit ${list?.exitCode ?? 'not reported'}`;
      const denied = isPermissionDenied(list?.lines.join('\n') ?? '');
      return makeResult(denied ? 'partial' : 'error', `${pm} could not list updates: ${message}`, {
        notes: denied ? [`${pm} needs more privileges on this host to list updates; run as root for a full answer.`] : [],
        evidence
      });
    }
    const updates = parseList(pm, list.lines);
    let status: 'ok' | 'partial' = 'ok';

    if (pm === 'dnf' || pm === 'yum') {
      const security = readSection(sections, 'security');
      if (security && security.exitCode === 0) {
        const securityNames = parseUpdateinfoSecurity(security.lines);
        for (const update of updates) update.security = securityNames.has(update.name);
      } else {
        status = 'partial';
        notes.push(`${pm} updateinfo failed (${firstLines(security?.lines.join('\n') ?? '') || 'no output'}); security updates are not marked.`);
      }
    } else if (pm === 'zypper' || pm === 'apk') {
      notes.push(`${pm} does not classify individual package updates as security fixes here, so none are marked.`);
    }

    let listAgeDays: number | null = null;
    if (pm === 'apt') {
      const [now, mtime] = (sections.find((s) => s.tag === 'age')?.arg ?? '').split(/\s+/).map(Number);
      if (now && mtime && Number.isFinite(now) && Number.isFinite(mtime)) {
        listAgeDays = Math.max(0, Math.floor((now - mtime) / 86_400));
      } else {
        notes.push('The age of the apt lists (/var/lib/apt/lists) was not reported.');
      }
      notes.push('This reads the cached apt lists; apt update was not run, so newer updates may exist.');
    }

    const securityUpdates = updates.filter((u) => u.security === true);
    const otherUpdates = updates.filter((u) => u.security !== true);
    if (securityUpdates.length > 0) {
      findings.push({ severity: 'critical', title: `${securityUpdates.length} security update${securityUpdates.length === 1 ? '' : 's'} pending`, detail: names(securityUpdates) });
    }
    if (otherUpdates.length > 0) {
      findings.push({ severity: 'warning', title: `${otherUpdates.length} other update${otherUpdates.length === 1 ? '' : 's'} pending`, detail: names(otherUpdates) });
    }
    if (reboot === 'yes') {
      findings.push({ severity: 'warning', title: 'A reboot is required', detail: '/var/run/reboot-required exists.', subject: '/var/run/reboot-required' });
    }
    if (listAgeDays !== null && listAgeDays > STALE_LIST_DAYS) {
      findings.push({ severity: 'warning', title: `The apt lists are ${listAgeDays} days old`, detail: 'Run apt update to see current updates.', subject: '/var/lib/apt/lists' });
    }
    if (findings.length === 0) findings.push({ severity: 'ok', title: 'No pending updates' });

    const table: ResultTable = {
      id: 'updates',
      title: 'Upgradable packages',
      columns: [
        { key: 'package', label: 'Package' },
        { key: 'current', label: 'Installed' },
        { key: 'available', label: 'Available' },
        { key: 'repository', label: 'Repository' },
        { key: 'arch', label: 'Arch' },
        { key: 'security', label: 'Security' }
      ],
      rows: [...securityUpdates, ...otherUpdates].map((u) => ({
        package: u.name,
        current: u.current,
        available: u.available,
        repository: u.repository,
        arch: u.arch,
        security: u.security === null ? null : u.security ? 'yes' : 'no'
      }))
    };
    const summaryTable: ResultTable = {
      id: 'summary',
      title: 'Package manager',
      columns: [
        { key: 'manager', label: 'Manager' },
        { key: 'pending', label: 'Pending', numeric: true },
        { key: 'security', label: 'Security', numeric: true },
        { key: 'reboot', label: 'Reboot required' },
        { key: 'listAge', label: 'List age (days)', numeric: true }
      ],
      rows: [
        {
          manager: pm,
          pending: updates.length,
          security: status === 'partial' || pm === 'zypper' || pm === 'apk' ? null : securityUpdates.length,
          reboot: reboot === 'yes' ? 'yes' : reboot === 'no' ? 'no' : null,
          listAge: listAgeDays
        }
      ]
    };
    const summary =
      updates.length === 0
        ? `${pm}: no pending updates${reboot === 'yes' ? '; reboot required' : ''}`
        : `${pm}: ${updates.length} pending update${updates.length === 1 ? '' : 's'}, ${securityUpdates.length} security${reboot === 'yes' ? '; reboot required' : ''}`;
    return makeResult(status, summary, { findings, tables: [summaryTable, table], notes, evidence });
  }
};
