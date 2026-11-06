import { describe, expect, it } from 'vitest';
import {
  NET_CONFIG_COMMANDS,
  netConfigTool,
  parseIpAddrJson,
  parseIpRouteJson,
  parseResolvConf
} from './net-config.js';
import { fakeSession, repliesFor } from '../system/testing/fake-session.js';

// `ip -j addr show` from Ubuntu 22.04 (iproute2 5.15): loopback, a DHCP NIC,
// docker0 with no containers (DOWN, NO-CARRIER), a WireGuard tunnel without a
// link-layer address, and a veth that has no addresses at all.
const IP_ADDR = JSON.stringify([
  {
    ifindex: 1,
    ifname: 'lo',
    flags: ['LOOPBACK', 'UP', 'LOWER_UP'],
    mtu: 65536,
    qdisc: 'noqueue',
    operstate: 'UNKNOWN',
    group: 'default',
    txqlen: 1000,
    link_type: 'loopback',
    address: '00:00:00:00:00:00',
    broadcast: '00:00:00:00:00:00',
    addr_info: [
      { family: 'inet', local: '127.0.0.1', prefixlen: 8, scope: 'host', label: 'lo', valid_life_time: 4294967295, preferred_life_time: 4294967295 },
      { family: 'inet6', local: '::1', prefixlen: 128, scope: 'host', valid_life_time: 4294967295, preferred_life_time: 4294967295 }
    ]
  },
  {
    ifindex: 2,
    ifname: 'enp0s3',
    flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'],
    mtu: 1500,
    qdisc: 'fq_codel',
    operstate: 'UP',
    group: 'default',
    txqlen: 1000,
    link_type: 'ether',
    address: '08:00:27:4e:66:a1',
    broadcast: 'ff:ff:ff:ff:ff:ff',
    addr_info: [
      { family: 'inet', local: '10.0.2.15', prefixlen: 24, broadcast: '10.0.2.255', scope: 'global', dynamic: true, noprefixroute: true, label: 'enp0s3', valid_life_time: 86255, preferred_life_time: 86255 },
      { family: 'inet6', local: '2001:db8:0:1::15', prefixlen: 64, scope: 'global', dynamic: true, mngtmpaddr: true, valid_life_time: 86397, preferred_life_time: 14397 },
      { family: 'inet6', local: 'fe80::a00:27ff:fe4e:66a1', prefixlen: 64, scope: 'link', noprefixroute: true, valid_life_time: 4294967295, preferred_life_time: 4294967295 }
    ]
  },
  {
    ifindex: 3,
    ifname: 'docker0',
    flags: ['NO-CARRIER', 'BROADCAST', 'MULTICAST', 'UP'],
    mtu: 1500,
    qdisc: 'noqueue',
    operstate: 'DOWN',
    group: 'default',
    link_type: 'ether',
    address: '02:42:9a:3b:11:0c',
    broadcast: 'ff:ff:ff:ff:ff:ff',
    addr_info: [
      { family: 'inet', local: '172.17.0.1', prefixlen: 16, broadcast: '172.17.255.255', scope: 'global', label: 'docker0', valid_life_time: 4294967295, preferred_life_time: 4294967295 }
    ]
  },
  {
    ifindex: 4,
    ifname: 'wg0',
    flags: ['POINTOPOINT', 'NOARP', 'UP', 'LOWER_UP'],
    mtu: 1420,
    qdisc: 'noqueue',
    operstate: 'UNKNOWN',
    group: 'default',
    txqlen: 1000,
    link_type: 'none',
    addr_info: [{ family: 'inet', local: '10.8.0.1', prefixlen: 24, scope: 'global', label: 'wg0', valid_life_time: 4294967295, preferred_life_time: 4294967295 }]
  },
  {
    ifindex: 9,
    link_index: 8,
    ifname: 'veth3f2a1b0',
    flags: ['BROADCAST', 'MULTICAST'],
    mtu: 1500,
    qdisc: 'noop',
    master: 'docker0',
    operstate: 'DOWN',
    group: 'default',
    link_type: 'ether',
    address: '6a:1c:22:90:fe:01',
    broadcast: 'ff:ff:ff:ff:ff:ff',
    link_netnsid: 0,
    addr_info: []
  }
]);

const IP_ROUTE = JSON.stringify([
  { dst: 'default', gateway: '10.0.2.2', dev: 'enp0s3', protocol: 'dhcp', prefsrc: '10.0.2.15', metric: 100, flags: [] },
  { dst: '10.0.2.0/24', dev: 'enp0s3', protocol: 'kernel', scope: 'link', prefsrc: '10.0.2.15', metric: 100, flags: [] },
  { dst: '172.17.0.0/16', dev: 'docker0', protocol: 'kernel', scope: 'link', prefsrc: '172.17.0.1', flags: ['linkdown'] },
  { type: 'blackhole', dst: '192.0.2.0/24', protocol: 'static', flags: [] }
]);

const IP6_ROUTE = JSON.stringify([
  { dst: '::1', dev: 'lo', protocol: 'kernel', metric: 256, pref: 'medium' },
  { dst: '2001:db8:0:1::/64', dev: 'enp0s3', protocol: 'ra', metric: 100, expires: 86397, pref: 'medium' },
  { dst: 'fe80::/64', dev: 'enp0s3', protocol: 'kernel', metric: 256, pref: 'medium' },
  { dst: 'default', gateway: 'fe80::1', dev: 'enp0s3', protocol: 'ra', metric: 100, expires: 1797, flags: [], pref: 'medium' }
]);

const RESOLV_STUB = [
  '# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).',
  '# Do not edit.',
  '',
  'nameserver 127.0.0.53',
  'options edns0 trust-ad',
  'search corp.example.com example.com',
  ''
].join('\n');

describe('net-config parsers', () => {
  it('reads interfaces with state, MTU, MAC and per-family addresses', () => {
    const interfaces = parseIpAddrJson(IP_ADDR);
    expect(interfaces).not.toBeNull();
    expect(interfaces!.map((i) => i.name)).toEqual(['lo', 'enp0s3', 'docker0', 'wg0', 'veth3f2a1b0']);
    expect(interfaces![1]).toEqual({
      index: 2,
      name: 'enp0s3',
      state: 'UP',
      flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'],
      mtu: 1500,
      mac: '08:00:27:4e:66:a1',
      ipv4: ['10.0.2.15/24'],
      ipv6: ['2001:db8:0:1::15/64', 'fe80::a00:27ff:fe4e:66a1/64 (link)']
    });
    expect(interfaces![3]).toMatchObject({ name: 'wg0', mac: null, ipv4: ['10.8.0.1/24'], ipv6: [] });
  });

  it('rejects text that is not ip JSON', () => {
    expect(parseIpAddrJson('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN')).toBeNull();
    expect(parseIpAddrJson('{"not":"an array"}')).toBeNull();
    expect(parseIpAddrJson('')).toBeNull();
  });

  it('reads routes, marks defaults and folds multipath next hops', () => {
    const routes = parseIpRouteJson(IP_ROUTE, 'IPv4');
    expect(routes).not.toBeNull();
    expect(routes![0]).toEqual({
      family: 'IPv4',
      destination: 'default',
      gateway: '10.0.2.2',
      device: 'enp0s3',
      protocol: 'dhcp',
      metric: 100,
      source: '10.0.2.15',
      type: 'unicast',
      isDefault: true
    });
    expect(routes![3]).toMatchObject({ destination: '192.0.2.0/24', type: 'blackhole', device: null, gateway: null });
    const multipath = parseIpRouteJson(
      JSON.stringify([
        {
          dst: 'default',
          protocol: 'static',
          metric: 1024,
          flags: [],
          nexthops: [
            { gateway: '10.0.0.1', dev: 'eth0', weight: 1, flags: [] },
            { gateway: '10.0.0.2', dev: 'eth1', weight: 1, flags: [] }
          ]
        }
      ]),
      'IPv4'
    );
    expect(multipath![0]).toMatchObject({ gateway: '10.0.0.1, 10.0.0.2', device: 'eth0, eth1', isDefault: true });
  });

  it('reads nameservers, search domains and options from resolv.conf', () => {
    expect(parseResolvConf(RESOLV_STUB)).toEqual({
      nameservers: ['127.0.0.53'],
      search: ['corp.example.com', 'example.com'],
      options: ['edns0', 'trust-ad'],
      entries: [
        { setting: 'nameserver', value: '127.0.0.53', line: 4 },
        { setting: 'options', value: 'edns0 trust-ad', line: 5 },
        { setting: 'search', value: 'corp.example.com example.com', line: 6 }
      ]
    });
    const odd = parseResolvConf(
      ['; old style comment', 'domain example.org', 'nameserver   fe80::1%eth0   # router', 'nameserver 1.1.1.1', 'nameserver 8.8.8.8', 'nameserver 9.9.9.9'].join('\n')
    );
    expect(odd.nameservers).toEqual(['fe80::1%eth0', '1.1.1.1', '8.8.8.8', '9.9.9.9']);
    // `domain` is the search list when no `search` line exists.
    expect(odd.search).toEqual(['example.org']);
  });
});

describe('netConfigTool', () => {
  it('previews the four read-only commands', () => {
    expect(netConfigTool.id).toBe('net-config');
    expect(netConfigTool.preview({})).toEqual(NET_CONFIG_COMMANDS);
    expect(NET_CONFIG_COMMANDS).toEqual([
      'PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin" ip -j addr show',
      'PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin" ip -j route show',
      'PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin" ip -j -6 route show',
      'cat /etc/resolv.conf'
    ]);
  });

  it('builds interface, route and DNS tables with the default routes first', async () => {
    const fake = fakeSession(
      repliesFor(NET_CONFIG_COMMANDS, [{ stdout: IP_ADDR }, { stdout: IP_ROUTE }, { stdout: IP6_ROUTE }, { stdout: RESOLV_STUB }])
    );
    const result = await netConfigTool.run(fake.session, {});
    expect(fake.commands).toEqual(NET_CONFIG_COMMANDS);
    expect(result.status).toBe('ok');
    expect(result.evidence.map((e) => e.command)).toEqual(NET_CONFIG_COMMANDS);

    const [interfaces, routes, dns] = result.tables;
    expect(interfaces!.rows[2]).toEqual({
      interface: 'docker0',
      state: 'DOWN (no carrier)',
      mtu: 1500,
      mac: '02:42:9a:3b:11:0c',
      ipv4: '172.17.0.1/16',
      ipv6: ''
    });
    expect(interfaces!.rows[3]!.mac).toBe('');
    expect(routes!.rows.slice(0, 2).map((r) => [r.family, r.destination, r.gateway, r.default])).toEqual([
      ['IPv4', 'default', '10.0.2.2', 'yes'],
      ['IPv6', 'default', 'fe80::1', 'yes']
    ]);
    expect(routes!.rows.find((r) => r.destination === '172.17.0.0/16')!.metric).toBeNull();
    expect(dns!.rows.map((r) => r.setting)).toEqual(['nameserver', 'options', 'search']);

    const titles = result.findings.map((f) => f.title);
    expect(titles).toContain('IPv4 default route via 10.0.2.2 on enp0s3');
    expect(titles).toContain('IPv6 default route via fe80::1 on enp0s3');
    expect(titles).toContain('docker0 is DOWN (no carrier)');
    expect(result.findings.find((f) => f.title.startsWith('DNS goes through'))!.severity).toBe('info');
    expect(result.findings.some((f) => f.severity === 'warning' || f.severity === 'critical')).toBe(false);
  });

  it('warns about a missing default route, missing nameservers and more than three nameservers', async () => {
    const routes = JSON.stringify([{ dst: '10.0.2.0/24', dev: 'enp0s3', protocol: 'kernel', scope: 'link', prefsrc: '10.0.2.15', flags: [] }]);
    const resolv = 'nameserver 10.0.0.2\nnameserver 10.0.0.3\nnameserver 10.0.0.4\nnameserver 10.0.0.5\n';
    const fake = fakeSession(repliesFor(NET_CONFIG_COMMANDS, [{ stdout: IP_ADDR }, { stdout: routes }, { stdout: '[]' }, { stdout: resolv }]));
    const result = await netConfigTool.run(fake.session, {});
    const warnings = result.findings.filter((f) => f.severity === 'warning').map((f) => f.title);
    expect(warnings).toEqual(['No IPv4 default route', 'Only the first 3 of 4 nameservers are used']);

    const empty = fakeSession(repliesFor(NET_CONFIG_COMMANDS, [{ stdout: IP_ADDR }, { stdout: IP_ROUTE }, { stdout: '[]' }, { stdout: '# nothing\n' }]));
    const noDns = await netConfigTool.run(empty.session, {});
    expect(noDns.findings.find((f) => f.title === 'No nameserver in /etc/resolv.conf')!.severity).toBe('warning');
  });

  it('is unavailable when ip does not support -j, and still shows the resolver data', async () => {
    const unknown = { stderr: 'Option "-j" is unknown, try "ip -help".\n', exitCode: 255 };
    const fake = fakeSession(repliesFor(NET_CONFIG_COMMANDS, [unknown, unknown, unknown, { stdout: RESOLV_STUB }]));
    const result = await netConfigTool.run(fake.session, {});
    expect(fake.commands).toEqual(NET_CONFIG_COMMANDS);
    expect(result.status).toBe('unavailable');
    expect(result.summary).toMatch(/JSON/);
    expect(result.tables.map((t) => t.id)).toEqual(['dns']);
    expect(result.evidence).toHaveLength(4);
  });

  it('is unavailable when ip is not installed', async () => {
    const missing = { stderr: 'bash: line 1: ip: command not found\n', exitCode: 127 };
    const fake = fakeSession(repliesFor(NET_CONFIG_COMMANDS, [missing, missing, missing, { stdout: RESOLV_STUB }]));
    const result = await netConfigTool.run(fake.session, {});
    expect(result.status).toBe('unavailable');
    expect(result.summary).toBe('ip (iproute2) is not installed on this server.');
  });

  it('reports an interface read failure that is not about JSON, keeping the resolver data', async () => {
    const denied = { stderr: 'Cannot open netlink socket: Operation not permitted\n', exitCode: 1 };
    const fake = fakeSession(repliesFor(NET_CONFIG_COMMANDS, [denied, denied, denied, { stdout: RESOLV_STUB }]));
    const result = await netConfigTool.run(fake.session, {});
    expect(result.status).toBe('partial');
    expect(result.summary).toBe('Interfaces could not be read: Cannot open netlink socket: Operation not permitted');
    expect(result.tables.map((t) => t.id)).toEqual(['dns']);

    const broken = { stderr: 'Cannot send dump request: Connection refused\n', exitCode: 1 };
    const failed = await netConfigTool.run(fakeSession(repliesFor(NET_CONFIG_COMMANDS, [broken, broken, broken, { stdout: RESOLV_STUB }])).session, {});
    expect(failed.status).toBe('error');
  });

  it('summarises counts it has and omits counts it does not', async () => {
    const ok = await netConfigTool.run(
      fakeSession(repliesFor(NET_CONFIG_COMMANDS, [{ stdout: IP_ADDR }, { stdout: IP_ROUTE }, { stdout: IP6_ROUTE }, { stdout: RESOLV_STUB }])).session,
      {}
    );
    // lo, enp0s3 and wg0 are up; docker0 has no carrier and the veth is admin-down.
    expect(ok.summary).toBe('5 interfaces (3 up), 4 IPv4 routes, 4 IPv6 routes, 1 nameserver.');
    const unread = await netConfigTool.run(
      fakeSession(
        repliesFor(NET_CONFIG_COMMANDS, [
          { stdout: IP_ADDR },
          { stdout: 'default via 10.0.2.2 dev enp0s3\n' },
          { stdout: IP6_ROUTE },
          { stderr: 'cat: /etc/resolv.conf: Permission denied\n', exitCode: 1 }
        ])
      ).session,
      {}
    );
    expect(unread.summary).toBe('5 interfaces (3 up), 4 IPv6 routes.');
  });

  it('is partial when routes are not JSON or resolv.conf is unreadable, without inventing either', async () => {
    const fake = fakeSession(
      repliesFor(NET_CONFIG_COMMANDS, [
        { stdout: IP_ADDR },
        { stdout: 'default via 10.0.2.2 dev enp0s3 proto dhcp metric 100\n' },
        { stdout: '[]' },
        { stderr: 'cat: /etc/resolv.conf: Permission denied\n', exitCode: 1 }
      ])
    );
    const result = await netConfigTool.run(fake.session, {});
    expect(result.status).toBe('partial');
    expect(result.notes).toContain('IPv4 routes were not returned as JSON by this ip build; see the evidence.');
    expect(result.notes).toContain('/etc/resolv.conf could not be read: cat: /etc/resolv.conf: Permission denied');
    expect(result.tables.map((t) => t.id)).toEqual(['interfaces', 'routes']);
    expect(result.findings.some((f) => /default route/i.test(f.title))).toBe(false);
  });

  it('treats a disabled IPv6 stack and a missing resolv.conf as facts, not gaps', async () => {
    const fake = fakeSession(
      repliesFor(NET_CONFIG_COMMANDS, [
        { stdout: IP_ADDR },
        { stdout: IP_ROUTE },
        { stderr: 'RTNETLINK answers: Address family not supported by protocol\n', exitCode: 2 },
        { stderr: 'cat: /etc/resolv.conf: No such file or directory\n', exitCode: 1 }
      ])
    );
    const result = await netConfigTool.run(fake.session, {});
    expect(result.status).toBe('ok');
    expect(result.notes).toContain('IPv6 is disabled on this server.');
    expect(result.findings.find((f) => f.title === 'No /etc/resolv.conf')!.severity).toBe('warning');
  });
});
