import { posixQuote } from '../recipes/engine.js';
import type { RecipePlan, Recipe } from '../recipes/types.js';
import { executePlan, buildShellCommand, type RecipeSession } from '../recipes/engine.js';
import { jobStore } from './job-store.js';
import {
  pollDetachedJob,
  requestCancelDetachedJob,
  startDetachedJob,
  type JobSession
} from './remote-job-runner.js';
import {
  createJobId,
  type JobRecord,
  type JobServerRef,
  type JobStepRecord
} from './types.js';

const STEP_MARK = '@@WEBSSH_JOB_STEP';
const STEP_OK_MARK = '@@WEBSSH_JOB_STEP_OK';
const STEP_FAIL_MARK = '@@WEBSSH_JOB_STEP_FAIL';
const DONE_MARK = '@@WEBSSH_JOB_DONE';

/**
 * Compile recipe steps into one detached POSIX script. Every step is announced
 * with a marker so progress survives a browser reconnect and can be replayed
 * from the remote log.
 */
export function buildRecipeScript(plan: RecipePlan, asRoot: boolean): string {
  const lines: string[] = ['#!/bin/sh', 'set -u'];
  for (const step of plan.steps) {
    lines.push(`printf '%s\\n' ${posixQuote(`${STEP_MARK}:${step.id}:${step.title}`)}`);
    if (step.kind === 'exec') {
      const argv = step.resolvedArgv ?? step.argv;
      const needsRoot = (step.asRoot ?? false) && asRoot;
      const command = buildShellCommand(needsRoot ? ['sudo', '-n', '--', ...argv] : argv);
      if (step.allowFailure) {
        lines.push(`${command} || true`);
      } else {
        lines.push(`${command} || { code=$?; printf '%s\\n' ${posixQuote(`${STEP_FAIL_MARK}:${step.id}:`)}"$code"; exit "$code"; }`);
      }
    } else {
      const b64 = base64OfUtf8(step.content);
      const path = posixQuote(step.path);
      if (step.asRoot && asRoot) {
        lines.push(`printf %s ${posixQuote(b64)} | base64 -d | sudo -n tee ${path} > /dev/null`);
      } else {
        lines.push(`printf %s ${posixQuote(b64)} | base64 -d > ${path}`);
      }
      if (step.mode) {
        lines.push(`chmod ${posixQuote(step.mode)} ${path} || true`);
      }
    }
    lines.push(`printf '%s\\n' ${posixQuote(`${STEP_OK_MARK}:${step.id}`)}`);
  }
  lines.push(`printf '%s\\n' ${posixQuote(DONE_MARK)}`);
  return lines.join('\n');
}

function base64OfUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface ParsedMarkers {
  completed: Set<string>;
  failed: Map<string, number>;
  done: boolean;
}

export function parseJobMarkers(log: string): ParsedMarkers {
  const completed = new Set<string>();
  const failed = new Map<string, number>();
  let done = false;
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith(`${STEP_OK_MARK}:`)) {
      completed.add(line.slice(STEP_OK_MARK.length + 1).trim());
    } else if (line.startsWith(`${STEP_FAIL_MARK}:`)) {
      const rest = line.slice(STEP_FAIL_MARK.length + 1);
      const idx = rest.lastIndexOf(':');
      const id = idx === -1 ? rest : rest.slice(0, idx);
      const code = idx === -1 ? 1 : Number.parseInt(rest.slice(idx + 1), 10) || 1;
      failed.set(id.trim(), code);
    } else if (line.includes(DONE_MARK)) {
      done = true;
    }
  }
  return { completed, failed, done };
}

export interface StartRecipeJobInput {
  recipe: Recipe;
  plan: RecipePlan;
  /** Redacted variables for history. */
  variables: JobRecord['variables'];
  server: JobServerRef;
  session: JobSession;
}

export interface CommandJobStep {
  id: string;
  title: string;
  /** POSIX shell command, already quoted by the caller/planner. */
  command: string;
  allowFailure?: boolean;
}

/**
 * Compile plain shell commands into one detached script with the same step
 * markers as recipes, so builds and deployments share progress reporting,
 * reattachment and history.
 */
export function buildCommandScript(steps: CommandJobStep[]): string {
  const lines: string[] = ['#!/bin/sh', 'set -u'];
  for (const step of steps) {
    lines.push(`printf '%s\\n' ${posixQuote(`${STEP_MARK}:${step.id}:${step.title}`)}`);
    // A step may be a compound command (`cd x && a; b`). Without the subshell,
    // `||` would only guard the last command in the list.
    const grouped = `( ${step.command} )`;
    if (step.allowFailure) {
      lines.push(`${grouped} || true`);
    } else {
      lines.push(
        `${grouped} || { code=$?; printf '%s\\n' ${posixQuote(`${STEP_FAIL_MARK}:${step.id}:`)}"$code"; exit "$code"; }`
      );
    }
    lines.push(`printf '%s\\n' ${posixQuote(`${STEP_OK_MARK}:${step.id}`)}`);
  }
  lines.push(`printf '%s\\n' ${posixQuote(DONE_MARK)}`);
  return lines.join('\n');
}

export interface StartCommandJobInput {
  kind: JobRecord['kind'];
  title: string;
  recipeId?: string;
  recipeVersion?: string;
  steps: CommandJobStep[];
  variables?: JobRecord['variables'];
  server: JobServerRef;
  session: JobSession;
}

/** Start a detached job made of shell steps (builds, deployments, checks). */
export async function startCommandJob(input: StartCommandJobInput): Promise<JobRecord> {
  const id = createJobId();
  const script = buildCommandScript(input.steps);
  const now = Date.now();
  const record: JobRecord = {
    id,
    kind: input.kind,
    title: input.title,
    server: input.server,
    recipeId: input.recipeId,
    recipeVersion: input.recipeVersion,
    state: 'queued',
    createdAt: now,
    updatedAt: now,
    steps: input.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: 'pending'
    })),
    variables: input.variables ?? {},
    attached: true
  };
  await jobStore.save(record);
  try {
    const { pid } = await startDetachedJob(input.session, id, script);
    record.pid = pid;
    record.state = 'running';
    record.startedAt = now;
    record.remoteDir = `~/.webssh/jobs/${id}`;
    await jobStore.save(record);
    return record;
  } catch (err) {
    record.state = 'failed';
    record.endedAt = Date.now();
    record.error = err instanceof Error ? err.message : String(err);
    await jobStore.save(record);
    return record;
  }
}

export async function startRecipeJob(input: StartRecipeJobInput): Promise<JobRecord> {
  if (!input.plan.canExecute) {
    throw new Error('Cannot start a job whose plan has blocking preflight issues');
  }
  const id = createJobId();
  const asRoot = input.session.executeAsRoot ?? true;
  const script = buildRecipeScript(input.plan, asRoot);
  const now = Date.now();
  const steps: JobStepRecord[] = input.plan.steps.map((step) => ({
    id: step.id,
    title: step.title,
    status: 'pending'
  }));
  const record: JobRecord = {
    id,
    kind: 'install',
    title: `Install ${input.recipe.name}`,
    server: input.server,
    recipeId: input.recipe.id,
    recipeVersion: input.recipe.version,
    state: 'queued',
    createdAt: now,
    updatedAt: now,
    steps,
    variables: input.variables,
    attached: true
  };
  await jobStore.save(record);
  try {
    const { pid } = await startDetachedJob(input.session, id, script);
    record.pid = pid;
    record.state = 'running';
    record.startedAt = now;
    record.remoteDir = `~/.webssh/jobs/${id}`;
    await jobStore.save(record);
    return record;
  } catch (err) {
    record.state = 'failed';
    record.endedAt = Date.now();
    record.error = err instanceof Error ? err.message : String(err);
    await jobStore.save(record);
    return record;
  }
}

export interface MonitorOptions {
  onUpdate?: (job: JobRecord) => void;
  pollMs?: number;
  signal?: AbortSignal;
  /** Stop after this many milliseconds (0 = no limit). */
  timeoutMs?: number;
}

/**
 * Follow a job's remote log until it finishes. Connection loss flips the job
 * to `detached` without pretending it failed; call again to reattach.
 */
export async function monitorJob(
  job: JobRecord,
  session: JobSession,
  options: MonitorOptions = {}
): Promise<JobRecord> {
  const pollMs = options.pollMs ?? 1500;
  const started = Date.now();
  let current = { ...job };
  const update = async (patch: Partial<JobRecord>): Promise<void> => {
    current = { ...current, ...patch, updatedAt: Date.now() };
    current.attached = session.isAttached?.() ?? true;
    await jobStore.save(current);
    options.onUpdate?.(current);
  };

  for (;;) {
    if (options.signal?.aborted) {
      await update({ state: 'detached', attached: false });
      return current;
    }
    if (options.timeoutMs && Date.now() - started > options.timeoutMs) {
      await update({ state: 'detached', attached: false });
      return current;
    }

    let status;
    try {
      status = await pollDetachedJob(session, job.id);
    } catch (err) {
      // The SSH channel is gone; the remote process may still be running.
      await update({
        state: current.state === 'cancel_requested' ? 'cancel_requested' : 'detached',
        attached: false,
        error: err instanceof Error ? err.message : String(err)
      });
      return current;
    }

    const markers = parseJobMarkers(status.stdoutTail);
    const steps = current.steps.map((step): JobStepRecord => {
      if (markers.failed.has(step.id)) {
        return {
          ...step,
          status: 'failed',
          exitCode: markers.failed.get(step.id),
          endedAt: step.endedAt ?? Date.now()
        };
      }
      if (markers.completed.has(step.id)) {
        return {
          ...step,
          status: 'succeeded',
          exitCode: 0,
          endedAt: step.endedAt ?? Date.now()
        };
      }
      if (step.status === 'pending' && !markers.done) {
        return step;
      }
      return step;
    });

    if (!status.running) {
      const exitCode = status.exitCode;
      const ok = exitCode === 0 && markers.done && markers.failed.size === 0;
      await update({
        state: ok ? 'succeeded' : 'failed',
        exitCode: exitCode ?? undefined,
        endedAt: Date.now(),
        steps: steps.map((s) => (s.status === 'pending' ? { ...s, status: ok ? 'succeeded' : 'skipped' } : s)),
        error: ok
          ? undefined
          : `Remote job exited with code ${exitCode ?? 'unknown'}${
              markers.failed.size > 0 ? `; failed steps: ${[...markers.failed.keys()].join(', ')}` : ''
            }`
      });
      return current;
    }

    await update({
      state: current.state === 'cancel_requested' ? 'cancel_requested' : 'running',
      steps,
      attached: true
    });
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Request cancellation and wait for the remote process to actually exit.
 * Returns `cancelled` only on confirmed termination; `cancel_requested`
 * means the signal was sent but the process has not finished yet.
 */
export async function cancelAndConfirm(
  job: JobRecord,
  session: JobSession,
  timeoutMs = 10_000
): Promise<JobRecord> {
  const requested: JobRecord = { ...job, state: 'cancel_requested', updatedAt: Date.now() };
  await jobStore.save(requested);
  const { hadPid } = await requestCancelDetachedJob(session, job.id);
  if (!hadPid) {
    const confirmed: JobRecord = {
      ...requested,
      state: 'lost',
      error: 'No remote process id was recorded; cannot confirm cancellation.',
      endedAt: Date.now()
    };
    await jobStore.save(confirmed);
    return confirmed;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await pollDetachedJob(session, job.id);
      if (!status.running) {
        const code = status.exitCode;
        const confirmed: JobRecord = {
          ...requested,
          state: 'cancelled',
          exitCode: code ?? undefined,
          endedAt: Date.now(),
          error:
            code === null
              ? 'Cancellation confirmed, but no exit code was recorded.'
              : undefined
        };
        await jobStore.save(confirmed);
        return confirmed;
      }
    } catch {
      const confirmed: JobRecord = {
        ...requested,
        state: 'cancel_requested',
        error: 'Cancellation signal sent; connection lost before termination could be confirmed.'
      };
      await jobStore.save(confirmed);
      return confirmed;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const pending: JobRecord = {
    ...requested,
    state: 'cancel_requested',
    error: 'Cancellation signal sent but the process is still running; it will be re-checked on reattach.'
  };
  await jobStore.save(pending);
  return pending;
}

/** Run verification steps and record an explicit verification result. */
export async function verifyJob(
  job: JobRecord,
  recipe: Recipe,
  session: RecipeSession
): Promise<JobRecord> {
  const result = await executePlan(
    {
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      steps: recipe.verify,
      issues: [],
      canExecute: true,
      requiredPrivilege: 'user',
      startedAt: Date.now()
    },
    session,
    { asRoot: false }
  );
  const ok = result.ok && result.outcomes.every((o) => o.status === 'succeeded');
  const detail = result.outcomes
    .map((o) => `${o.title}: ${o.status} (exit ${o.exitCode}) ${o.stderrTail}`.trim())
    .join('\n')
    .slice(0, 4000);
  const updated: JobRecord = {
    ...job,
    verification: { ran: true, ok, detail },
    // Verification is evidence about an install, never its outcome: a passing
    // check must not turn a failed (or still-running) install into `succeeded`.
    state: ok ? job.state : 'verification_failed',
    updatedAt: Date.now()
  };
  await jobStore.save(updated);
  return updated;
}
