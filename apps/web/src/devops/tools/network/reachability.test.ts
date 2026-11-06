import { describe, expect, it } from 'vitest';
import { classifyConnect, parseConnectProbe, parseGetentAhosts, reachabilityTool } from './reachability.js';
import { fakeSession, repliesFor } from '../system/testing/fake-session.js';

const INPUT = { host: 'db.internal', port: '5432' };

// glibc `getent ahosts` for a dual-stack name behind a CNAME.
const AHOSTS = [
  '2001:db8::10   STREAM db-1.corp.example',
  '2001:db8::10   DGRAM  ',
  '2001:db8::10   RAW    ',
  '10.0.4.10      STREAM ',
  '10.0.4.10      DGRAM  ',
  '10.0.4.10      RAW    ',
  ''
].join('\n');

function probe(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

const T0 = '@@WEBSSH:t0 1730000000000000000';
const T1_OPEN = '@@WEBSSH:t1 1730000000003456789';

describe('reachability parsers', () => {
  it('reads resolved addresses in resolver order with the canonical name', () => {
    expect(parseGetentAhosts(AHOSTS)).toEqual({ addresses: ['2001:db8::10', '10.0.4.10'], canonicalName: 'db-1.corp.example' });
    expect(parseGetentAhosts('')).toEqual({ addresses: [], canonicalName: null });
    // A scoped link-local answer, then a truncated line that is not an address.
    expect(parseGetentAhosts('fe80::1%eth0 STREAM router.local\n10.0.0.')).toEqual({ addresses: ['fe80::1%eth0'], canonicalName: 'router.local' });
  });

  it('reads method, exit status, messages and nanosecond timestamps', () => {
    const parsed = parseConnectProbe(probe(['@@WEBSSH:method bash', T0, T1_OPEN, '@@WEBSSH:rc 0']));
    expect(parsed).toEqual({ method: 'bash', exitCode: 0, messages: [], elapsedMs: 3.5 });
    // macOS/BusyBox date prints a literal N: no timing rather than a wrong one.
    const noNs = parseConnectProbe(probe(['@@WEBSSH:method nc', '@@WEBSSH:t0 1730000000N', 'Connection to db.internal port 5432 [tcp/postgresql] succeeded!', '@@WEBSSH:t1 1730000001N', '@@WEBSSH:rc 0']));
    expect(noNs).toEqual({ method: 'nc', exitCode: 0, messages: ['Connection to db.internal port 5432 [tcp/postgresql] succeeded!'], elapsedMs: null });
    expect(parseConnectProbe('')).toEqual({ method: null, exitCode: null, messages: [], elapsedMs: null });
  });

  it('classifies bash, OpenBSD nc, ncat and BusyBox answers', () => {
    const c = (exitCode: number, messages: string[], method: 'bash' | 'nc' = 'nc') => classifyConnect({ method, exitCode, messages, elapsedMs: null }).state;
    expect(c(0, [])).toBe('open');
    expect(c(1, ['bash: connect: Connection refused', 'bash: line 1: /dev/tcp/db.internal/5432: Connection refused'], 'bash')).toBe('closed');
    expect(c(124, [], 'bash')).toBe('timed out');
    expect(c(1, ['nc: connect to db.internal port 5432 (tcp) timed out: Operation now in progress'])).toBe('timed out');
    expect(c(1, ['Ncat: TIMEOUT.'])).toBe('timed out');
    expect(c(1, ['nc: getaddrinfo for host "db.internal" port 5432: Name or service not known'])).toBe('unresolved');
    expect(c(1, ["nc: bad address 'db.internal'"])).toBe('unresolved');
    expect(c(1, ['bash: line 1: db.internal: Temporary failure in name resolution', 'bash: line 1: /dev/tcp/db.internal/5432: Invalid argument'], 'bash')).toBe('unresolved');
    expect(c(1, ['bash: connect: No route to host'], 'bash')).toBe('unreachable');
    expect(c(1, ['nc: connect to db.internal port 5432 (tcp) failed: Network is unreachable'])).toBe('unreachable');
    // A BusyBox nc without -z is not an answer about the port.
    expect(c(1, ["nc: invalid option -- 'z'"])).toBeNull();
  });
});

describe('reachabilityTool', () => {
  it('validates input and previews a DNS lookup plus one TCP connect script', () => {
    expect(reachabilityTool.id).toBe('reachability');
    expect(reachabilityTool.preview({ host: 'db.internal; reboot', port: '5432' })).toEqual([]);
    expect(reachabilityTool.preview({ host: 'db.internal', port: '70000' })).toEqual([]);
    const [dns, tcp] = reachabilityTool.preview({ host: ' db.internal ', port: ' 5432 ' });
    expect(dns).toBe(
      `sh -c 'if command -v timeout >/dev/null 2>&1; then exec timeout 10 getent ahosts "$1"; fi; exec getent ahosts "$1"' sh 'db.internal'`
    );
    expect(tcp!.startsWith("sh -c '")).toBe(true);
    expect(tcp!.endsWith(" sh 'db.internal' '5432'")).toBe(true);
    expect(tcp).toContain(`timeout 5 bash -c '\\''</dev/tcp/$1/$2'\\'' bash "$1" "$2"`);
    expect(tcp).toContain('nc -z -v -w 5 "$1" "$2"');
  });

  it('runs nothing for invalid input', async () => {
    const fake = fakeSession({});
    const result = await reachabilityTool.run(fake.session, { host: '-oops', port: '22' });
    expect(result.status).toBe('error');
    expect(result.summary).toBe('Host must not start with a hyphen');
    expect(fake.commands).toEqual([]);
  });

  it('reports an open port with addresses, method and server-side connect time', async () => {
    const commands = reachabilityTool.preview(INPUT);
    const fake = fakeSession(
      repliesFor(commands, [{ stdout: AHOSTS }, { stdout: probe(['@@WEBSSH:method bash', T0, T1_OPEN, '@@WEBSSH:rc 0']) }])
    );
    const result = await reachabilityTool.run(fake.session, INPUT);
    expect(fake.commands).toEqual(commands);
    expect(result.status).toBe('ok');
    expect(result.summary).toBe('db.internal:5432 is open (3.5 ms from the server).');
    expect(result.evidence.map((e) => e.command)).toEqual(commands);
    const [connection, addresses] = result.tables;
    expect(connection!.rows).toEqual([
      { host: 'db.internal', port: 5432, method: 'bash /dev/tcp', result: 'open', connectMs: 3.5, detail: '' }
    ]);
    expect(addresses!.rows).toEqual([
      { address: '2001:db8::10', family: 'IPv6' },
      { address: '10.0.4.10', family: 'IPv4' }
    ]);
    expect(result.findings.map((f) => [f.severity, f.title])).toEqual([
      ['info', 'db.internal resolves to 2001:db8::10, 10.0.4.10 (canonical name db-1.corp.example)'],
      ['ok', 'db.internal:5432 accepts TCP connections from the server']
    ]);
  });

  it('reports a refused and a timed-out port without a made-up connect time', async () => {
    const commands = reachabilityTool.preview(INPUT);
    const refused = await reachabilityTool.run(
      fakeSession(
        repliesFor(commands, [
          { stdout: AHOSTS },
          { stdout: probe(['@@WEBSSH:method nc', T0, 'nc: connect to db.internal port 5432 (tcp) failed: Connection refused', T1_OPEN, '@@WEBSSH:rc 1']) }
        ])
      ).session,
      INPUT
    );
    expect(refused.status).toBe('ok');
    expect(refused.summary).toBe('db.internal:5432 refused the connection.');
    expect(refused.tables[0]!.rows[0]).toMatchObject({ method: 'nc', result: 'closed', connectMs: null });
    expect(refused.findings.at(-1)!.severity).toBe('warning');

    const timedOut = await reachabilityTool.run(
      fakeSession(repliesFor(commands, [{ stdout: AHOSTS }, { stdout: probe(['@@WEBSSH:method bash', T0, '@@WEBSSH:t1 1730000005001000000', '@@WEBSSH:rc 124']) }])).session,
      INPUT
    );
    expect(timedOut.summary).toBe('No answer from db.internal:5432 within 5 s.');
    expect(timedOut.tables[0]!.rows[0]).toMatchObject({ result: 'timed out', connectMs: null });
  });

  it('reports a name that does not resolve once, not twice', async () => {
    const commands = reachabilityTool.preview(INPUT);
    const result = await reachabilityTool.run(
      fakeSession(
        repliesFor(commands, [
          { exitCode: 2 },
          { stdout: probe(['@@WEBSSH:method bash', T0, 'bash: line 1: db.internal: Name or service not known', 'bash: line 1: /dev/tcp/db.internal/5432: Invalid argument', T1_OPEN, '@@WEBSSH:rc 1']) }
        ])
      ).session,
      INPUT
    );
    expect(result.status).toBe('ok');
    expect(result.summary).toBe('db.internal does not resolve on the server.');
    expect(result.findings.map((f) => [f.severity, f.title])).toEqual([['warning', 'db.internal does not resolve on the server']]);
    expect(result.tables[1]!.rows).toEqual([]);
  });

  it('is unavailable when neither bash with timeout nor nc exists, keeping the DNS answer', async () => {
    const commands = reachabilityTool.preview(INPUT);
    const result = await reachabilityTool.run(
      fakeSession(repliesFor(commands, [{ stdout: AHOSTS }, { stdout: probe(['@@WEBSSH:method none', '@@WEBSSH:rc 127']), exitCode: 0 }])).session,
      INPUT
    );
    expect(result.status).toBe('unavailable');
    expect(result.summary).toBe('Neither bash with timeout nor nc is installed on this server, so the port cannot be tested.');
    expect(result.tables.map((t) => t.id)).toEqual(['addresses']);
  });

  it('is partial without getent or when the lookup hangs, and leaves addresses unreported', async () => {
    const commands = reachabilityTool.preview(INPUT);
    const open = { stdout: probe(['@@WEBSSH:method bash', T0, T1_OPEN, '@@WEBSSH:rc 0']) };
    const noGetent = await reachabilityTool.run(
      fakeSession(repliesFor(commands, [{ stderr: 'sh: 1: exec: getent: not found\n', exitCode: 127 }, open])).session,
      INPUT
    );
    expect(noGetent.status).toBe('partial');
    expect(noGetent.notes).toContain('getent is not installed; resolved addresses are not reported.');
    expect(noGetent.tables.map((t) => t.id)).toEqual(['connection']);

    const hung = await reachabilityTool.run(fakeSession(repliesFor(commands, [{ exitCode: 124 }, open])).session, INPUT);
    expect(hung.status).toBe('partial');
    expect(hung.findings[0]).toMatchObject({ severity: 'warning', title: 'The DNS lookup for db.internal did not finish within 10 s' });
  });

  it('is an error when the connect tool answers with something other than a result', async () => {
    const commands = reachabilityTool.preview(INPUT);
    const result = await reachabilityTool.run(
      fakeSession(repliesFor(commands, [{ stdout: AHOSTS }, { stdout: probe(['@@WEBSSH:method nc', T0, "nc: invalid option -- 'z'", T1_OPEN, '@@WEBSSH:rc 1']) }])).session,
      INPUT
    );
    expect(result.status).toBe('error');
    expect(result.summary).toBe("The connection test did not give an answer: nc: invalid option -- 'z'");
    expect(result.tables[0]!.rows[0]!.result).toBeNull();
  });

  it('passes transport failures through', async () => {
    const commands = reachabilityTool.preview(INPUT);
    const fake = fakeSession(repliesFor(commands, [{ stdout: AHOSTS }, new Error('channel closed')]));
    await expect(reachabilityTool.run(fake.session, INPUT)).rejects.toThrow('channel closed');
  });
});
