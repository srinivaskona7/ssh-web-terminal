import { describe, expect, it } from 'vitest';
import { HostRegistry, parseOpenSshConfig } from './index';

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
});
