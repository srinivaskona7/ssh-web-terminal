/**
 * TLS certificate expiry: certificates on disk (Let's Encrypt, and the files
 * nginx and Apache configuration points at) and, optionally, the certificate a
 * TLS endpoint presents to this server.
 *
 * openssl reads every certificate; days remaining are computed here from the
 * notAfter it prints. Files the account cannot read are listed as unreadable,
 * never as healthy.
 */
import { isPermissionDenied, makeResult, runEvidence, validateHost, validatePort } from '../../exec.js';
import type { DevOpsTool, Finding, FindingSeverity, ResultTable, ToolInput, ToolStatus } from '../../types.js';
import { contentLines, firstLine, shScript, splitSections } from '../system/shell-script.js';

const DAY_MS = 86_400_000;
const CRITICAL_DAYS = 7;
const WARNING_DAYS = 30;
const REMOTE_TIMEOUT_S = 10;

/** Space or tab: mawk 1.3.3 (Ubuntu 18.04) has no [[:space:]]. */
const WS = '[ \t]';
const CERT_DIRECTIVE = `^${WS}*(ssl_certificate|sslcertificatefile)${WS}`;
const CONFIG_DIRS = '/etc/nginx /etc/apache2 /etc/httpd';

// Prints "file:line" then the certificate path for every directive. Relative
// paths resolve against the server root; paths with variables are kept as is.
const AWK_REFERENCES =
  '{ d = tolower($1); if (d != "ssl_certificate" && d != "sslcertificatefile") next; ' +
  `v = $0; sub(/^${WS}*[^ \t]+${WS}+/, "", v); sub(/${WS}*;.*$/, "", v); sub(/${WS}+$/, "", v); ` +
  'gsub(/"/, "", v); gsub(sprintf("%c", 39), "", v); if (v == "") next; ' +
  'if (substr(v, 1, 1) != "/" && index(v, "$") == 0) v = root "/" v; print FILENAME ":" FNR; print v }';

const X509_FIELDS = '-noout -subject -issuer -enddate -fingerprint -sha256';

const LOCAL_SCRIPT =
  'export LC_ALL=C; command -v openssl >/dev/null 2>&1 || exit 127; ext=1; ' +
  'inspect() { echo "@@WEBSSH:cert $1"; echo "@@WEBSSH:from $2"; ' +
  'case $1 in *[$]*) echo @@WEBSSH:variable; return;; esac; ' +
  `if [ "$ext" = 1 ]; then out=$(openssl x509 ${X509_FIELDS} -ext subjectAltName -in "$1" 2>&1); rc=$?; ` +
  // openssl before 1.1.1 and LibreSSL reject -ext before opening the file; drop names from then on.
  'case $out in *"unknown option"*) ext=0;; esac; fi; ' +
  `if [ "$ext" = 0 ]; then echo @@WEBSSH:noext; out=$(openssl x509 ${X509_FIELDS} -in "$1" 2>&1); rc=$?; fi; ` +
  'echo @@WEBSSH:x509; printf "%s\\n" "$out" | sed "s/^/|/"; echo "@@WEBSSH:rc $rc"; }; ' +
  'le=/etc/letsencrypt/live; if [ -d "$le" ]; then if [ -r "$le" ] && [ -x "$le" ]; then ' +
  'for f in "$le"/*/cert.pem; do if [ -e "$f" ] || [ -L "$f" ]; then inspect "$f" letsencrypt; fi; done; ' +
  'else echo "@@WEBSSH:unreadable $le"; fi; fi; ' +
  `pat="${CERT_DIRECTIVE}"; ` +
  `for d in ${CONFIG_DIRS}; do [ -d "$d" ] || continue; ` +
  'n=$(grep -RliE "$pat" "$d" 2>&1 >/dev/null | grep -c "Permission denied"); ' +
  'if [ "$n" -gt 0 ]; then echo "@@WEBSSH:denied $n $d"; fi; done; ' +
  `for d in ${CONFIG_DIRS}; do [ -d "$d" ] || continue; ` +
  `grep -RlisE "$pat" "$d" | sort | while IFS= read -r c; do awk -v root="$d" '${AWK_REFERENCES}' "$c"; done; done | ` +
  'while IFS= read -r src && IFS= read -r path; do inspect "$path" "$src"; done';

const REMOTE_SCRIPT =
  'command -v openssl >/dev/null 2>&1 || exit 127; ' +
  `if command -v timeout >/dev/null 2>&1; then t="timeout ${REMOTE_TIMEOUT_S}"; else t=""; fi; ` +
  'if [ -n "$2" ]; then out=$($t openssl s_client -servername "$2" -connect "$1" </dev/null 2>&1); ' +
  'else out=$($t openssl s_client -connect "$1" </dev/null 2>&1); fi; rc=$?; ' +
  'echo "@@WEBSSH:rc $rc"; echo @@WEBSSH:diag; ' +
  'printf "%s\\n" "$out" | grep -iE "verify return code|error|errno|refused|not known|timed out|unreachable|no route|alert|no peer certificate" | head -n 20 | sed "s/^/|/"; ' +
  `x=$(printf "%s\\n" "$out" | openssl x509 ${X509_FIELDS} 2>&1); xrc=$?; ` +
  'echo @@WEBSSH:x509; printf "%s\\n" "$x" | sed "s/^/|/"; echo "@@WEBSSH:x509rc $xrc"';

export const TLS_LOCAL_COMMAND = shScript(LOCAL_SCRIPT);

export interface X509Info {
  subject: string | null;
  commonName: string | null;
  issuer: string | null;
  /** Issuing CA as "CN (O)". */
  issuerLabel: string | null;
  notAfter: number | null;
  fingerprint: string | null;
  /** subjectAltName entries; null when this openssl could not print them. */
  names: string[] | null;
}

export interface LocalCertRecord {
  path: string;
  sources: string[];
  /** The path contains a variable (nginx `$ssl_server_name`, Apache `${VAR}`). */
  variable: boolean;
  extSupported: boolean;
  output: string[];
  exitCode: number | null;
}

export interface LocalCertProbe {
  unreadableDirs: string[];
  deniedConfigs: Array<{ dir: string; count: number }>;
  records: LocalCertRecord[];
}

export interface RemoteCertProbe {
  exitCode: number | null;
  verify: { code: number; text: string } | null;
  diagnostics: string[];
  x509: string[];
  x509ExitCode: number | null;
  reason: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** openssl's `notAfter=Jan  3 00:00:00 2027 GMT`. */
export function parseNotAfter(text: string): number | null {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+GMT$/.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!);
  if (month < 0) return null;
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/** Split `C = US, O = "A, B", CN = x` (or `C=US, ...`) into attributes. */
function splitDn(dn: string): Array<[string, string]> {
  if (dn.startsWith('/')) {
    return dn
      .slice(1)
      .split('/')
      .map((part) => {
        const eq = part.indexOf('=');
        return [part.slice(0, eq).trim(), part.slice(eq + 1).trim()] as [string, string];
      })
      .filter(([key]) => key !== '');
  }
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < dn.length; i++) {
    const ch = dn[i]!;
    if (ch === '\\' && i + 1 < dn.length) {
      current += dn[++i];
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts
    .map((part) => {
      const eq = part.indexOf('=');
      return eq < 0 ? (['', ''] as [string, string]) : ([part.slice(0, eq).trim(), part.slice(eq + 1).trim()] as [string, string]);
    })
    .filter(([key]) => key !== '');
}

function dnValue(dn: string | null, key: string): string | null {
  if (!dn) return null;
  const found = splitDn(dn).filter(([k]) => k.toUpperCase() === key);
  return found.length > 0 ? found[found.length - 1]![1] || null : null;
}

export function parseX509Lines(lines: string[], extSupported: boolean): X509Info {
  let subject: string | null = null;
  let issuer: string | null = null;
  let notAfter: number | null = null;
  let fingerprint: string | null = null;
  const sanParts: string[] = [];
  let inSan = false;
  for (const line of lines) {
    if (inSan && /^\s+\S/.test(line)) {
      sanParts.push(line.trim());
      continue;
    }
    inSan = false;
    const trimmed = line.trim();
    if (trimmed.startsWith('subject=')) subject = trimmed.slice('subject='.length).trim() || null;
    else if (trimmed.startsWith('issuer=')) issuer = trimmed.slice('issuer='.length).trim() || null;
    else if (trimmed.startsWith('notAfter=')) notAfter = parseNotAfter(trimmed.slice('notAfter='.length));
    else if (/^sha256 Fingerprint=/i.test(trimmed)) fingerprint = trimmed.slice(trimmed.indexOf('=') + 1).trim() || null;
    else if (/^X509v3 Subject Alternative Name:/.test(trimmed)) inSan = true;
  }
  const names = sanParts
    .join(', ')
    .split(/,\s*/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => (name.startsWith('DNS:') ? name.slice(4) : name));
  const issuerCn = dnValue(issuer, 'CN');
  const issuerOrg = dnValue(issuer, 'O');
  const issuerLabel =
    issuerCn && issuerOrg && issuerCn !== issuerOrg ? `${issuerCn} (${issuerOrg})` : (issuerCn ?? issuerOrg ?? issuer);
  return {
    subject,
    commonName: dnValue(subject, 'CN'),
    issuer,
    issuerLabel,
    notAfter,
    fingerprint,
    names: extSupported ? names : null
  };
}

function exitOf(arg: string | undefined): number | null {
  return arg !== undefined && /^\d+$/.test(arg) ? Number(arg) : null;
}

export function parseLocalCertProbe(stdout: string): LocalCertProbe {
  const probe: LocalCertProbe = { unreadableDirs: [], deniedConfigs: [], records: [] };
  let record: LocalCertRecord | null = null;
  for (const section of splitSections(stdout).sections) {
    switch (section.tag) {
      case 'unreadable':
        probe.unreadableDirs.push(section.arg);
        break;
      case 'denied': {
        const m = /^(\d+)\s+(.+)$/.exec(section.arg);
        if (m) probe.deniedConfigs.push({ dir: m[2]!, count: Number(m[1]) });
        break;
      }
      case 'cert':
        record = { path: section.arg, sources: [], variable: false, extSupported: true, output: [], exitCode: null };
        probe.records.push(record);
        break;
      case 'from':
        record?.sources.push(section.arg);
        break;
      case 'variable':
        if (record) record.variable = true;
        break;
      case 'noext':
        if (record) record.extSupported = false;
        break;
      case 'x509':
        if (record) record.output = contentLines(section.lines);
        break;
      case 'rc':
        if (record) record.exitCode = exitOf(section.arg);
        break;
    }
  }
  return probe;
}

const UNRESOLVED =
  /name or service not known|nodename nor servname|could not resolve|bad address|no address associated|temporary failure in name resolution/i;

function remoteReason(diagnostics: string[], exitCode: number | null): string {
  const text = diagnostics.join('\n');
  if (exitCode !== null && TIMEOUT_EXITS.has(exitCode)) return `no answer within ${REMOTE_TIMEOUT_S} s`;
  if (/connection refused/i.test(text)) return 'connection refused';
  if (UNRESOLVED.test(text)) return 'the name does not resolve';
  if (/timed out/i.test(text)) return 'timed out';
  if (/no route to host|network is unreachable/i.test(text)) return 'no route to the host';
  if (/no peer certificate/i.test(text)) return 'the server sent no certificate';
  if (/wrong version number|handshake failure|alert|unexpected eof|packet length too long/i.test(text)) {
    return 'the TLS handshake failed';
  }
  return diagnostics.find((line) => !/verify return code/i.test(line)) ?? (exitCode === null ? 'no answer' : `exit ${exitCode}`);
}

/** GNU timeout exits 124; BusyBox timeout reports the signal. */
const TIMEOUT_EXITS = new Set([124, 143, 137]);

export function parseRemoteCertProbe(stdout: string): RemoteCertProbe {
  const { sections } = splitSections(stdout);
  const lines = (tag: string) => contentLines(sections.find((s) => s.tag === tag)?.lines ?? []);
  const diagnostics = lines('diag').map((line) => line.trim());
  const exitCode = exitOf(sections.find((s) => s.tag === 'rc')?.arg);
  const verifyLine = diagnostics.map((line) => /Verify return code:\s*(\d+)\s*\((.*)\)/.exec(line)).find(Boolean);
  return {
    exitCode,
    verify: verifyLine ? { code: Number(verifyLine[1]), text: verifyLine[2]!.trim() } : null,
    diagnostics,
    x509: lines('x509'),
    x509ExitCode: exitOf(sections.find((s) => s.tag === 'x509rc')?.arg),
    reason: remoteReason(diagnostics, exitCode)
  };
}

interface Remote {
  host: string;
  port: number;
}

function readInput(input: ToolInput): { remote: Remote | null } | { error: string } {
  const host = (input.host ?? '').trim();
  if (!host) return { remote: null };
  const port = (input.port ?? '').trim() || '443';
  const error = validateHost(host) ?? validatePort(port);
  return error ? { error } : { remote: { host, port: Number(port) } };
}

function isIpLiteral(host: string): boolean {
  return host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function remoteEndpoint(remote: Remote): string {
  return remote.host.includes(':') ? `[${remote.host}]:${remote.port}` : `${remote.host}:${remote.port}`;
}

function commandsFor(remote: Remote | null): string[] {
  if (!remote) return [TLS_LOCAL_COMMAND];
  // SNI carries names only; an IP literal is sent without it.
  return [TLS_LOCAL_COMMAND, shScript(REMOTE_SCRIPT, [remoteEndpoint(remote), isIpLiteral(remote.host) ? '' : remote.host])];
}

type CertState =
  | 'expired'
  | 'expires within 7 days'
  | 'expires within 30 days'
  | 'valid'
  | 'file missing'
  | 'unreadable'
  | 'not a certificate'
  | 'chosen per request'
  | 'not reported';

interface CertRow {
  location: string;
  sources: string[];
  info: X509Info | null;
  daysLeft: number | null;
  state: CertState;
  /** First line of openssl's complaint, for files it could not use. */
  problem: string;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function expiryState(notAfter: number, now: number): { daysLeft: number; state: CertState } {
  const daysLeft = Math.floor((notAfter - now) / DAY_MS);
  if (notAfter <= now) return { daysLeft, state: 'expired' };
  if (daysLeft < CRITICAL_DAYS) return { daysLeft, state: 'expires within 7 days' };
  if (daysLeft < WARNING_DAYS) return { daysLeft, state: 'expires within 30 days' };
  return { daysLeft, state: 'valid' };
}

function inspectedRow(location: string, sources: string[], info: X509Info, now: number): CertRow {
  if (info.notAfter === null) return { location, sources, info, daysLeft: null, state: 'not reported', problem: '' };
  return { location, sources, info, ...expiryState(info.notAfter, now), problem: '' };
}

function localRows(records: LocalCertRecord[], now: number): CertRow[] {
  const byPath = new Map<string, { record: LocalCertRecord; sources: string[] }>();
  for (const record of records) {
    const seen = byPath.get(record.path);
    if (seen) {
      for (const source of record.sources) if (!seen.sources.includes(source)) seen.sources.push(source);
    } else {
      byPath.set(record.path, { record, sources: [...record.sources] });
    }
  }
  return [...byPath.values()].map(({ record, sources }) => {
    const base = { location: record.path, sources, info: null, daysLeft: null, problem: '' };
    if (record.variable) return { ...base, state: 'chosen per request' as const };
    if (record.exitCode === 0) return inspectedRow(record.path, sources, parseX509Lines(record.output, record.extSupported), now);
    if (record.exitCode === null) return { ...base, state: 'not reported' as const };
    const text = record.output.join('\n');
    const problem = firstLine(text);
    if (/no such file or directory/i.test(text)) return { ...base, problem, state: 'file missing' as const };
    if (isPermissionDenied(text)) return { ...base, problem, state: 'unreadable' as const };
    return { ...base, problem, state: 'not a certificate' as const };
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortRows(rows: CertRow[]): CertRow[] {
  return [...rows].sort((a, b) => {
    if (a.daysLeft !== null && b.daysLeft !== null && a.daysLeft !== b.daysLeft) return a.daysLeft - b.daysLeft;
    if ((a.daysLeft === null) !== (b.daysLeft === null)) return a.daysLeft === null ? 1 : -1;
    return compareText(a.location, b.location);
  });
}

function certTable(rows: CertRow[]): ResultTable {
  return {
    id: 'certificates',
    title: 'Certificates',
    columns: [
      { key: 'location', label: 'Location' },
      { key: 'referencedBy', label: 'Referenced by' },
      { key: 'subject', label: 'Subject' },
      { key: 'names', label: 'Names' },
      { key: 'issuer', label: 'Issuer' },
      { key: 'expires', label: 'Expires (UTC)' },
      { key: 'daysLeft', label: 'Days left', numeric: true },
      { key: 'state', label: 'State' }
    ],
    rows: rows.map((row) => ({
      location: row.location,
      referencedBy: row.sources.join(', '),
      subject: row.info ? (row.info.commonName ?? row.info.subject) : null,
      names: row.info?.names ? row.info.names.join(', ') : null,
      issuer: row.info?.issuerLabel ?? null,
      expires: row.info?.notAfter != null ? isoDate(row.info.notAfter) : null,
      daysLeft: row.daysLeft,
      state: row.state
    }))
  };
}

function inDays(days: number): string {
  if (days <= 0) return 'within a day';
  return days === 1 ? 'in 1 day' : `in ${days} days`;
}

/** One finding per certificate, however many files or endpoints carry it. */
function expiryFindings(rows: CertRow[]): Finding[] {
  const groups = new Map<string, CertRow[]>();
  for (const row of rows) {
    if (!row.info || row.info.notAfter === null) continue;
    const key = row.info.fingerprint ?? `${row.info.subject ?? row.location}|${row.info.notAfter}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const findings: Finding[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    if (first.state !== 'expired' && first.state !== 'expires within 7 days' && first.state !== 'expires within 30 days') continue;
    const info = first.info!;
    const name = info.commonName ?? info.names?.[0] ?? info.subject ?? first.location;
    const date = isoDate(info.notAfter!);
    const sources = [...new Set(group.flatMap((row) => row.sources))];
    findings.push({
      severity: first.state === 'expires within 30 days' ? 'warning' : 'critical',
      title: first.state === 'expired' ? `${name} expired on ${date}` : `${name} expires ${inDays(first.daysLeft!)} (${date})`,
      detail: `${group.map((row) => row.location).join(', ')}; referenced by ${sources.join(', ')}`,
      subject: first.location
    });
  }
  return findings;
}

function problemFindings(rows: CertRow[]): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows) {
    if (row.state === 'file missing') {
      findings.push({ severity: 'warning', title: `${row.location} does not exist`, detail: `Referenced by ${row.sources.join(', ')}.`, subject: row.sources[0] });
    } else if (row.state === 'not a certificate') {
      findings.push({ severity: 'warning', title: `${row.location} is not a readable certificate`, detail: row.problem, subject: row.sources[0] });
    }
  }
  return findings;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2, ok: 3 };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const tlsExpiryTool: DevOpsTool = {
  id: 'tls-expiry',
  group: 'network',
  title: 'TLS certificate expiry',
  description:
    "Days left on Let's Encrypt certificates and those referenced from /etc/nginx, /etc/apache2 and /etc/httpd, plus an optional endpoint checked from the server.",
  requires: ['openssl'],
  rootForFullData: true,
  inputs: [
    { key: 'host', label: 'Endpoint host (optional)', placeholder: 'api.example.com', validate: (v) => (v.trim() ? validateHost(v) : null) },
    { key: 'port', label: 'Endpoint port', defaultValue: '443', validate: (v) => (v.trim() ? validatePort(v) : null) }
  ],
  preview(input) {
    const parsed = readInput(input);
    return 'error' in parsed ? [] : commandsFor(parsed.remote);
  },
  async run(session, input) {
    const parsed = readInput(input);
    if ('error' in parsed) return makeResult('error', parsed.error);
    const commands = commandsFor(parsed.remote);
    const local = await runEvidence(session, commands[0]!);
    const remoteRun = commands[1] ? await runEvidence(session, commands[1]) : null;
    const evidence = remoteRun ? [local.evidence, remoteRun.evidence] : [local.evidence];
    if (local.exitCode === 127) return makeResult('unavailable', 'openssl is not installed on this server.', { evidence });

    const now = Date.now();
    const probe = parseLocalCertProbe(local.stdout);
    const rows = localRows(probe.records, now);
    const notes: string[] = [];
    const findings: Finding[] = [];
    let status: ToolStatus = 'ok';

    for (const dir of probe.unreadableDirs) notes.push(`${dir} is readable only by root here; its certificates are not reported.`);
    for (const { dir, count } of probe.deniedConfigs) {
      notes.push(`${plural(count, 'config file')} under ${dir} could not be read; certificates they reference are not reported.`);
    }
    for (const row of rows) if (row.state === 'unreadable') notes.push(`${row.location} could not be read (permission denied).`);
    if (rows.some((row) => row.info && row.info.names === null)) {
      notes.push('This openssl cannot print subjectAltName (-ext), so certificate names are not reported.');
    }
    if (notes.length > 0 || rows.some((row) => row.state === 'not reported')) status = 'partial';

    let verifyFinding: Finding | null = null;
    let remoteFailure: Finding | null = null;
    if (parsed.remote && remoteRun) {
      const ep = remoteEndpoint(parsed.remote);
      const answer = parseRemoteCertProbe(remoteRun.stdout);
      if (answer.x509ExitCode === 0) {
        rows.push(inspectedRow(ep, ['TLS handshake from the server'], parseX509Lines(answer.x509, false), now));
        if (answer.verify && answer.verify.code !== 0) {
          verifyFinding = {
            severity: 'warning',
            title: `${ep} does not verify on the server: ${answer.verify.text}`,
            detail: `openssl verify code ${answer.verify.code} against this server's trust store.`,
            subject: ep
          };
        }
      } else {
        const reason = remoteRun.exitCode === 127 ? 'openssl is not installed' : answer.reason;
        const title = `No certificate from ${ep}: ${reason}`;
        notes.push(title);
        remoteFailure = { severity: 'warning', title, subject: ep };
        status = 'partial';
      }
    }

    const sorted = sortRows(rows);
    findings.push(...expiryFindings(sorted));
    if (verifyFinding) findings.push(verifyFinding);
    findings.push(...problemFindings(sorted));
    if (remoteFailure) findings.push(remoteFailure);
    for (const row of sorted) {
      if (row.state === 'chosen per request') {
        findings.push({
          severity: 'info',
          title: `${row.sources.join(', ')} picks its certificate per request`,
          detail: `${row.location} is chosen at run time, so it is not inspected here.`,
          subject: row.sources[0]
        });
      }
    }
    if (probe.records.length === 0 && probe.unreadableDirs.length === 0 && probe.deniedConfigs.length === 0) {
      findings.push({ severity: 'info', title: "No certificate files were found in Let's Encrypt, nginx or Apache configuration" });
    }

    const checked = new Map<string, CertRow>();
    for (const row of sorted) {
      if (row.info?.notAfter == null) continue;
      checked.set(row.info.fingerprint ?? `${row.info.subject ?? row.location}|${row.info.notAfter}`, row);
    }
    const unique = [...checked.values()];
    const expired = unique.filter((row) => row.state === 'expired').length;
    const soon = unique.filter((row) => row.state === 'expires within 7 days' || row.state === 'expires within 30 days').length;
    if (unique.length > 0 && expired + soon === 0) {
      findings.push({
        severity: 'ok',
        title: `${plural(unique.length, 'certificate is', 'certificates are')} valid for at least ${WARNING_DAYS} more days`
      });
    }
    findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

    const summary =
      unique.length === 0
        ? 'No certificate could be checked.'
        : `${plural(unique.length, 'certificate')} checked: ${expired} expired, ${soon} ${soon === 1 ? 'expires' : 'expire'} within ${WARNING_DAYS} days.`;
    return makeResult(status, summary, { findings, tables: [certTable(sorted)], notes, evidence });
  }
};
