/**
 * Network configuration: interfaces, routes and the resolver.
 *
 * Interfaces and routes come from iproute2's JSON output, so nothing is
 * scraped from human-formatted text. A build without `-j` is reported as
 * unavailable rather than parsed approximately.
 */
import { isCommandMissing, isPermissionDenied, makeResult, runEvidence } from '../../exec.js';
import type { CommandEvidence, DevOpsTool, Finding, ResultTable, ToolStatus } from '../../types.js';
import { SBIN_PATH, firstLine } from '../system/shell-script.js';

export interface NetInterface {
  index: number | null;
  name: string;
  /** Kernel operstate (UP, DOWN, UNKNOWN, LOWERLAYERDOWN…). */
  state: string | null;
  flags: string[];
  mtu: number | null;
  /** Link-layer address; null when the device has none (tunnels). */
  mac: string | null;
  /** `addr/prefix`, with ` (scope)` for non-global scopes. */
  ipv4: string[];
  ipv6: string[];
}

export interface NetRoute {
  family: 'IPv4' | 'IPv6';
  destination: string;
  gateway: string | null;
  device: string | null;
  protocol: string | null;
  /** Omitted by iproute2 when zero, so null here rather than an assumed value. */
  metric: number | null;
  source: string | null;
  type: string;
  isDefault: boolean;
}

export interface ResolvEntry {
  setting: string;
  value: string;
  line: number;
}

export interface ResolvConf {
  nameservers: string[];
  search: string[];
  options: string[];
  entries: ResolvEntry[];
}

const IP = `${SBIN_PATH} ip`;

export const NET_CONFIG_COMMANDS = [
  `${IP} -j addr show`,
  `${IP} -j route show`,
  `${IP} -j -6 route show`,
  'cat /etc/resolv.conf'
];

/** glibc reads at most this many nameservers (MAXNS). */
const RESOLVER_MAX_NAMESERVERS = 3;

/** iproute2 before 4.13 rejects `-j`; BusyBox ip rejects it with its usage text. */
const NO_JSON_OPTION = /option "-j" is unknown|invalid option|unrecognized option|usage:/i;

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

function parseJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** `ip -j addr show`; null when the text is not iproute2 JSON. */
export function parseIpAddrJson(text: string): NetInterface[] | null {
  const items = parseJsonArray(text);
  if (!items) return null;
  const interfaces: NetInterface[] = [];
  for (const item of items) {
    const entry = record(item);
    const name = str(entry.ifname);
    if (!name) continue;
    const ipv4: string[] = [];
    const ipv6: string[] = [];
    for (const raw of Array.isArray(entry.addr_info) ? entry.addr_info : []) {
      const addr = record(raw);
      const local = str(addr.local);
      if (!local) continue;
      const prefix = num(addr.prefixlen);
      const scope = str(addr.scope);
      const text = `${local}${prefix === null ? '' : `/${prefix}`}${scope && scope !== 'global' ? ` (${scope})` : ''}`;
      if (addr.family === 'inet') ipv4.push(text);
      else if (addr.family === 'inet6') ipv6.push(text);
    }
    interfaces.push({
      index: num(entry.ifindex),
      name,
      state: str(entry.operstate),
      flags: Array.isArray(entry.flags) ? entry.flags.filter((f): f is string => typeof f === 'string') : [],
      mtu: num(entry.mtu),
      mac: str(entry.address),
      ipv4,
      ipv6
    });
  }
  return interfaces.sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
}

/** `ip -j route show`; null when the text is not iproute2 JSON. */
export function parseIpRouteJson(text: string, family: NetRoute['family']): NetRoute[] | null {
  const items = parseJsonArray(text);
  if (!items) return null;
  const routes: NetRoute[] = [];
  for (const item of items) {
    const entry = record(item);
    const destination = str(entry.dst);
    if (!destination) continue;
    const hops = Array.isArray(entry.nexthops) ? entry.nexthops.map(record) : [];
    const joined = (key: string): string | null => {
      const values = hops.map((hop) => str(hop[key])).filter((v): v is string => v !== null);
      return values.length > 0 ? values.join(', ') : null;
    };
    routes.push({
      family,
      destination,
      gateway: str(entry.gateway) ?? joined('gateway'),
      device: str(entry.dev) ?? joined('dev'),
      protocol: str(entry.protocol),
      metric: num(entry.metric),
      source: str(entry.prefsrc),
      type: str(entry.type) ?? 'unicast',
      isDefault: destination === 'default' || destination === '0.0.0.0/0' || destination === '::/0'
    });
  }
  return routes;
}

const RESOLV_KEYWORDS = new Set(['nameserver', 'search', 'domain', 'options', 'sortlist']);

export function parseResolvConf(text: string): ResolvConf {
  const conf: ResolvConf = { nameservers: [], search: [], options: [], entries: [] };
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) return;
    const tokens = line.split(/\s+/);
    const keyword = tokens[0]!.toLowerCase();
    if (!RESOLV_KEYWORDS.has(keyword)) return;
    const end = tokens.findIndex((t, i) => i > 0 && (t.startsWith('#') || t.startsWith(';')));
    const values = tokens.slice(1, end < 0 ? undefined : end);
    if (values.length === 0) return;
    if (keyword === 'nameserver') conf.nameservers.push(values[0]!);
    // `search` and `domain` replace each other; the last one wins.
    else if (keyword === 'search' || keyword === 'domain') conf.search = keyword === 'domain' ? [values[0]!] : values;
    else if (keyword === 'options') conf.options.push(...values);
    conf.entries.push({ setting: keyword, value: keyword === 'nameserver' ? values[0]! : values.join(' '), line: index + 1 });
  });
  return conf;
}

function interfaceState(iface: NetInterface): string | null {
  if (!iface.state) return null;
  if (!iface.flags.includes('UP')) return `${iface.state} (admin down)`;
  if (iface.flags.includes('NO-CARRIER')) return `${iface.state} (no carrier)`;
  return iface.state;
}

function interfaceTable(interfaces: NetInterface[]): ResultTable {
  return {
    id: 'interfaces',
    title: 'Interfaces',
    columns: [
      { key: 'interface', label: 'Interface' },
      { key: 'state', label: 'State' },
      { key: 'mtu', label: 'MTU', numeric: true },
      { key: 'mac', label: 'MAC' },
      { key: 'ipv4', label: 'IPv4' },
      { key: 'ipv6', label: 'IPv6' }
    ],
    rows: interfaces.map((i) => ({
      interface: i.name,
      state: interfaceState(i),
      mtu: i.mtu,
      mac: i.mac ?? '',
      ipv4: i.ipv4.join(', '),
      ipv6: i.ipv6.join(', ')
    }))
  };
}

function routeTable(routes: NetRoute[]): ResultTable {
  const ordered = [...routes.filter((r) => r.isDefault), ...routes.filter((r) => !r.isDefault)];
  return {
    id: 'routes',
    title: 'Routes',
    columns: [
      { key: 'family', label: 'Family' },
      { key: 'destination', label: 'Destination' },
      { key: 'gateway', label: 'Gateway' },
      { key: 'device', label: 'Device' },
      { key: 'protocol', label: 'Protocol' },
      { key: 'metric', label: 'Metric', numeric: true },
      { key: 'source', label: 'Source' },
      { key: 'type', label: 'Type' },
      { key: 'default', label: 'Default' }
    ],
    rows: ordered.map((r) => ({
      family: r.family,
      destination: r.destination,
      gateway: r.gateway ?? '',
      device: r.device ?? '',
      protocol: r.protocol ?? '',
      metric: r.metric,
      source: r.source ?? '',
      type: r.type,
      default: r.isDefault ? 'yes' : ''
    }))
  };
}

function dnsTable(conf: ResolvConf): ResultTable {
  return {
    id: 'dns',
    title: 'Resolver (/etc/resolv.conf)',
    columns: [
      { key: 'setting', label: 'Setting' },
      { key: 'value', label: 'Value' },
      { key: 'line', label: 'Line', numeric: true }
    ],
    rows: conf.entries.map((e) => ({ setting: e.setting, value: e.value, line: e.line }))
  };
}

function routeFindings(routes: NetRoute[] | null, family: NetRoute['family']): Finding[] {
  if (!routes) return [];
  const defaults = routes.filter((r) => r.isDefault);
  if (defaults.length === 0) {
    return family === 'IPv4'
      ? [{ severity: 'warning', title: 'No IPv4 default route', detail: 'Only directly connected networks are reachable over IPv4.' }]
      : [];
  }
  return defaults.map((r) => ({
    severity: 'info',
    title: `${family} default route via ${r.gateway ?? 'no gateway'} on ${r.device ?? 'no device'}`,
    subject: family === 'IPv4' ? 'ip -j route show' : 'ip -j -6 route show'
  }));
}

function resolverFindings(conf: ResolvConf): Finding[] {
  const findings: Finding[] = [];
  if (conf.nameservers.length === 0) {
    findings.push({ severity: 'warning', title: 'No nameserver in /etc/resolv.conf', detail: 'The resolver falls back to the local host.' });
    return findings;
  }
  if (conf.nameservers.length > RESOLVER_MAX_NAMESERVERS) {
    findings.push({
      severity: 'warning',
      title: `Only the first ${RESOLVER_MAX_NAMESERVERS} of ${conf.nameservers.length} nameservers are used`,
      detail: `glibc ignores ${conf.nameservers.slice(RESOLVER_MAX_NAMESERVERS).join(', ')}.`,
      subject: '/etc/resolv.conf'
    });
  }
  if (conf.nameservers.includes('127.0.0.53')) {
    findings.push({
      severity: 'info',
      title: 'DNS goes through the systemd-resolved stub at 127.0.0.53',
      detail: 'The upstream servers are listed by `resolvectl status`.',
      subject: '/etc/resolv.conf'
    });
  } else {
    findings.push({ severity: 'info', title: `Resolver uses ${conf.nameservers.join(', ')}`, subject: '/etc/resolv.conf' });
  }
  return findings;
}

export const netConfigTool: DevOpsTool = {
  id: 'net-config',
  group: 'network',
  title: 'Network configuration',
  description: 'Interfaces with state, MTU and addresses, IPv4/IPv6 routes with the default route first, and resolver settings.',
  requires: ['ip (iproute2 with -j)'],
  preview: () => [...NET_CONFIG_COMMANDS],
  async run(session) {
    const evidence: CommandEvidence[] = [];
    const outputs = [];
    for (const command of NET_CONFIG_COMMANDS) {
      const probe = await runEvidence(session, command);
      evidence.push(probe.evidence);
      outputs.push(probe);
    }
    const [addr, route4, route6, resolv] = outputs as [
      (typeof outputs)[number],
      (typeof outputs)[number],
      (typeof outputs)[number],
      (typeof outputs)[number]
    ];

    const notes: string[] = [];
    const findings: Finding[] = [];
    const tables: ResultTable[] = [];
    let status: ToolStatus = 'ok';

    let conf: ResolvConf | null = null;
    if (resolv.exitCode === 0) {
      conf = parseResolvConf(resolv.stdout);
    } else if (/No such file/i.test(resolv.stderr)) {
      findings.push({ severity: 'warning', title: 'No /etc/resolv.conf', detail: 'The resolver falls back to the local host.' });
    } else {
      status = 'partial';
      notes.push(`/etc/resolv.conf could not be read: ${firstLine(resolv.stderr) || `exit ${resolv.exitCode}`}`);
    }

    const interfaces = parseIpAddrJson(addr.stdout);
    if (!interfaces) {
      if (conf) tables.push(dnsTable(conf));
      const parts = { tables, notes, evidence, findings: conf ? resolverFindings(conf) : findings };
      if (isCommandMissing(addr.exitCode, addr.stderr)) {
        return makeResult('unavailable', 'ip (iproute2) is not installed on this server.', parts);
      }
      // A plain-text answer with exit 0 is a build that ignores -j.
      if (NO_JSON_OPTION.test(addr.stderr) || addr.exitCode === 0) {
        return makeResult('unavailable', 'This ip build cannot print JSON (ip -j), so interfaces and routes are not reported.', parts);
      }
      const reason = firstLine(addr.stderr) || `exit ${addr.exitCode}`;
      return makeResult(isPermissionDenied(addr.stderr) ? 'partial' : 'error', `Interfaces could not be read: ${reason}`, parts);
    }

    const v4 = parseIpRouteJson(route4.stdout, 'IPv4');
    if (!v4) {
      status = 'partial';
      notes.push(
        isPermissionDenied(route4.stderr)
          ? `IPv4 routes could not be read: ${firstLine(route4.stderr)}`
          : 'IPv4 routes were not returned as JSON by this ip build; see the evidence.'
      );
    }
    let v6 = parseIpRouteJson(route6.stdout, 'IPv6');
    if (!v6 && /address family not supported/i.test(route6.stderr)) {
      notes.push('IPv6 is disabled on this server.');
      v6 = [];
    } else if (!v6) {
      status = 'partial';
      notes.push('IPv6 routes were not returned as JSON by this ip build; see the evidence.');
    }

    tables.push(interfaceTable(interfaces));
    if (v4 || v6) tables.push(routeTable([...(v4 ?? []), ...(v6 ?? [])]));
    if (conf) tables.push(dnsTable(conf));

    findings.unshift(...routeFindings(v4, 'IPv4'), ...routeFindings(v6, 'IPv6'));
    for (const iface of interfaces) {
      const state = interfaceState(iface);
      if (iface.state === 'DOWN' && iface.ipv4.length + iface.ipv6.length > 0) {
        findings.push({ severity: 'info', title: `${iface.name} is ${state}`, detail: 'It has addresses configured but carries no traffic.', subject: iface.name });
      }
    }
    if (conf) findings.push(...resolverFindings(conf));

    // Loopback and tunnels report operstate UNKNOWN; the kernel flags say whether they pass traffic.
    const up = interfaces.filter((i) => i.state === 'UP' || (i.flags.includes('UP') && i.flags.includes('LOWER_UP'))).length;
    const counts = [`${plural(interfaces.length, 'interface')} (${up} up)`];
    if (v4) counts.push(plural(v4.length, 'IPv4 route'));
    if (v6) counts.push(plural(v6.length, 'IPv6 route'));
    if (conf) counts.push(plural(conf.nameservers.length, 'nameserver'));
    return makeResult(status, `${counts.join(', ')}.`, { findings, tables, notes, evidence });
  }
};
