import { describe, expect, it } from 'vitest';
import {
  LISTENING_PORTS_COMMAND,
  listeningPortsTool,
  parseNetstatListeners,
  parseSsListeners
} from './ports.js';
import { fakeSession, repliesFor } from '../system/testing/fake-session.js';

// `ss -tulpn` as root on Ubuntu 22.04 (iproute2 5.15): scoped IPv4, dual-stack
// `*`, bracketed IPv6 with an interface scope, several owners on one socket,
// a kernel-owned WireGuard socket and a process name containing a space.
const SS_ROOT = [
  'Netid State  Recv-Q Send-Q                     Local Address:Port  Peer Address:PortProcess',
  'udp   UNCONN 0      0                          127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=640,fd=13))',
  'udp   UNCONN 0      0                      10.0.2.15%enp0s3:68          0.0.0.0:*    users:(("systemd-network",pid=638,fd=18))',
  'udp   UNCONN 0      0                                0.0.0.0:5353       0.0.0.0:*    users:(("avahi-daemon",pid=700,fd=12))',
  'udp   UNCONN 0      0                                   [::]:5353          [::]:*    users:(("avahi-daemon",pid=700,fd=13))',
  'udp   UNCONN 0      0                                      *:51820            *:*',
  'tcp   LISTEN 0      4096                       127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=640,fd=14))',
  'tcp   LISTEN 0      128                              0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=812,fd=3))',
  'tcp   LISTEN 0      511                                    *:80               *:*    users:(("apache2",pid=1201,fd=4),("apache2",pid=1200,fd=4),("apache2",pid=1199,fd=4))',
  'tcp   LISTEN 0      244                            127.0.0.1:5432       0.0.0.0:*    users:(("postgres",pid=1050,fd=6))',
  'tcp   LISTEN 0      128                                 [::]:22            [::]:*    users:(("sshd",pid=812,fd=4))',
  'tcp   LISTEN 0      4096                               [::1]:631           [::]:*    users:(("cupsd",pid=750,fd=6),("cupsd",pid=750,fd=7))',
  'tcp   LISTEN 0      4096   [fe80::a00:27ff:fe4e:66a1]%enp0s3:8080          [::]:*    users:(("tmux: server",pid=2000,fd=7))',
  'tcp   LISTEN 0      511                         192.168.1.20:443        0.0.0.0:*    users:(("nginx",pid=900,fd=8),("nginx",pid=899,fd=8))',
  ''
].join('\n');

// The same host seen by uid 1000: only the user's own socket shows an owner.
const SS_USER = [
  'Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess',
  'tcp   LISTEN 0      128          0.0.0.0:22         0.0.0.0:*',
  'tcp   LISTEN 0      4096       127.0.0.1:3000       0.0.0.0:*    users:(("node",pid=4242,fd=19))',
  'tcp   LISTEN 0      128             [::]:22            [::]:*',
  ''
].join('\n');

// CentOS 7 (iproute 4.11): IPv4 any prints as `*`, IPv6 is unbracketed, and
// very old builds print owners without the pid=/fd= keys.
const SS_CENTOS7 = [
  'Netid  State      Recv-Q Send-Q Local Address:Port               Peer Address:Port              ',
  'udp    UNCONN     0      0         *:68                    *:*                   users:(("dhclient",pid=1022,fd=6))',
  'tcp    LISTEN     0      128       *:22                    *:*                   users:(("sshd",pid=1033,fd=3))',
  'tcp    LISTEN     0      100    127.0.0.1:25                    *:*                   users:(("master",1258,13))',
  'tcp    LISTEN     0      128      :::22                   :::*                   users:(("sshd",pid=1033,fd=4))',
  'tcp    LISTEN     0      100     ::1:25                   :::*                   users:(("master",1258,14))',
  ''
].join('\n');

// net-tools `netstat -tulpnW`: UDP rows have no State column, program names
// may contain spaces, `-` means the owner is not visible.
const NETSTAT_ROOT = [
  'Active Internet connections (only servers)',
  'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name    ',
  'tcp        0      0 127.0.0.53:53           0.0.0.0:*               LISTEN      640/systemd-resolve ',
  'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      812/sshd: /usr/sbin ',
  'tcp6       0      0 :::22                   :::*                    LISTEN      812/sshd: /usr/sbin ',
  'tcp6       0      0 ::1:631                 :::*                    LISTEN      -                   ',
  'udp        0      0 127.0.0.53:53           0.0.0.0:*                           640/systemd-resolve ',
  'udp        0      0 0.0.0.0:68              0.0.0.0:*                           638/systemd-network ',
  'udp6       0      0 fe80::a00:27ff:fe4e:66a1:546 :::*                           -                   ',
  ''
].join('\n');

function ssOutput(uid: string, body: string): string {
  return `@@WEBSSH:uid ${uid}\n@@WEBSSH:ss\n${body}`;
}

describe('parseSsListeners', () => {
  it('parses scoped IPv4, bracketed IPv6 with scope, dual-stack * and multiple owners', () => {
    const { listeners, unparsed } = parseSsListeners(SS_ROOT);
    expect(unparsed).toEqual([]);
    expect(listeners).toHaveLength(13);
    expect(listeners[0]).toEqual({
      protocol: 'udp',
      state: 'UNCONN',
      address: '127.0.0.53',
      port: 53,
      scope: 'lo',
      exposure: 'loopback',
      processes: [{ name: 'systemd-resolve', pid: 640 }]
    });
    expect(listeners[1]).toMatchObject({ address: '10.0.2.15', scope: 'enp0s3', port: 68, exposure: 'address' });
    expect(listeners[4]).toMatchObject({ address: '*', port: 51820, exposure: 'all', processes: [] });
    expect(listeners[7]).toMatchObject({
      address: '*',
      port: 80,
      exposure: 'all',
      processes: [
        { name: 'apache2', pid: 1199 },
        { name: 'apache2', pid: 1200 },
        { name: 'apache2', pid: 1201 }
      ]
    });
    expect(listeners[9]).toMatchObject({ address: '::', port: 22, scope: null, exposure: 'all' });
    // One process holding two descriptors is listed once.
    expect(listeners[10]).toMatchObject({ address: '::1', exposure: 'loopback', processes: [{ name: 'cupsd', pid: 750 }] });
    expect(listeners[11]).toEqual({
      protocol: 'tcp',
      state: 'LISTEN',
      address: 'fe80::a00:27ff:fe4e:66a1',
      port: 8080,
      scope: 'enp0s3',
      exposure: 'address',
      processes: [{ name: 'tmux: server', pid: 2000 }]
    });
  });

  it('parses the old CentOS 7 layout and pid-less owner entries', () => {
    const { listeners, unparsed } = parseSsListeners(SS_CENTOS7);
    expect(unparsed).toEqual([]);
    expect(listeners.map((l) => [l.protocol, l.address, l.port, l.exposure])).toEqual([
      ['udp', '*', 68, 'all'],
      ['tcp', '*', 22, 'all'],
      ['tcp', '127.0.0.1', 25, 'loopback'],
      ['tcp', '::', 22, 'all'],
      ['tcp', '::1', 25, 'loopback']
    ]);
    expect(listeners[2]!.processes).toEqual([{ name: 'master', pid: 1258 }]);
  });

  it('treats a wildcard bound to one device as interface exposure', () => {
    const { listeners } = parseSsListeners('udp UNCONN 0 0 0.0.0.0%eth1:67 0.0.0.0:* users:(("dnsmasq",pid=77,fd=4))\n');
    expect(listeners[0]).toMatchObject({ address: '0.0.0.0', scope: 'eth1', exposure: 'interface' });
  });

  it('reports truncated and odd lines instead of guessing', () => {
    const { listeners, unparsed } = parseSsListeners(
      ['tcp   LISTEN 0      128          0.0.0.', 'tcp LISTEN 0 128 0.0.0.0:http 0.0.0.0:*', '', '   '].join('\n')
    );
    expect(listeners).toEqual([]);
    expect(unparsed).toEqual(['tcp   LISTEN 0      128          0.0.0.', 'tcp LISTEN 0 128 0.0.0.0:http 0.0.0.0:*']);
  });

  it('returns nothing for empty output', () => {
    expect(parseSsListeners('')).toEqual({ listeners: [], unparsed: [] });
  });
});

describe('parseNetstatListeners', () => {
  it('parses net-tools rows with and without a State column', () => {
    const { listeners, unparsed } = parseNetstatListeners(NETSTAT_ROOT);
    expect(unparsed).toEqual([]);
    expect(listeners.map((l) => [l.protocol, l.address, l.port, l.state, l.processes])).toEqual([
      ['tcp', '127.0.0.53', 53, 'LISTEN', [{ name: 'systemd-resolve', pid: 640 }]],
      ['tcp', '0.0.0.0', 22, 'LISTEN', [{ name: 'sshd: /usr/sbin', pid: 812 }]],
      ['tcp', '::', 22, 'LISTEN', [{ name: 'sshd: /usr/sbin', pid: 812 }]],
      ['tcp', '::1', 631, 'LISTEN', []],
      ['udp', '127.0.0.53', 53, null, [{ name: 'systemd-resolve', pid: 640 }]],
      ['udp', '0.0.0.0', 68, null, [{ name: 'systemd-network', pid: 638 }]],
      ['udp', 'fe80::a00:27ff:fe4e:66a1', 546, null, []]
    ]);
  });
});

describe('listeningPortsTool', () => {
  it('previews one read-only script with the ss and netstat branches', () => {
    expect(listeningPortsTool.id).toBe('listening-ports');
    expect(listeningPortsTool.group).toBe('network');
    expect(listeningPortsTool.preview({})).toEqual([LISTENING_PORTS_COMMAND]);
    expect(LISTENING_PORTS_COMMAND).toBe(
      `sh -c 'export LC_ALL=C; PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"; echo "@@WEBSSH:uid $(id -u)"; ` +
        'if command -v ss >/dev/null 2>&1; then echo @@WEBSSH:ss; ss -tulpn; ' +
        `else echo @@WEBSSH:netstat; netstat -tulpnW; fi'`
    );
  });

  it('runs exactly the previewed command and warns on all-interface listeners', async () => {
    const commands = listeningPortsTool.preview({});
    const fake = fakeSession(repliesFor(commands, [{ stdout: ssOutput('0', SS_ROOT) }]));
    const result = await listeningPortsTool.run(fake.session, {});

    expect(fake.commands).toEqual(commands);
    expect(result.status).toBe('ok');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.command).toBe(LISTENING_PORTS_COMMAND);
    const warnings = result.findings.filter((f) => f.severity === 'warning').map((f) => f.title);
    expect(warnings).toEqual([
      'tcp/22 listens on all interfaces',
      'tcp/80 listens on all interfaces',
      'udp/5353 listens on all interfaces',
      'udp/51820 listens on all interfaces'
    ]);
    const ssh = result.findings.find((f) => f.title === 'tcp/22 listens on all interfaces')!;
    expect(ssh.detail).toBe('Bound to 0.0.0.0 and [::]; process sshd (pid 812).');

    const rows = result.tables[0]!.rows;
    expect(rows.map((r) => `${r.protocol}/${r.port} ${r.address}`)).toEqual([
      'tcp/22 0.0.0.0',
      'tcp/22 [::]',
      'tcp/53 127.0.0.53',
      'udp/53 127.0.0.53',
      'udp/68 10.0.2.15',
      'tcp/80 *',
      'tcp/443 192.168.1.20',
      'tcp/631 [::1]',
      'udp/5353 0.0.0.0',
      'udp/5353 [::]',
      'tcp/5432 127.0.0.1',
      'tcp/8080 [fe80::a00:27ff:fe4e:66a1]',
      'udp/51820 *'
    ]);
    // Root sees every owner; a socket without one is reported as such, not hidden.
    const wireguard = rows.find((r) => r.port === 51820)!;
    expect(wireguard.process).toBe('no owning process');
    expect(wireguard.pid).toBe('');
    expect(rows.find((r) => r.port === 80)!.pid).toBe('1199, 1200, 1201');
    expect(rows.find((r) => r.port === 8080)!.interface).toBe('enp0s3');
  });

  it('is partial without root and leaves hidden owners null', async () => {
    const commands = listeningPortsTool.preview({});
    const fake = fakeSession(repliesFor(commands, [{ stdout: ssOutput('1000', SS_USER) }]));
    const result = await listeningPortsTool.run(fake.session, {});

    expect(fake.commands).toEqual(commands);
    expect(result.status).toBe('partial');
    expect(result.notes.join(' ')).toMatch(/2 listeners show no owning process.*root/);
    const rows = result.tables[0]!.rows;
    const sshRows = rows.filter((r) => r.port === 22);
    expect(sshRows.map((r) => [r.process, r.pid])).toEqual([
      [null, null],
      [null, null]
    ]);
    expect(rows.find((r) => r.port === 3000)).toMatchObject({ process: 'node', pid: '4242', exposure: 'Loopback only' });
    expect(result.findings.find((f) => f.title === 'tcp/22 listens on all interfaces')!.detail).toBe(
      'Bound to 0.0.0.0 and [::]; owning process not visible without root.'
    );
  });

  it('falls back to netstat when ss is missing', async () => {
    const commands = listeningPortsTool.preview({});
    const fake = fakeSession(
      repliesFor(commands, [{ stdout: `@@WEBSSH:uid 0\n@@WEBSSH:netstat\n${NETSTAT_ROOT}` }])
    );
    const result = await listeningPortsTool.run(fake.session, {});
    expect(fake.commands).toEqual(commands);
    expect(result.status).toBe('ok');
    expect(result.notes).toContain('ss is not installed; listeners come from netstat.');
    expect(result.tables[0]!.rows).toHaveLength(7);
  });

  it('is unavailable when neither ss nor netstat exists', async () => {
    const commands = listeningPortsTool.preview({});
    const fake = fakeSession(
      repliesFor(commands, [
        { stdout: '@@WEBSSH:uid 1000\n@@WEBSSH:netstat\n', stderr: 'sh: 1: netstat: not found\n', exitCode: 127 }
      ])
    );
    const result = await listeningPortsTool.run(fake.session, {});
    expect(fake.commands).toEqual(commands);
    expect(result.status).toBe('unavailable');
    expect(result.tables).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.evidence).toHaveLength(1);
  });

  it('is partial when the socket table itself needs privileges', async () => {
    const commands = listeningPortsTool.preview({});
    const fake = fakeSession(
      repliesFor(commands, [
        { stdout: '@@WEBSSH:uid 1000\n@@WEBSSH:ss\n', stderr: 'Cannot open netlink socket: Permission denied\n', exitCode: 1 }
      ])
    );
    const result = await listeningPortsTool.run(fake.session, {});
    expect(result.status).toBe('partial');
    expect(result.summary).toMatch(/root/);
    expect(result.tables).toEqual([]);
  });

  it('reports a failing probe as an error with its message', async () => {
    const commands = listeningPortsTool.preview({});
    const fake = fakeSession(
      repliesFor(commands, [
        { stdout: '@@WEBSSH:uid 501\n@@WEBSSH:netstat\n', stderr: 'netstat: option requires an argument -- p\n', exitCode: 64 }
      ])
    );
    const result = await listeningPortsTool.run(fake.session, {});
    expect(result.status).toBe('error');
    expect(result.summary).toContain('netstat: option requires an argument -- p');
  });

  it('does not report "0 listeners" when the tool complained and exited 0', async () => {
    // BSD netstat (seen on macOS) rejects -tulpnW on stderr but exits 0.
    const commands = listeningPortsTool.preview({});
    const fake = fakeSession(
      repliesFor(commands, [
        { stdout: '@@WEBSSH:uid 501\n@@WEBSSH:netstat\n', stderr: 'netstat: nW: unknown or uninstrumented protocol: Undefined error: 0\n', exitCode: 0 }
      ])
    );
    const result = await listeningPortsTool.run(fake.session, {});
    expect(result.status).toBe('error');
    expect(result.summary).toBe('The socket probe failed: netstat: nW: unknown or uninstrumented protocol: Undefined error: 0');
    expect(result.tables).toEqual([]);
  });

  it('marks unparseable lines partial and keeps them out of the table', async () => {
    const commands = listeningPortsTool.preview({});
    const body = `${SS_USER}tcp   LISTEN 0      128          0.0.0.\n`;
    const fake = fakeSession(repliesFor(commands, [{ stdout: ssOutput('0', body) }]));
    const result = await listeningPortsTool.run(fake.session, {});
    expect(result.status).toBe('partial');
    expect(result.notes).toContain('1 line of socket output could not be parsed; see the evidence.');
    expect(result.tables[0]!.rows).toHaveLength(3);
  });

  it('propagates a transport failure instead of inventing a result', async () => {
    const commands = listeningPortsTool.preview({});
    const fake = fakeSession(repliesFor(commands, [new Error('connection closed')]));
    await expect(listeningPortsTool.run(fake.session, {})).rejects.toThrow('connection closed');
  });
});
