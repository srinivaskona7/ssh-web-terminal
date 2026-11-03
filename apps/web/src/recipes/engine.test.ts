import { describe, expect, it } from 'vitest';
import type { ServerCapabilities } from '../discovery/capabilities.js';
import { getRecipe } from './catalog.js';
import {
  buildPlan,
  buildShellCommand,
  compareVersions,
  evaluateRecipe,
  posixQuote,
  redactValues,
  substituteArgv,
  validateFieldValue,
  validateValues,
  withDefaults,
  type RecipeSession
} from './engine.js';
import type { Recipe } from './types.js';

function caps(overrides: Partial<ServerCapabilities> = {}): ServerCapabilities {
  return {
    schemaVersion: 1,
    collectedAt: 0,
    hostname: 'host',
    os: { family: 'linux', distro: 'Ubuntu', version: '24.04', kernel: '6.8', arch: 'x86_64' },
    cpu: { cores: 2, model: 'x' },
    memory: { totalMiB: 2048, availableMiB: 1024, swapMiB: 0 },
    disks: [{ mount: '/', filesystem: '/dev/root', totalMiB: 20480, usedMiB: 10240, availableMiB: 10240, usePercent: 50 }],
    user: { name: 'ubuntu', uid: 1000, groups: ['sudo'], shell: '/bin/bash', home: '/home/ubuntu', isRoot: false },
    privilege: { sudoAvailable: true, sudoNopasswd: true, isRoot: false },
    packages: { manager: 'apt-get', repositories: 'configured' },
    init: { manager: 'systemd', systemd: true },
    tools: {},
    listeners: [],
    firewall: { tool: null, active: null },
    time: { synchronized: true, detail: '' },
    warnings: [],
    ...overrides
  };
}

const customRecipe: Recipe = {
  id: 'demo',
  version: '1.0.0',
  name: 'Demo',
  category: 'development',
  description: 'demo',
  license: 'MIT',
  versionInstalled: '1.0',
  support: { distros: ['ubuntu'], arch: ['x86_64'], minRamMiB: 512, minDiskMiB: 100 },
  privileges: 'sudo',
  fields: [
    { id: 'port', label: 'Port', description: '', type: 'port', required: true, sensitive: false, savable: true },
    { id: 'dir', label: 'Directory', description: '', type: 'path', required: true, sensitive: false, savable: true },
    { id: 'mode', label: 'Mode', description: '', type: 'enum', required: true, sensitive: false, savable: true, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { id: 'token', label: 'Token', description: '', type: 'secret', required: false, sensitive: true, savable: false },
    { id: 'extra', label: 'Extra', description: '', type: 'text', required: false, sensitive: false, savable: true, visibleWhen: { field: 'mode', equals: ['b'] } }
  ],
  steps: [{ id: 'install', title: 'Install', kind: 'exec', argv: ['tool', '--dir', '{{dir}}', '--port', '{{port}}'] }],
  verify: [{ id: 'verify', title: 'Verify', kind: 'exec', argv: ['tool', '--version'] }],
  rollback: 'supported'
};

describe('recipe validation and planning', () => {
  it('quotes POSIX safely and rejects NUL', () => {
    expect(posixQuote('plain')).toBe("'plain'");
    expect(posixQuote("it's")).toBe("'it'\\''s'");
    expect(buildShellCommand(['echo', 'a b', '$HOME'])).toBe("'echo' 'a b' '$HOME'");
    expect(() => posixQuote('bad\0value')).toThrow();
  });

  it('substitutes only validated values and rejects control characters', () => {
    const argv = substituteArgv(['cmd', '{{dir}}', '--port={{port}}'], { dir: '/srv/app', port: 8080 });
    expect(argv).toEqual(['cmd', '/srv/app', '--port=8080']);
    expect(() => substituteArgv(['cmd', '{{dir}}'], { dir: '/srv\nrm -rf /' })).toThrow(/control characters/);
    expect(() => substituteArgv(['cmd', '{{missing}}'], {})).toThrow(/Missing required variable/);
  });

  it('validates field types', () => {
    const port = customRecipe.fields[0]!;
    expect(validateFieldValue(port, 8080)).toBeNull();
    expect(validateFieldValue(port, 70000)).toMatchObject({ field: 'port' });
    expect(validateFieldValue(port, 'abc')).toMatchObject({ field: 'port' });
    const dir = customRecipe.fields[1]!;
    expect(validateFieldValue(dir, '/srv/app')).toBeNull();
    expect(validateFieldValue(dir, '--dangerous')).toMatchObject({ field: 'dir' });
    const hostnameField = { ...port, id: 'host', label: 'Host', type: 'hostname' as const };
    expect(validateFieldValue(hostnameField, 'example.com')).toBeNull();
    expect(validateFieldValue(hostnameField, 'not a host')).toMatchObject({ field: 'host' });
  });

  it('hides conditional fields and reports missing required ones', () => {
    const values = withDefaults(customRecipe, { port: 8080, dir: '/srv', mode: 'a' });
    expect(validateValues(customRecipe, values)).toEqual([]);
    const visible = validateValues(customRecipe, { port: 8080, dir: '/srv', mode: 'b' });
    expect(visible).toEqual([]);
  });

  it('blocks unsupported distributions before execution', () => {
    const plan = buildPlan(customRecipe, { port: 8080, dir: '/srv', mode: 'a' }, caps({ os: { ...caps().os, distro: 'Alpine' } }));
    expect(plan.canExecute).toBe(false);
    expect(plan.issues[0]?.code).toMatch(/RECIPE_UNSUPPORTED/);
  });

  it('blocks when sudo needs a password, rather than pretending it works', () => {
    const plan = buildPlan(
      customRecipe,
      { port: 8080, dir: '/srv', mode: 'a' },
      caps({ privilege: { sudoAvailable: true, sudoNopasswd: false, isRoot: false } })
    );
    expect(plan.canExecute).toBe(false);
    expect(plan.issues.some((i) => i.message.includes('sudo requires a password'))).toBe(true);
  });

  it('warns about port conflicts and low disk', () => {
    const plan = buildPlan(
      { ...customRecipe, provides: { ports: [8080] } },
      { port: 8080, dir: '/srv', mode: 'a' },
      caps({ listeners: [{ protocol: 'tcp', address: '0.0.0.0', port: 8080 }] })
    );
    expect(plan.canExecute).toBe(true);
    expect(plan.issues.some((i) => i.code === 'PORT_IN_USE')).toBe(true);

    const tiny = buildPlan(
      customRecipe,
      { port: 8080, dir: '/srv', mode: 'a' },
      caps({ disks: [{ mount: '/', filesystem: 'x', totalMiB: 100, usedMiB: 90, availableMiB: 10, usePercent: 90 }] })
    );
    expect(tiny.canExecute).toBe(false);
    expect(tiny.issues.some((i) => i.code === 'INSUFFICIENT_DISK')).toBe(true);
  });

  it('redacts secret values', () => {
    const redacted = redactValues(customRecipe, { port: 1, token: 'super-secret' });
    expect(redacted.token).toBe('[redacted]');
    expect(redacted.port).toBe(1);
  });

  it('compares versions and evaluates installation state', () => {
    expect(compareVersions('2.43.0', '2.40')).toBe(1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('bad', '1.0')).toBeNull();

    const installed = evaluateRecipe(customRecipe, caps({ tools: { demo: { id: 'demo', name: 'Demo', state: 'installed', version: '0.9' } } }));
    expect(installed.state).toBe('outdated');
    const current = evaluateRecipe(customRecipe, caps({ tools: { demo: { id: 'demo', name: 'Demo', state: 'installed', version: '1.4' } } }));
    expect(current.state).toBe('installed');
  });

  it('catalog recipes never use curl-pipe-to-shell installation', () => {
    const ids = ['git', 'python3', 'node', 'docker', 'nginx', 'psql', 'redis-cli', 'ansible'];
    for (const id of ids) {
      const recipe = getRecipe(id);
      expect(recipe, id).toBeDefined();
      const all = [
        ...(recipe!.steps ?? []),
        ...Object.values(recipe!.stepsByManager ?? {}).flat()
      ];
      for (const step of all) {
        if (step.kind === 'exec') {
          const joined = step.argv.join(' ');
          expect(joined).not.toMatch(/curl[^|]*\|\s*(sh|bash)/);
          expect(joined).not.toMatch(/wget[^|]*\|\s*(sh|bash)/);
        }
      }
    }
  });

  it('marks repository-dependent recipes as requiring configuration', () => {
    for (const id of ['kubectl', 'helm', 'terraform', 'k3s']) {
      const recipe = getRecipe(id)!;
      expect(recipe.requiresConfiguration, id).toBe(true);
      const plan = buildPlan(recipe, {}, caps());
      expect(plan.canExecute, id).toBe(false);
    }
  });

  it('executes a plan step by step and stops on failure', async () => {
    const calls: string[] = [];
    const session: RecipeSession = {
      capabilities: caps(),
      execStream: async (command) => {
        calls.push(command);
        return { stdout: '', stderr: '', exitCode: command.includes('fail') ? 2 : 0 };
      }
    };
    const { executePlan } = await import('./engine.js');
    const plan = buildPlan(
      { ...customRecipe, steps: [
        { id: 'ok', title: 'ok', kind: 'exec', argv: ['echo', 'ok'] },
        { id: 'fail', title: 'fail', kind: 'exec', argv: ['fail'] },
        { id: 'never', title: 'never', kind: 'exec', argv: ['echo', 'never'] }
      ] },
      { port: 8080, dir: '/srv', mode: 'a' },
      caps()
    );
    const result = await executePlan(plan, session, { asRoot: false });
    expect(result.ok).toBe(false);
    expect(result.outcomes.map((o) => o.status)).toEqual(['succeeded', 'failed']);
    expect(calls).toHaveLength(2);
  });
});
