/**
 * Server control centre probes and actions.
 *
 * Every value here is read from the server with one bounded POSIX script.
 * Nothing is estimated: when a probe is unavailable the field is `null` and the
 * caller must render "not reported" instead of a plausible-looking number.
 */
import { posixQuote } from '../recipes/engine.js';
import type { RemoteSession } from '../session/remote-session.js';

export interface ServerMetrics {
  /** CPU busy percentage over the sample window, or null when /proc is unavailable. */
  cpuPercent: number | null;
  loadAverage: [number, number, number] | null;
  memory: { totalMiB: number; usedMiB: number; availableMiB: number; swapUsedMiB: number } | null;
  disks: Array<{ mount: string; sizeKiB: number; usedKiB: number; availableKiB: number; usedPercent: number }>;
  uptimeSeconds: number | null;
  /** Network receive/transmit in KiB/s over the sample window. */
  network: { rxKiBps: number; txKiBps: number } | null;
  /** Kernel reports pending reboot (Debian/Ubuntu). */
  rebootRequired: boolean | null;
  collectedAt: number;
}

export interface RemoteProcess {
  pid: number;
  user: string;
  cpuPercent: number;
  memoryPercent: number;
  elapsed: string;
  command: string;
}

export interface RemoteService {
  name: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

const METRICS_MARK = '@@CTL';

/** Seconds the probe sleeps between its two counter reads. */
export const NETWORK_SAMPLE_SECONDS = 0.4;

/**
 * One script, one connection round trip. `sleep` gives a real CPU/network delta
 * instead of a lifetime average that never moves.
 */
export function buildMetricsScript(): string {
  return [
    'set -u',
    'read_cpu() { awk \'/^cpu /{print $2+$3+$4+$7+$8, $5}\' /proc/stat; }',
    'read_net() { awk -F\'[: ]+\' \'/^ *eth|^ *en|^ *wl/{rx+=$3; tx+=$11} END{print rx+0, tx+0}\' /proc/net/dev; }',
    'cpu1=$(read_cpu); net1=$(read_net)',
    `sleep ${NETWORK_SAMPLE_SECONDS}`,
    'cpu2=$(read_cpu); net2=$(read_net)',
    `printf '${METRICS_MARK}:cpu %s\\n' "$cpu1|$cpu2"`,
    `printf '${METRICS_MARK}:net %s\\n' "$net1|$net2"`,
    `printf '${METRICS_MARK}:load %s\\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || uptime | sed 's/.*load average: //')"`,
    `printf '${METRICS_MARK}:mem %s\\n' "$(free -m 2>/dev/null | awk '/^Mem:/{print $2, $3, $7} /^Swap:/{print "swap", $3}' | tr '\\n' '|')"`,
    `printf '${METRICS_MARK}:uptime %s\\n' "$(cut -d' ' -f1 /proc/uptime 2>/dev/null || echo '')"`,
    `printf '${METRICS_MARK}:reboot %s\\n' "$([ -f /var/run/reboot-required ] && echo yes || echo no)"`,
    `printf '${METRICS_MARK}:df %s\\n' "$(df -Pk 2>/dev/null | awk 'NR>1 && $2>0 {print $6" "$2" "$3" "$4}' | tr '\\n' '|')"`,
    'exit 0'
  ].join('\n');
}

function parsePair(text: string): [string, string] | null {
  const [a, b] = text.split('|');
  return a && b ? [a, b] : null;
}

export function parseMetricsOutput(stdout: string, collectedAt = Date.now()): ServerMetrics {
  const sections = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(`${METRICS_MARK}:`)) continue;
    const rest = line.slice(METRICS_MARK.length + 1);
    const space = rest.indexOf(' ');
    if (space < 0) continue;
    sections.set(rest.slice(0, space), rest.slice(space + 1));
  }

  let cpuPercent: number | null = null;
  const cpuPair = parsePair(sections.get('cpu') ?? '');
  if (cpuPair) {
    const before = cpuPair[0].trim().split(/\s+/).map(Number);
    const after = cpuPair[1].trim().split(/\s+/).map(Number);
    const totalDelta = (after[0] ?? 0) - (before[0] ?? 0);
    const idleDelta = (after[1] ?? 0) - (before[1] ?? 0);
    if (totalDelta > 0 && Number.isFinite(totalDelta) && Number.isFinite(idleDelta)) {
      cpuPercent = Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100)));
    }
  }

  let network: ServerMetrics['network'] = null;
  const netPair = parsePair(sections.get('net') ?? '');
  if (netPair) {
    const before = netPair[0].trim().split(/\s+/).map(Number);
    const after = netPair[1].trim().split(/\s+/).map(Number);
    const rx = (after[0] ?? 0) - (before[0] ?? 0);
    const tx = (after[1] ?? 0) - (before[1] ?? 0);
    if (Number.isFinite(rx) && Number.isFinite(tx) && rx >= 0 && tx >= 0) {
      // Counters are bytes; the sample window is 0.4 s (NETWORK_SAMPLE_SECONDS).
      network = {
        rxKiBps: Math.round(rx / (NETWORK_SAMPLE_SECONDS * 1024)),
        txKiBps: Math.round(tx / (NETWORK_SAMPLE_SECONDS * 1024))
      };
    }
  }

  let loadAverage: ServerMetrics['loadAverage'] = null;
  const loadParts = (sections.get('load') ?? '').trim().split(/\s+/).map(Number);
  if (loadParts.length >= 3 && loadParts.every(Number.isFinite)) {
    loadAverage = [loadParts[0] ?? 0, loadParts[1] ?? 0, loadParts[2] ?? 0];
  }

  let memory: ServerMetrics['memory'] = null;
  const memParts = (sections.get('mem') ?? '').split('|').map((p) => p.trim()).filter(Boolean);
  const memLine = memParts.find((p) => !p.startsWith('swap'));
  if (memLine) {
    const [total, used, available] = memLine.split(/\s+/).map(Number);
    if (total !== undefined && used !== undefined && available !== undefined && total > 0) {
      const swapLine = memParts.find((p) => p.startsWith('swap'));
      const swapUsed = swapLine ? Number(swapLine.split(/\s+/)[1]) : 0;
      memory = {
        totalMiB: total,
        usedMiB: used,
        availableMiB: available,
        swapUsedMiB: Number.isFinite(swapUsed) ? swapUsed : 0
      };
    }
  }

  const disks: ServerMetrics['disks'] = [];
  for (const row of (sections.get('df') ?? '').split('|')) {
    const parts = row.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    const [mount, size, used, available] = parts;
    if (!mount) continue;
    const sizeKiB = Number(size);
    const usedKiB = Number(used);
    const availableKiB = Number(available);
    if (![sizeKiB, usedKiB, availableKiB].every(Number.isFinite) || sizeKiB <= 0) continue;
    disks.push({
      mount,
      sizeKiB,
      usedKiB,
      availableKiB,
      usedPercent: Math.round((usedKiB / sizeKiB) * 100)
    });
  }

  const uptime = Number((sections.get('uptime') ?? '').trim());
  const reboot = (sections.get('reboot') ?? '').trim();

  return {
    cpuPercent,
    loadAverage,
    memory,
    disks,
    uptimeSeconds: Number.isFinite(uptime) && uptime > 0 ? Math.round(uptime) : null,
    network,
    rebootRequired: reboot === 'yes' ? true : reboot === 'no' ? false : null,
    collectedAt
  };
}

export async function sampleMetrics(session: RemoteSession): Promise<ServerMetrics> {
  const result = await session.exec(buildMetricsScript(), { timeoutMs: 15_000 });
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    throw new Error((result.stderr || result.stdout).trim() || 'Metrics probe failed');
  }
  return parseMetricsOutput(result.stdout);
}

export function parseProcessList(stdout: string): RemoteProcess[] {
  const processes: RemoteProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) continue;
    const [pid, user, cpu, mem, elapsed, ...rest] = parts;
    const pidNum = Number(pid);
    if (!Number.isFinite(pidNum)) continue;
    processes.push({
      pid: pidNum,
      user: user ?? '',
      cpuPercent: Number(cpu) || 0,
      memoryPercent: Number(mem) || 0,
      elapsed: elapsed ?? '',
      command: rest.join(' ')
    });
  }
  return processes;
}

export async function listProcesses(session: RemoteSession, limit = 30): Promise<RemoteProcess[]> {
  const result = await session.exec(
    `ps -eo pid=,user=,pcpu=,pmem=,etime=,args= --sort=-pcpu 2>/dev/null | head -n ${Math.max(1, Math.min(200, limit))}`,
    { timeoutMs: 15_000 }
  );
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || 'ps is unavailable on this server');
  }
  return parseProcessList(result.stdout);
}

export function parseServiceList(stdout: string): RemoteService[] {
  const services: RemoteService[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^●\s*/, '');
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const [name, load, active, sub, ...rest] = parts;
    if (!name || !load || !active || !sub) continue;
    services.push({ name, load, active, sub, description: rest.join(' ') });
  }
  return services;
}

export async function listServices(session: RemoteSession): Promise<RemoteService[]> {
  const result = await session.exec(
    'systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null | head -n 200',
    { timeoutMs: 20_000 }
  );
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || 'systemctl is unavailable on this server');
  }
  return parseServiceList(result.stdout);
}

const SERVICE_NAME = /^[A-Za-z0-9@_.:-]+$/;

export type ServiceAction = 'start' | 'stop' | 'restart';

/**
 * Actions run through `sudo -n` only. Without passwordless sudo the command
 * fails fast and the UI reports the privilege requirement instead of hanging on
 * a prompt that the browser cannot answer.
 */
export async function controlService(
  session: RemoteSession,
  name: string,
  action: ServiceAction,
  asRoot: boolean
): Promise<string> {
  const trimmed = name.trim();
  if (!SERVICE_NAME.test(trimmed)) {
    throw new Error(`Invalid service name "${name}"`);
  }
  const command = `${asRoot ? 'sudo -n ' : ''}systemctl ${action} ${posixQuote(trimmed)}`;
  const result = await session.exec(command, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      (result.stderr || result.stdout).trim() ||
        `systemctl ${action} ${trimmed} failed (exit ${result.exitCode})`
    );
  }
  return result.stdout.trim();
}

export async function serviceLogs(
  session: RemoteSession,
  name: string,
  lines = 100
): Promise<string> {
  const trimmed = name.trim();
  if (!SERVICE_NAME.test(trimmed)) {
    throw new Error(`Invalid service name "${name}"`);
  }
  const result = await session.exec(
    `journalctl -u ${posixQuote(trimmed)} -n ${Math.max(1, Math.min(1000, lines))} --no-pager 2>&1`,
    { timeoutMs: 30_000 }
  );
  return result.stdout;
}

export async function rebootRequiredPackages(session: RemoteSession): Promise<string[]> {
  const result = await session.exec(
    'ls /var/run/reboot-required.pkgs 2>/dev/null && cat /var/run/reboot-required.pkgs 2>/dev/null || true',
    { timeoutMs: 10_000 }
  );
  return result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.includes('reboot-required'));
}

/**
 * Reboot or power off the server. Both are accepted only from a UI that has
 * already required an explicit typed confirmation; the command fails fast when
 * passwordless sudo is not configured.
 */
export async function powerAction(
  session: RemoteSession,
  action: 'reboot' | 'poweroff',
  asRoot: boolean
): Promise<string> {
  const command = `${asRoot ? 'sudo -n ' : ''}systemctl ${action}`;
  const result = await session.exec(command, { timeoutMs: 20_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      (result.stderr || result.stdout).trim() ||
        `systemctl ${action} failed (exit ${result.exitCode}); the connection may have ended, which is expected during a reboot`
    );
  }
  return result.stdout.trim();
}
