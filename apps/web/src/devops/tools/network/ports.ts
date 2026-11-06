/**
 * Listening ports: every TCP and UDP listener, how widely it is exposed and
 * which process owns it.
 *
 * `ss` is the source; `netstat` is used only when `ss` is not installed. The
 * owning process of a socket that belongs to another user is visible only to
 * root, so without root those cells stay null and the result is partial.
 */
import { isCommandMissing, isPermissionDenied, makeResult, runEvidence } from '../../exec.js';
import type { DevOpsTool, Finding, ResultTable, ToolResult } from '../../types.js';
import { SBIN_PATH, firstLine, shScript, splitSections } from '../system/shell-script.js';

export type ListenerExposure = 'all' | 'loopback' | 'address' | 'interface';

export interface ListenerProcess {
  name: string;
  pid: number;
}

export interface Listener {
  /** `tcp` or `udp`; netstat's `tcp6`/`udp6` are folded in. */
  protocol: string;
  /** LISTEN/UNCONN as reported, or null when the source has no state column. */
  state: string | null;
  /** Address without brackets; `*` is kept as reported. */
  address: string;
  port: number;
  /** Interface after `%`, e.g. `lo` in `127.0.0.53%lo`. */
  scope: string | null;
  exposure: ListenerExposure;
  /** Empty when the owner is not visible (or the socket has none). */
  processes: ListenerProcess[];
}

export interface ListenerParse {
  listeners: Listener[];
  /** Data lines that did not have the expected shape. */
  unparsed: string[];
}

const PORTS_SCRIPT =
  `export LC_ALL=C; ${SBIN_PATH}; echo "@@WEBSSH:uid $(id -u)"; ` +
  'if command -v ss >/dev/null 2>&1; then echo @@WEBSSH:ss; ss -tulpn; ' +
  'else echo @@WEBSSH:netstat; netstat -tulpnW; fi';

/** `ss -tulpn` rather than `-H`: iproute2 before 4.15 has no `-H`, and the header is skipped here. */
export const LISTENING_PORTS_COMMAND = shScript(PORTS_SCRIPT);

const WILDCARDS = new Set(['*', '0.0.0.0', '::']);

function exposureOf(address: string, scope: string | null): ListenerExposure {
  const a = address.toLowerCase();
  if (WILDCARDS.has(a)) return scope ? 'interface' : 'all';
  if (/^127\./.test(a) || a === '::1' || /^::ffff:127\./.test(a)) return 'loopback';
  return 'address';
}

/** `127.0.0.53%lo:53`, `[fe80::1]%eth0:8080`, `:::22`, `*:80` → parts, or null. */
function splitEndpoint(text: string): { address: string; scope: string | null; port: number } | null {
  const colon = text.lastIndexOf(':');
  if (colon <= 0) return null;
  const portText = text.slice(colon + 1);
  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port > 65535) return null;
  let host = text.slice(0, colon);
  let scope: string | null = null;
  const percent = host.indexOf('%');
  if (percent >= 0) {
    scope = host.slice(percent + 1) || null;
    host = host.slice(0, percent);
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || !/^[0-9A-Fa-f:.*]+$/.test(host)) return null;
  return { address: host, scope, port };
}

function uniqueProcesses(processes: ListenerProcess[]): ListenerProcess[] {
  const byPid = new Map<number, ListenerProcess>();
  for (const p of processes) if (!byPid.has(p.pid)) byPid.set(p.pid, p);
  return [...byPid.values()].sort((a, b) => a.pid - b.pid);
}

// `("nginx",pid=1,fd=6)` and the pre-3.15 form `("nginx",1,6)`. The name is
// matched lazily so names containing quotes or commas still parse.
const SS_OWNER = /\("(.*?)",(?:pid=)?(\d+),(?:fd=)?\d+\)/g;

function isDataLine(line: string): boolean {
  return /^(tcp|udp)/i.test(line.trim());
}

/** Parse `ss -tulpn` output (with or without its header). Exported for the topology diagrams. */
export function parseSsListeners(text: string): ListenerParse {
  const listeners: Listener[] = [];
  const unparsed: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^Netid\b/i.test(line) || /^State\b/i.test(line)) continue;
    const tokens = line.split(/\s+/);
    const endpoint = tokens.length >= 6 ? splitEndpoint(tokens[4]!) : null;
    if (!isDataLine(line) || !endpoint) {
      unparsed.push(raw);
      continue;
    }
    const ownerAt = line.indexOf('users:(');
    const processes =
      ownerAt < 0
        ? []
        : uniqueProcesses(
            [...line.slice(ownerAt).matchAll(SS_OWNER)].map((m) => ({ name: m[1]!, pid: Number(m[2]) }))
          );
    listeners.push({
      protocol: tokens[0]!.toLowerCase().replace(/6$/, ''),
      state: tokens[1] ?? null,
      address: endpoint.address,
      port: endpoint.port,
      scope: endpoint.scope,
      exposure: exposureOf(endpoint.address, endpoint.scope),
      processes
    });
  }
  return { listeners, unparsed };
}

/** Parse net-tools `netstat -tulpn[W]`. UDP rows have no State column. */
export function parseNetstatListeners(text: string): ListenerParse {
  const listeners: Listener[] = [];
  const unparsed: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !isDataLine(line)) continue;
    const tokens = line.split(/\s+/);
    const endpoint = tokens.length >= 6 ? splitEndpoint(tokens[3]!) : null;
    if (!endpoint) {
      unparsed.push(raw);
      continue;
    }
    const ownerStart = /^(\d+\/|-$)/.test(tokens[5]!) ? 5 : 6;
    const state = ownerStart === 6 ? tokens[5]! : null;
    const owner = tokens.slice(ownerStart).join(' ');
    const slash = owner.indexOf('/');
    const pid = slash > 0 ? Number(owner.slice(0, slash)) : NaN;
    const processes = Number.isInteger(pid) ? [{ name: owner.slice(slash + 1).trim(), pid }] : [];
    listeners.push({
      protocol: tokens[0]!.toLowerCase().replace(/6$/, ''),
      state,
      address: endpoint.address,
      port: endpoint.port,
      scope: endpoint.scope,
      exposure: exposureOf(endpoint.address, endpoint.scope),
      processes
    });
  }
  return { listeners, unparsed };
}

function displayAddress(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

const EXPOSURE_LABEL: Record<ListenerExposure, string> = {
  all: 'All interfaces',
  loopback: 'Loopback only',
  address: 'Specific address',
  interface: 'One interface'
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortListeners(listeners: Listener[]): Listener[] {
  return [...listeners].sort(
    (a, b) =>
      a.port - b.port ||
      compareText(a.protocol, b.protocol) ||
      compareText(displayAddress(a.address), displayAddress(b.address)) ||
      compareText(a.scope ?? '', b.scope ?? '')
  );
}

function processNames(processes: ListenerProcess[]): string {
  return [...new Set(processes.map((p) => p.name))].join(', ');
}

function listenerTable(listeners: Listener[], isRoot: boolean): ResultTable {
  return {
    id: 'listeners',
    title: 'Listening sockets',
    columns: [
      { key: 'protocol', label: 'Protocol' },
      { key: 'address', label: 'Address' },
      { key: 'port', label: 'Port', numeric: true },
      { key: 'interface', label: 'Interface' },
      { key: 'exposure', label: 'Exposure' },
      { key: 'process', label: 'Process' },
      { key: 'pid', label: 'PID' }
    ],
    rows: sortListeners(listeners).map((l) => {
      const owned = l.processes.length > 0;
      return {
        protocol: l.protocol,
        address: displayAddress(l.address),
        port: l.port,
        interface: l.scope ?? '',
        exposure: EXPOSURE_LABEL[l.exposure],
        // Without root an empty owner list means "not visible", never "none".
        process: owned ? processNames(l.processes) : isRoot ? 'no owning process' : null,
        pid: owned ? l.processes.map((p) => p.pid).join(', ') : isRoot ? '' : null
      };
    })
  };
}

function exposureFindings(listeners: Listener[]): Finding[] {
  const groups = new Map<string, Listener[]>();
  for (const l of sortListeners(listeners)) {
    if (l.exposure !== 'all') continue;
    const key = `${l.protocol}/${l.port}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const findings: Finding[] = [];
  for (const [key, group] of groups) {
    const addresses = [...new Set(group.map((l) => displayAddress(l.address)))].join(' and ');
    const processes = uniqueProcesses(group.flatMap((l) => l.processes));
    const owner =
      processes.length > 0
        ? `process ${processes.map((p) => `${p.name} (pid ${p.pid})`).join(', ')}`
        : 'owning process not visible without root';
    findings.push({
      severity: 'warning',
      title: `${key} listens on all interfaces`,
      detail: `Bound to ${addresses}; ${owner}.`,
      subject: `${displayAddress(group[0]!.address)}:${group[0]!.port}`
    });
  }
  return findings;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function buildPortsResult(stdout: string, stderr: string, exitCode: number): Omit<ToolResult, 'evidence' | 'collectedAt'> {
  const { sections } = splitSections(stdout);
  const uid = sections.find((s) => s.tag === 'uid')?.arg ?? '';
  const isRoot = uid === '0';
  const source = sections.find((s) => s.tag === 'ss' || s.tag === 'netstat');
  const notes: string[] = [];
  if (source?.tag === 'netstat') notes.push('ss is not installed; listeners come from netstat.');

  const parsed = source
    ? source.tag === 'ss'
      ? parseSsListeners(source.lines.join('\n'))
      : parseNetstatListeners(source.lines.join('\n'))
    : { listeners: [], unparsed: [] };
  const shell = (summary: string, status: ToolResult['status']) => ({
    status,
    summary,
    findings: [],
    tables: [],
    notes
  });

  if (source?.tag === 'netstat' && isCommandMissing(exitCode, stderr)) {
    return shell('Neither ss nor netstat is installed on this server.', 'unavailable');
  }
  // Some netstat builds reject the options on stderr and still exit 0; an
  // empty table is only an answer when the tool did not complain.
  if (parsed.listeners.length === 0 && (exitCode !== 0 || stderr.trim() !== '')) {
    const reason = firstLine(stderr) || firstLine(stdout) || `exit ${exitCode}`;
    if (isPermissionDenied(stderr)) {
      notes.push(`The socket table could not be read: ${reason}`);
      return shell('Reading the socket table requires root on this server.', 'partial');
    }
    return shell(`The socket probe failed: ${reason}`, 'error');
  }

  const { listeners, unparsed } = parsed;
  let status: ToolResult['status'] = 'ok';
  const ownerless = listeners.filter((l) => l.processes.length === 0).length;
  if (ownerless > 0 && isRoot) {
    notes.push(`${plural(ownerless, 'listener has', 'listeners have')} no owning process; kernel-owned sockets have none.`);
  } else if (ownerless > 0) {
    status = 'partial';
    notes.push(
      `${plural(ownerless, 'listener shows', 'listeners show')} no owning process; processes of other users are visible only to root.`
    );
  }
  if (unparsed.length > 0) {
    status = 'partial';
    notes.push(`${plural(unparsed.length, 'line')} of socket output could not be parsed; see the evidence.`);
  }

  const findings = exposureFindings(listeners);
  const loopback = listeners.filter((l) => l.exposure === 'loopback').length;
  if (listeners.length > 0 && findings.length === 0) {
    findings.push({ severity: 'ok', title: 'No listener is bound to all interfaces' });
  }
  if (loopback > 0) {
    findings.push({ severity: 'info', title: `${plural(loopback, 'listener')} bound to loopback only` });
  }
  if (listeners.length === 0) {
    findings.push({ severity: 'info', title: 'No listening TCP or UDP sockets were reported' });
  }

  const exposed = new Set(listeners.filter((l) => l.exposure === 'all').map((l) => `${l.protocol}/${l.port}`)).size;
  return {
    status,
    summary: `${plural(listeners.length, 'listener')}; ${plural(exposed, 'port')} open on all interfaces.`,
    findings,
    tables: [listenerTable(listeners, isRoot)],
    notes
  };
}

export const listeningPortsTool: DevOpsTool = {
  id: 'listening-ports',
  group: 'network',
  title: 'Listening ports',
  description: 'TCP and UDP listeners with their exposure (all interfaces, loopback, one address) and owning process.',
  requires: ['ss (or netstat)'],
  rootForFullData: true,
  preview: () => [LISTENING_PORTS_COMMAND],
  async run(session) {
    const probe = await runEvidence(session, LISTENING_PORTS_COMMAND);
    const result = buildPortsResult(probe.stdout, probe.stderr, probe.exitCode);
    return makeResult(result.status, result.summary, { ...result, evidence: [probe.evidence] });
  }
};
