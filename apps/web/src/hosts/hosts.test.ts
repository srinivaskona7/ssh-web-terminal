import { describe, expect, it, vi } from 'vitest';
import {
  HostRegistry,
  buildConnectJumpHops,
  parseOpenSshConfig,
  validateEnvVars,
  type HostJumpHop,
  type HostProfile
} from './index';

describe('HostRegistry and ~/.ssh/config parser with ProxyJump resolution (M6/M7)', () => {
  it('parses Host, HostName, User, Port, and multi-hop ProxyJump chains while ignoring wildcards', () => {
    const sampleConfig = [
      '# Global wildcard ignored',
      'Host *',
      '  ServerAliveInterval 30',
      '',
      'Host bastion',
      '  HostName bastion.example.com',
      '  User jumpuser',
      '  Port 2222',
      '',
      'Host internal-db',
      '  HostName 10.20.1.50',
      '  User dbadmin',
      '  Port 22',
      '  ProxyJump bastion,secops@10.20.0.5:2200'
    ].join(String.fromCharCode(10));

    const profiles = parseOpenSshConfig(sampleConfig, 'ubuntu');
    expect(profiles).toHaveLength(2);

    const db = profiles.find((p) => p.alias === 'internal-db')!;
    expect(db.host).toBe('10.20.1.50');
    expect(db.user).toBe('dbadmin');
    expect(db.jumpHops).toEqual([
      { host: 'bastion.example.com', port: 2222, user: 'jumpuser' },
      { host: '10.20.0.5', port: 2200, user: 'secops' }
    ]);
  });

  it('stores, filters, and sorts favorite hosts first', () => {
    const registry = new HostRegistry('webssh.test.hosts');
    registry.upsert({
      id: 'h1',
      alias: 'staging-api',
      host: 'staging.internal',
      port: 22,
      user: 'deploy',
      folder: 'Staging',
      tags: ['api', 'eu'],
      favorite: false,
      jumpHops: []
    });
    registry.upsert({
      id: 'h2',
      alias: 'alpha-prod',
      host: 'prod.internal',
      port: 22,
      user: 'root',
      folder: 'Production',
      tags: ['prod', 'us'],
      favorite: true,
      jumpHops: []
    });

    const all = registry.list();
    expect(all[0]?.alias).toBe('alpha-prod');
    expect(registry.list('staging')).toHaveLength(1);
    expect(registry.list('', 'Production')).toHaveLength(1);
  });

  it('preserves valid saved hosts even when storage contains malformed entries', () => {
    localStorage.setItem(
      'webssh.test.hosts.mixed',
      JSON.stringify([
        null,
        'corrupted-entry',
        { id: '', host: '' },
        {
          id: 'valid-host-1',
          alias: 'prod-bastion',
          host: '10.10.0.15',
          port: 2222,
          user: 'admin',
          tags: ['prod', 123],
          favorite: true
        }
      ])
    );
    const registry = new HostRegistry('webssh.test.hosts.mixed');
    const hosts = registry.list();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.id).toBe('valid-host-1');
    expect(hosts[0]?.alias).toBe('prod-bastion');
    expect(hosts[0]?.tags).toEqual(['prod']);
  });
});

describe('host profile JSON export and import', () => {
  const sample = {
    id: 'h-export-1',
    alias: 'build-box',
    host: '10.0.0.9',
    port: 22,
    user: 'ci',
    tags: ['build'],
    favorite: true,
    jumpHops: []
  };

  it('round-trips a profile and never emits key or password fields', () => {
    const source = new HostRegistry('webssh.test.export.a');
    source.upsert(sample);
    const json = source.exportJson();

    expect(json).not.toMatch(/password|privateKey|passphrase/i);
    expect(JSON.parse(json)).toMatchObject({ version: 1, hosts: [{ alias: 'build-box' }] });

    const target = new HostRegistry('webssh.test.export.b');
    const result = target.importJson(json);
    expect(result.imported.map((h) => h.alias)).toEqual(['build-box']);
    expect(result.skipped).toBe(0);
    expect(target.list().map((h) => h.host)).toEqual(['10.0.0.9']);
  });

  it('accepts a bare array and skips malformed entries without dropping the good ones', () => {
    const target = new HostRegistry('webssh.test.export.c');
    const result = target.importJson(
      JSON.stringify([
        sample,
        { id: 'no-host' },
        null,
        { id: 'h-2', alias: 'ok', host: 'ok.internal', port: 22, user: 'u', tags: [], favorite: false, jumpHops: [] }
      ])
    );
    expect(result.imported.map((h) => h.alias)).toEqual(['build-box', 'ok']);
    expect(result.skipped).toBe(2);
  });

  it('rejects input that is not JSON or not a host list', () => {
    const target = new HostRegistry('webssh.test.export.d');
    expect(() => target.importJson('not json')).toThrow('Not valid JSON');
    expect(() => target.importJson('{"nope": true}')).toThrow('Expected an array');
  });

  it('keeps lastConnectedAt so the Welcome recent-hosts list survives a reload', () => {
    const registry = new HostRegistry('webssh.test.recent');
    registry.upsert({ ...sample, lastConnectedAt: 1_700_000_000_000 });
    expect(registry.list()[0]?.lastConnectedAt).toBe(1_700_000_000_000);

    // A reconnect stamps a new time on the same profile instead of duplicating it.
    registry.upsert({ ...registry.list()[0]!, lastConnectedAt: 1_700_000_999_000 });
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.lastConnectedAt).toBe(1_700_000_999_000);

    const restored = new HostRegistry('webssh.test.recent');
    restored.importJson(registry.exportJson());
    expect(restored.list()[0]?.lastConnectedAt).toBe(1_700_000_999_000);
  });

  it('reports an unpersisted import instead of claiming success', () => {
    const target = new HostRegistry('webssh.test.export.f');
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {}
    });
    try {
      const result = target.importJson(JSON.stringify([sample]));
      expect(result.imported).toHaveLength(1);
      expect(result.persisted).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('host profile environment and per-hop credentials', () => {
  const base: HostProfile = {
    id: 'h-env',
    alias: 'app',
    host: 'app.internal',
    port: 22,
    user: 'deploy',
    tags: [],
    favorite: false,
    jumpHops: []
  };
  const savedHops: HostJumpHop[] = [
    { host: 'bastion', port: 22, user: 'jump', authMethod: 'remote_signer', keyFingerprint: 'SHA256:hopkey' },
    { host: 'inner', port: 2200, user: 'ops', authMethod: 'password' },
    { host: 'plain', port: 22, user: 'ops' }
  ];

  it('loads a profile saved before env and hop credentials existed exactly as it was', () => {
    localStorage.setItem(
      'webssh.test.hosts.legacy',
      JSON.stringify([
        {
          id: 'legacy-1',
          alias: 'db',
          host: '10.20.1.50',
          port: 22,
          user: 'dbadmin',
          tags: ['prod'],
          favorite: false,
          jumpHops: [{ host: 'bastion.example.com', port: 2222, user: 'jumpuser' }]
        }
      ])
    );
    const [profile] = new HostRegistry('webssh.test.hosts.legacy').list();
    expect(profile).toEqual({
      id: 'legacy-1',
      alias: 'db',
      host: '10.20.1.50',
      port: 22,
      user: 'dbadmin',
      tags: ['prod'],
      favorite: false,
      jumpHops: [{ host: 'bastion.example.com', port: 2222, user: 'jumpuser' }]
    });
    expect(profile!.env).toBeUndefined();
    expect(Object.keys(profile!.jumpHops[0]!).sort()).toEqual(['host', 'port', 'user']);
  });

  it('keeps env and hop auth settings through save, reload, export and import', () => {
    const registry = new HostRegistry('webssh.test.hosts.env');
    registry.upsert({ ...base, env: { LANG: 'en_US.UTF-8', APP_ENV: 'staging' }, jumpHops: savedHops });

    const reloaded = new HostRegistry('webssh.test.hosts.env').get('h-env');
    expect(reloaded?.env).toEqual({ LANG: 'en_US.UTF-8', APP_ENV: 'staging' });
    expect(reloaded?.jumpHops).toEqual(savedHops);

    const copy = new HostRegistry('webssh.test.hosts.env.copy');
    copy.importJson(registry.exportJson());
    expect(copy.get('h-env')).toEqual(reloaded);
  });

  it('never stores or exports a hop password, private key, passphrase or public key', () => {
    const leaky = {
      host: 'bastion',
      port: 22,
      user: 'jump',
      authMethod: 'password',
      password: 'hunter2',
      privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----',
      privateKeyPassphrase: 'open-sesame',
      publicKey: 'ssh-ed25519 AAAAC3Nza'
    } as unknown as HostJumpHop;
    const registry = new HostRegistry('webssh.test.hosts.secrets');
    registry.upsert({ ...base, jumpHops: [leaky] });

    const stored = localStorage.getItem('webssh.test.hosts.secrets') ?? '';
    for (const secret of ['hunter2', 'BEGIN OPENSSH', 'open-sesame', 'AAAAC3Nza']) {
      expect(stored).not.toContain(secret);
      expect(registry.exportJson()).not.toContain(secret);
    }
    expect(registry.get('h-env')?.jumpHops).toEqual([
      { host: 'bastion', port: 22, user: 'jump', authMethod: 'password' }
    ]);

    const imported = new HostRegistry('webssh.test.hosts.secrets.import');
    imported.importJson(JSON.stringify([{ ...base, jumpHops: [leaky] }]));
    expect(imported.get('h-env')?.jumpHops).toEqual([
      { host: 'bastion', port: 22, user: 'jump', authMethod: 'password' }
    ]);
  });

  it('drops env values that are not text and hop auth settings it does not recognise', () => {
    localStorage.setItem(
      'webssh.test.hosts.odd',
      JSON.stringify([
        {
          ...base,
          env: { LANG: 'C', COUNT: 3, NESTED: {} },
          jumpHops: [{ host: 'b', port: 22, user: 'u', authMethod: 'kerberos', keyFingerprint: 7 }]
        },
        { ...base, id: 'h-array-env', env: ['LANG=C'] }
      ])
    );
    const registry = new HostRegistry('webssh.test.hosts.odd');
    expect(registry.get('h-env')?.env).toEqual({ LANG: 'C' });
    expect(registry.get('h-env')?.jumpHops).toEqual([{ host: 'b', port: 22, user: 'u' }]);
    expect(registry.get('h-array-env')?.env).toBeUndefined();
  });

  it('re-exports the env validator the gateway applies', () => {
    expect(validateEnvVars({ LANG: 'C' })).toEqual([]);
    expect(validateEnvVars({ 'NOT-VALID': 'x' })).toEqual([
      { name: 'NOT-VALID', field: 'name', message: expect.any(String) }
    ]);
  });
});

describe('buildConnectJumpHops', () => {
  const hops: HostJumpHop[] = [
    { host: 'bastion', port: 22, user: 'jump', authMethod: 'remote_signer', keyFingerprint: 'SHA256:hop' },
    { host: 'inner', port: 2200, user: 'ops', authMethod: 'password' },
    { host: 'edge', port: 22, user: 'ops', authMethod: 'private_key' },
    { host: 'plain', port: 22, user: 'ops' }
  ];

  it("adds each hop's own credential and leaves an inheriting hop bare", () => {
    expect(
      buildConnectJumpHops(hops, [
        { publicKey: 'ssh-ed25519 AAAAhop' },
        { password: 'pw' },
        { privateKeyPem: 'PEM', privateKeyPassphrase: 'pp' },
        undefined
      ])
    ).toEqual([
      {
        host: 'bastion',
        port: 22,
        user: 'jump',
        authMethod: 'remote_signer',
        keyFingerprint: 'SHA256:hop',
        publicKey: 'ssh-ed25519 AAAAhop'
      },
      { host: 'inner', port: 2200, user: 'ops', authMethod: 'password', password: 'pw' },
      {
        host: 'edge',
        port: 22,
        user: 'ops',
        authMethod: 'private_key',
        privateKeyPem: 'PEM',
        privateKeyPassphrase: 'pp'
      },
      { host: 'plain', port: 22, user: 'ops' }
    ]);
  });

  it("refuses a hop whose credential is missing rather than letting it fall back to the target's", () => {
    expect(() => buildConnectJumpHops([hops[1]!], [])).toThrow(/hop 1 \(ops@inner:2200\).*password/i);
    expect(() => buildConnectJumpHops([hops[3]!, hops[2]!], [undefined, {}])).toThrow(
      /hop 2 \(ops@edge:22\).*private key/i
    );
    expect(() => buildConnectJumpHops([hops[0]!], [{}])).toThrow(/hop 1 .*public key/i);
    expect(() =>
      buildConnectJumpHops([{ ...hops[0]!, keyFingerprint: undefined }], [{ publicKey: 'ssh-ed25519 AAAA' }])
    ).toThrow(/hop 1 .*fingerprint/i);
  });

  it('ignores secrets handed in for a hop that reuses the target credentials', () => {
    expect(buildConnectJumpHops([hops[3]!], [{ password: 'stray' }])).toEqual([
      { host: 'plain', port: 22, user: 'ops' }
    ]);
  });
});
