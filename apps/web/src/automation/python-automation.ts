import { posixQuote } from '../recipes/engine.js';
import type { RemoteSession } from '../session/remote-session.js';

/**
 * Python automation center: interpreter discovery, virtual environments,
 * reviewed execution, and cron scheduling.
 *
 * Generated scripts are always shown before they are scheduled, and scheduled
 * entries carry a marker comment so they can be listed and removed precisely.
 */

export const CRON_MARKER_PREFIX = '# webssh-job:';

export interface PythonEnvironment {
  version: string;
  path: string;
  venvAvailable: boolean;
  pipAvailable: boolean;
}

export interface CronEntry {
  id: string;
  schedule: string;
  command: string;
  comment?: string;
  raw: string;
  managed: boolean;
}

const SCRIPT_PATH = /^(?:\/|~\/)[^\u0000-\u001f]*$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{3,63}$/;

export function validateScriptPath(path: string): string {
  const trimmed = path.trim();
  if (!SCRIPT_PATH.test(trimmed)) {
    throw new Error('Script path must be absolute or start with ~/ and contain no control characters');
  }
  return trimmed;
}

export function validateVenvPath(path: string): string {
  return validateScriptPath(path);
}

export function buildArgvLine(argv: string[]): string {
  return argv.map(posixQuote).join(' ');
}

/** Validate a five-field cron expression. */
export function validateCronSchedule(schedule: string): string {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron schedule must have exactly five fields (minute hour day month weekday)');
  }
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7]
  ];
  fields.forEach((field, index) => {
    if (!/^[0-9*\/,\-]+$/.test(field)) {
      throw new Error(`Cron field ${index + 1} contains unsupported characters`);
    }
    const [min, max] = ranges[index]!;
    for (const part of field.split(',')) {
      const [range, step] = part.split('/');
      const [lo, hi] = (range ?? '').split('-');
      const check = (value: string | undefined): void => {
        if (value === undefined || value === '*' || value === '') return;
        const n = Number(value);
        if (!Number.isInteger(n) || n < min || n > max) {
          throw new Error(`Cron field ${index + 1} value "${value}" is outside ${min}-${max}`);
        }
      };
      check(lo);
      if (hi !== undefined) {
        check(hi);
        if (Number(hi) < Number(lo)) {
          throw new Error(`Cron field ${index + 1} has a descending range`);
        }
      }
      if (step !== undefined) {
        const s = Number(step);
        if (!Number.isInteger(s) || s < 1) {
          throw new Error(`Cron field ${index + 1} has an invalid step`);
        }
      }
    }
  });
  return fields.join(' ');
}

export function parseCrontab(text: string): CronEntry[] {
  const entries: CronEntry[] = [];
  let pendingMarker: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(CRON_MARKER_PREFIX)) {
      pendingMarker = trimmed.slice(CRON_MARKER_PREFIX.length).trim();
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
    if (!match) continue;
    entries.push({
      id: pendingMarker ?? `cron-${entries.length + 1}`,
      schedule: match[1]!,
      command: match[2]!,
      raw: trimmed,
      managed: Boolean(pendingMarker)
    });
    pendingMarker = undefined;
  }
  return entries;
}

export function addCronEntry(
  current: string,
  entry: { id: string; schedule: string; command: string; comment?: string }
): string {
  if (!ID_RE.test(entry.id)) throw new Error(`Invalid automation id "${entry.id}"`);
  const schedule = validateCronSchedule(entry.schedule);
  if (/[\r\n]/.test(entry.command)) throw new Error('Cron command must be a single line');
  const marker = `${CRON_MARKER_PREFIX}${entry.id}`;
  const existing = current.trim().length > 0 ? `${current.replace(/\s+$/, '')}\n` : '';
  const comment = entry.comment ? `# ${entry.comment.replace(/[\r\n]/g, ' ')}\n` : '';
  return `${existing}${marker}\n${comment}${schedule} ${entry.command}\n`;
}

export function removeCronEntry(current: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid automation id "${id}"`);
  const lines = current.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === `${CRON_MARKER_PREFIX}${id}`) {
      skipping = true;
      continue;
    }
    if (skipping) {
      // Skip the optional comment and exactly one schedule line.
      if (line.trim().startsWith('#')) continue;
      skipping = false;
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Build the shell script a detached automation job runs. */
export function buildAutomationScript(input: {
  workdir: string;
  interpreter: string;
  script: string;
  args?: string[];
  env?: Record<string, string>;
}): string {
  const parts: string[] = ['#!/bin/sh', 'set -u', `cd ${posixQuote(input.workdir)} || exit 1`];
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name "${key}"`);
    }
    parts.push(`export ${key}=${posixQuote(value)}`);
  }
  const argv = [input.interpreter, input.script, ...(input.args ?? [])];
  parts.push(buildArgvLine(argv));
  return parts.join('\n');
}

export class PythonAutomation {
  constructor(private readonly session: RemoteSession) {}

  async detect(): Promise<PythonEnvironment | null> {
    const result = await this.session.exec(
      'command -v python3 >/dev/null 2>&1 && python3 --version && python3 -c "import venv, ensurepip" >/dev/null 2>&1; echo "venv:$?"',
      { timeoutMs: 20_000 }
    );
    if (result.exitCode !== 0 && !result.stdout.trim()) return null;
    const lines = result.stdout.trim().split(/\r?\n/);
    const version = (lines[0] ?? '').replace(/^Python\s+/, '');
    const venvCode = Number.parseInt((lines[1] ?? '').replace('venv:', ''), 10);
    const pathResult = await this.session.exec('command -v python3', { timeoutMs: 10_000 });
    const pip = await this.session.exec('python3 -m pip --version', { timeoutMs: 20_000 });
    if (!version) return null;
    return {
      version,
      path: pathResult.stdout.trim(),
      venvAvailable: venvCode === 0,
      pipAvailable: pip.exitCode === 0
    };
  }

  async createVenv(path: string): Promise<string> {
    const safePath = validateVenvPath(path);
    const result = await this.session.exec(
      `python3 -m venv ${posixQuote(safePath)}`,
      { timeoutMs: 5 * 60_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error(`Creating the virtual environment failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return (result.stdout + result.stderr).trim() || `Created ${safePath}`;
  }

  async installRequirements(venvPath: string, workdir: string, file = 'requirements.txt'): Promise<string> {
    const safeVenv = validateVenvPath(venvPath);
    const safeDir = validateScriptPath(workdir);
    if (/[\u0000-\u001f]/.test(file)) throw new Error('Invalid requirements file name');
    const result = await this.session.exec(
      `cd ${posixQuote(safeDir)} && ${posixQuote(`${safeVenv}/bin/python`)} -m pip install --requirement ${posixQuote(file)}`,
      { timeoutMs: 30 * 60_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error(`pip install failed: ${(result.stderr || result.stdout).slice(-3000)}`);
    }
    return result.stdout.slice(-4000);
  }

  async readCrontab(): Promise<CronEntry[]> {
    const result = await this.session.exec('crontab -l 2>/dev/null || true', { timeoutMs: 20_000 });
    return parseCrontab(result.stdout);
  }

  private async writeCrontab(content: string): Promise<void> {
    const bytes = new TextEncoder().encode(content);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const b64 = btoa(binary);
    const result = await this.session.exec(
      `printf %s ${posixQuote(b64)} | base64 -d | crontab -`,
      { timeoutMs: 30_000 }
    );
    if (result.exitCode !== 0) {
      throw new Error(`Updating crontab failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }

  async schedule(entry: { id: string; schedule: string; command: string; comment?: string }): Promise<void> {
    const current = await this.session.exec('crontab -l 2>/dev/null || true', { timeoutMs: 20_000 });
    const next = addCronEntry(current.stdout, entry);
    await this.writeCrontab(next);
  }

  async unschedule(id: string): Promise<void> {
    const current = await this.session.exec('crontab -l 2>/dev/null || true', { timeoutMs: 20_000 });
    const next = removeCronEntry(current.stdout, id);
    await this.writeCrontab(next);
  }
}
