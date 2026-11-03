import { describe, expect, it } from 'vitest';
import {
  addCronEntry,
  buildAutomationScript,
  parseCrontab,
  removeCronEntry,
  validateCronSchedule
} from '../automation/python-automation.js';
import { getAutomationTemplate } from '../automation/templates.js';
import { buildDeploymentPlan, detectProject } from '../projects/projects.js';
import {
  buildCancelCommand,
  buildPollCommand,
  buildStartCommand,
  parsePollOutput
} from './remote-job-runner.js';
import { buildRecipeScript as buildRecipeJobScript, parseJobMarkers } from './job-manager.js';
import { createJobId, isValidJobId, jobDirectory } from './types.js';

describe('durable job model', () => {
  it('creates and validates job ids', () => {
    const id = createJobId(1700000000000, () => 0.5);
    expect(isValidJobId(id)).toBe(true);
    expect(jobDirectory(id)).toBe(`$HOME/.webssh/jobs/${id}`);
    expect(() => jobDirectory('../../etc')).toThrow(/Invalid job id/);
    expect(isValidJobId('bad id')).toBe(false);
  });

  it('builds detached start commands with quoted ids and no shell interpolation', () => {
    const id = createJobId(1, () => 0.1);
    const setup = buildStartCommand(id, 'echo hi');
    expect(setup).toContain('base64 -d');
    expect(setup).toContain(`$HOME/.webssh/jobs/${id}`);
    expect(() => buildStartCommand('../../x', 'echo')).toThrow();
    expect(buildPollCommand(id)).toContain('@@EXIT');
    expect(buildCancelCommand(id)).toContain('kill -TERM');
  });

  it('parses poll output into running/exited states', () => {
    expect(parsePollOutput('@@RUNNING\n@@OUT\npartial\n@@ERR\n')).toMatchObject({
      running: true,
      exitCode: null,
      stdoutTail: 'partial\n'
    });
    expect(parsePollOutput('@@EXIT:0\n@@OUT\ndone\n@@ERR\n')).toMatchObject({
      running: false,
      exitCode: 0,
      stdoutTail: 'done\n'
    });
    expect(parsePollOutput('@@MISSING')).toMatchObject({ running: false, exitCode: null });
  });

  it('parses job step markers without treating partial logs as completion', () => {
    const parsed = parseJobMarkers(
      ['@@WEBSSH_JOB_STEP:a:Install a', '@@WEBSSH_JOB_STEP_OK:a', '@@WEBSSH_JOB_STEP_FAIL:b:3'].join('\n')
    );
    expect(parsed.completed.has('a')).toBe(true);
    expect(parsed.failed.get('b')).toBe(3);
    expect(parsed.done).toBe(false);
  });

  it('compiles recipe steps into a detached script with real failure propagation', () => {
    const script = buildRecipeJobScript(
      {
        recipeId: 'demo',
        recipeVersion: '1',
        issues: [],
        canExecute: true,
        requiredPrivilege: 'sudo',
        startedAt: 0,
        steps: [
          { id: 'one', title: 'One', kind: 'exec', argv: ['echo', 'hi'], asRoot: true },
          { id: 'two', title: 'Two', kind: 'exec', argv: ['true'], allowFailure: true },
          { id: 'three', title: 'Write', kind: 'writeFile', path: '/tmp/x', content: 'a\0b' }
        ]
      },
      true
    );
    expect(script).toContain("'sudo' '-n' '--' 'echo' 'hi'");
    expect(script).toContain('|| true');
    expect(script).toContain('@@WEBSSH_JOB_DONE');
    expect(script).not.toContain('\0');
  });
});

describe('cron scheduling', () => {
  it('rejects malformed schedules', () => {
    expect(validateCronSchedule('*/5 * * * *')).toBe('*/5 * * * *');
    expect(() => validateCronSchedule('* * * *')).toThrow();
    expect(() => validateCronSchedule('99 * * * *')).toThrow();
    expect(() => validateCronSchedule('0 0 0 0 0')).toThrow();
    expect(() => validateCronSchedule('* * * * *; rm -rf /')).toThrow();
  });

  it('adds and removes marked entries without touching user entries', () => {
    const existing = '0 3 * * * /usr/local/bin/backup\n';
    const added = addCronEntry(existing, {
      id: 'automation-1',
      schedule: '*/15 * * * *',
      command: '/usr/bin/python3 /srv/check.py',
      comment: 'health check'
    });
    expect(added).toContain('0 3 * * * /usr/local/bin/backup');
    expect(added).toContain('# webssh-job:automation-1');
    const entries = parseCrontab(added);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.id === 'automation-1')).toMatchObject({
      schedule: '*/15 * * * *',
      managed: true
    });
    const removed = removeCronEntry(added, 'automation-1');
    expect(removed).toContain('/usr/local/bin/backup');
    expect(removed).not.toContain('automation-1');
    expect(parseCrontab(removed)).toHaveLength(1);
  });

  it('builds automation scripts with validated env names', () => {
    const script = buildAutomationScript({
      workdir: '/srv/app',
      interpreter: '/srv/app/.venv/bin/python',
      script: 'job.py',
      args: ['--once'],
      env: { MODE: 'prod' }
    });
    expect(script).toContain("export MODE='prod'");
    expect(script).toContain("'/srv/app/.venv/bin/python' 'job.py' '--once'");
    expect(() =>
      buildAutomationScript({ workdir: '/srv', interpreter: 'python3', script: 'x.py', env: { 'BAD NAME': 'x' } })
    ).toThrow();
  });
});

describe('automation templates and deployment plans', () => {
  it('generates safe, reviewable scripts and defaults destructive templates to dry run', () => {
    const cleanup = getAutomationTemplate('artifact-cleanup')!;
    const dry = cleanup.build({ workdir: '/srv/app', target: '/srv/app', retentionDays: 3 });
    expect(dry).toContain('-print');
    expect(dry).not.toContain('-delete');
    const real = cleanup.build({ workdir: '/srv/app', target: '/srv/app', retentionDays: 3, dryRun: false });
    expect(real).toContain('-delete');
    expect(() => cleanup.build({ workdir: '/srv', target: 'relative/path' })).toThrow();
  });

  it('detects a Node project without executing anything', async () => {
    const session = {
      transport: 'cloudflare-relay' as const,
      host: 'h',
      user: 'u',
      port: 22,
      isConnected: () => true,
      exec: async (command: string) => {
        expect(command).toContain('[ -e');
        return { stdout: 'package.json\npackage-lock.json\n', stderr: '', exitCode: 0 };
      }
    };
    const project = await detectProject(session, '/srv/app');
    expect(project.type).toBe('node');
    expect(project.packageManager).toBe('npm');
    expect(project.buildCommand).toContain('npm ci');
  });

  it('builds a deployment plan and never promises rollback it cannot deliver', () => {
    const plan = buildDeploymentPlan(
      {
        type: 'node',
        directory: '/srv/app',
        manifests: ['package.json'],
        unitFiles: [],
        notes: []
      },
      { installDependencies: true, serviceName: 'app', healthUrl: 'http://127.0.0.1:3000/health' }
    );
    expect(plan.steps.map((s) => s.id)).toContain('revision');
    expect(plan.steps.map((s) => s.id)).toContain('service-restart');
    expect(plan.healthCheck?.command).toContain('curl');
    expect(plan.rollback).toBe('none');
    expect(plan.notes.join(' ')).toMatch(/briefly interrupt/);
  });
});
