/**
 * Reachability: can this server resolve a name and open a TCP connection to
 * a port? Both checks run on the server, so the answer is the server's view of
 * the network, not the browser's.
 *
 * The connection uses bash's /dev/tcp under `timeout` when both exist, else
 * `nc -z`. Neither sends application data; the socket is closed as soon as it
 * opens.
 */
import { makeResult, runEvidence, validateHost, validatePort } from '../../exec.js';
import type { DevOpsTool, Finding, ResultTable, ToolInput, ToolStatus } from '../../types.js';
import { firstLine, shScript, splitSections } from '../system/shell-script.js';

export const CONNECT_TIMEOUT_S = 5;
const DNS_TIMEOUT_S = 10;

const DNS_SCRIPT =
  `if command -v timeout >/dev/null 2>&1; then exec timeout ${DNS_TIMEOUT_S} getent ahosts "$1"; fi; ` +
  'exec getent ahosts "$1"';

const CONNECT_SCRIPT =
  'if command -v bash >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then ' +
  'echo @@WEBSSH:method bash; echo "@@WEBSSH:t0 $(date +%s%N)"; ' +
  `timeout ${CONNECT_TIMEOUT_S} bash -c '</dev/tcp/$1/$2' bash "$1" "$2" 2>&1; rc=$?; ` +
  'echo "@@WEBSSH:t1 $(date +%s%N)"; ' +
  'elif command -v nc >/dev/null 2>&1; then ' +
  'echo @@WEBSSH:method nc; echo "@@WEBSSH:t0 $(date +%s%N)"; ' +
  `nc -z -v -w ${CONNECT_TIMEOUT_S} "$1" "$2" 2>&1; rc=$?; ` +
  'echo "@@WEBSSH:t1 $(date +%s%N)"; ' +
  'else echo @@WEBSSH:method none; rc=127; fi; echo "@@WEBSSH:rc $rc"';

export type ConnectMethod = 'bash' | 'nc' | 'none';
export type ConnectState = 'open' | 'closed' | 'timed out' | 'unresolved' | 'unreachable';

export interface ConnectProbe {
  method: ConnectMethod | null;
  exitCode: number | null;
  /** What bash or nc printed about the attempt. */
  messages: string[];
  /** Server-side wall time of the attempt; null when `date` has no `%N`. */
  elapsedMs: number | null;
}

export interface AhostsAnswer {
  addresses: string[];
  canonicalName: string | null;
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*(%[\w.-]+)?$/;

/** glibc `getent ahosts`: one line per address and socket type, resolver order kept. */
export function parseGetentAhosts(text: string): AhostsAnswer {
  const addresses: string[] = [];
  let canonicalName: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const [address, , name] = line.trim().split(/\s+/);
    if (!address || (!IPV4.test(address) && !IPV6.test(address))) continue;
    if (addresses.length === 0 && name) canonicalName = name;
    if (!addresses.includes(address)) addresses.push(address);
  }
  return { addresses, canonicalName };
}

function nanoseconds(text: string | undefined): bigint | null {
  return text && /^\d{19,}$/.test(text) ? BigInt(text) : null;
}

export function parseConnectProbe(stdout: string): ConnectProbe {
  const { sections } = splitSections(stdout);
  const arg = (tag: string) => sections.find((s) => s.tag === tag)?.arg;
  const method = arg('method');
  const rc = arg('rc');
  const t0 = nanoseconds(arg('t0'));
  const t1 = nanoseconds(arg('t1'));
  return {
    method: method === 'bash' || method === 'nc' || method === 'none' ? method : null,
    exitCode: rc !== undefined && /^\d+$/.test(rc) ? Number(rc) : null,
    messages: (sections.find((s) => s.tag === 't0')?.lines ?? []).map((l) => l.trim()).filter(Boolean),
    elapsedMs: t0 !== null && t1 !== null && t1 >= t0 ? Math.round(Number(t1 - t0) / 1e5) / 10 : null
  };
}

const UNRESOLVED =
  /name or service not known|temporary failure in name resolution|no address associated|nodename nor servname|could not resolve|unknown host|bad address|name does not resolve|failure in name resolution/i;
const REFUSED = /connection refused/i;
const UNREACHABLE = /no route to host|network is unreachable|host is unreachable/i;
const TIMED_OUT = /timed out|timeout/i;
/** GNU timeout exits 124; BusyBox timeout reports the signal (TERM, then KILL). */
const TIMEOUT_EXITS = new Set([124, 143, 137]);

export function classifyConnect(probe: ConnectProbe): { state: ConnectState | null; reason: string } {
  const text = probe.messages.join('\n');
  const reason = probe.messages[0] ?? (probe.exitCode === null ? 'no exit status' : `exit ${probe.exitCode}`);
  if (probe.exitCode === 0) return { state: 'open', reason };
  if (probe.exitCode === null) return { state: null, reason };
  if (UNRESOLVED.test(text)) return { state: 'unresolved', reason };
  if (REFUSED.test(text)) return { state: 'closed', reason };
  if (UNREACHABLE.test(text)) return { state: 'unreachable', reason };
  if (TIMED_OUT.test(text) || (probe.method === 'bash' && TIMEOUT_EXITS.has(probe.exitCode))) return { state: 'timed out', reason };
  return { state: null, reason };
}

interface Target {
  host: string;
  port: number;
}

function readTarget(input: ToolInput): Target | { error: string } {
  const host = (input.host ?? '').trim();
  const port = (input.port ?? '').trim();
  const error = validateHost(host) ?? validatePort(port);
  return error ? { error } : { host, port: Number(port) };
}

function commandsFor(target: Target): [string, string] {
  return [
    shScript(DNS_SCRIPT, [target.host]),
    shScript(CONNECT_SCRIPT, [target.host, String(target.port)])
  ];
}

function endpoint(target: Target): string {
  return target.host.includes(':') ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`;
}

type DnsAnswer =
  | { kind: 'resolved'; answer: AhostsAnswer }
  | { kind: 'not-found' }
  | { kind: 'missing' }
  | { kind: 'hung' }
  | { kind: 'failed'; reason: string };

function readDns(exitCode: number, stdout: string, stderr: string): DnsAnswer {
  if (exitCode === 0) return { kind: 'resolved', answer: parseGetentAhosts(stdout) };
  // getent: 2 means the key was not found.
  if (exitCode === 2) return { kind: 'not-found' };
  if (exitCode === 127) return { kind: 'missing' };
  if (TIMEOUT_EXITS.has(exitCode)) return { kind: 'hung' };
  return { kind: 'failed', reason: firstLine(stderr) || firstLine(stdout) || `exit ${exitCode}` };
}

const METHOD_LABEL: Record<'bash' | 'nc', string> = { bash: 'bash /dev/tcp', nc: 'nc' };

function addressTable(answer: AhostsAnswer | null): ResultTable {
  return {
    id: 'addresses',
    title: 'Resolved addresses',
    columns: [
      { key: 'address', label: 'Address' },
      { key: 'family', label: 'Family' }
    ],
    rows: (answer?.addresses ?? []).map((address) => ({ address, family: address.includes(':') ? 'IPv6' : 'IPv4' }))
  };
}

function dnsFindings(target: Target, dns: DnsAnswer): Finding[] {
  if (dns.kind === 'not-found') {
    return [{ severity: 'warning', title: `${target.host} does not resolve on the server`, subject: 'getent ahosts' }];
  }
  if (dns.kind === 'hung') {
    return [
      {
        severity: 'warning',
        title: `The DNS lookup for ${target.host} did not finish within ${DNS_TIMEOUT_S} s`,
        detail: 'The configured nameservers are slow or unreachable from the server.'
      }
    ];
  }
  if (dns.kind !== 'resolved') return [];
  const { addresses, canonicalName } = dns.answer;
  // An IP literal "resolves" to itself; that is not worth a finding.
  if (addresses.length === 0 || (addresses.length === 1 && addresses[0] === target.host)) return [];
  const alias = canonicalName && canonicalName !== target.host ? ` (canonical name ${canonicalName})` : '';
  return [{ severity: 'info', title: `${target.host} resolves to ${addresses.join(', ')}${alias}`, subject: 'getent ahosts' }];
}

function connectFinding(target: Target, state: ConnectState, reason: string): Finding {
  const ep = endpoint(target);
  switch (state) {
    case 'open':
      return { severity: 'ok', title: `${ep} accepts TCP connections from the server` };
    case 'closed':
      return {
        severity: 'warning',
        title: `${ep} refused the connection`,
        detail: 'The host answered, but nothing accepts connections on that port, or a firewall rejects them.'
      };
    case 'timed out':
      return {
        severity: 'warning',
        title: `No answer from ${ep} within ${CONNECT_TIMEOUT_S} s`,
        detail: 'A firewall may be dropping the packets, or the host is down.'
      };
    case 'unresolved':
      return { severity: 'warning', title: `${target.host} does not resolve on the server`, detail: reason };
    case 'unreachable':
      return { severity: 'warning', title: `No route from the server to ${target.host}`, detail: reason };
  }
}

function connectSummary(target: Target, state: ConnectState, elapsedMs: number | null): string {
  const ep = endpoint(target);
  switch (state) {
    case 'open':
      return elapsedMs === null ? `${ep} is open.` : `${ep} is open (${elapsedMs} ms from the server).`;
    case 'closed':
      return `${ep} refused the connection.`;
    case 'timed out':
      return `No answer from ${ep} within ${CONNECT_TIMEOUT_S} s.`;
    case 'unresolved':
      return `${target.host} does not resolve on the server.`;
    case 'unreachable':
      return `No route from the server to ${target.host}.`;
  }
}

export const reachabilityTool: DevOpsTool = {
  id: 'reachability',
  group: 'network',
  title: 'Reachability',
  description: 'Resolve a name and open a TCP connection to a port from the server, with the method used and the connect time.',
  requires: ['getent', 'bash and timeout (or nc)'],
  inputs: [
    { key: 'host', label: 'Host', placeholder: 'db.internal', required: true, validate: validateHost },
    { key: 'port', label: 'Port', placeholder: '5432', required: true, validate: validatePort }
  ],
  preview(input) {
    const target = readTarget(input);
    return 'error' in target ? [] : commandsFor(target);
  },
  async run(session, input) {
    const target = readTarget(input);
    if ('error' in target) return makeResult('error', target.error);
    const [dnsCommand, connectCommand] = commandsFor(target);
    const dnsRun = await runEvidence(session, dnsCommand);
    const connectRun = await runEvidence(session, connectCommand);
    const evidence = [dnsRun.evidence, connectRun.evidence];

    const dns = readDns(dnsRun.exitCode, dnsRun.stdout, dnsRun.stderr);
    const notes: string[] = [];
    let status: ToolStatus = 'ok';
    if (dns.kind === 'missing') notes.push('getent is not installed; resolved addresses are not reported.');
    if (dns.kind === 'failed') notes.push(`The DNS lookup failed: ${dns.reason}`);
    if (dns.kind === 'missing' || dns.kind === 'failed' || dns.kind === 'hung') status = 'partial';
    const findings = dnsFindings(target, dns);
    const addresses =
      dns.kind === 'resolved' ? [addressTable(dns.answer)] : dns.kind === 'not-found' ? [addressTable(null)] : [];

    const probe = parseConnectProbe(connectRun.stdout);
    if (probe.method === 'none') {
      return makeResult('unavailable', 'Neither bash with timeout nor nc is installed on this server, so the port cannot be tested.', {
        findings,
        tables: addresses,
        notes,
        evidence
      });
    }
    if (probe.method === null) {
      const reason = firstLine(connectRun.stderr) || `exit ${connectRun.exitCode}`;
      return makeResult('error', `The connection test did not run: ${reason}`, { findings, tables: addresses, notes, evidence });
    }

    const { state, reason } = classifyConnect(probe);
    const connectMs = state === 'open' ? probe.elapsedMs : null;
    const connection: ResultTable = {
      id: 'connection',
      title: 'TCP connection from the server',
      columns: [
        { key: 'host', label: 'Host' },
        { key: 'port', label: 'Port', numeric: true },
        { key: 'method', label: 'Method' },
        { key: 'result', label: 'Result' },
        { key: 'connectMs', label: 'Connect time (ms)', numeric: true },
        { key: 'detail', label: 'Detail' }
      ],
      rows: [
        {
          host: target.host,
          port: target.port,
          method: METHOD_LABEL[probe.method],
          result: state,
          connectMs,
          detail: state === 'open' ? '' : reason
        }
      ]
    };
    const tables = [connection, ...addresses];
    if (state === null) {
      return makeResult('error', `The connection test did not give an answer: ${reason}`, { findings, tables, notes, evidence });
    }

    const finding = connectFinding(target, state, reason);
    if (!findings.some((f) => f.title === finding.title)) findings.push(finding);
    if (connectMs !== null) {
      notes.push(`Connect time is measured on the server and includes starting ${probe.method} and resolving the name.`);
    }
    return makeResult(status, connectSummary(target, state, connectMs), { findings, tables, notes, evidence });
  }
};
