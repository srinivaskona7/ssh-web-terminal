/**
 * Runs scan commands: guard first, then the session, with a shared concurrency
 * cap, an output cap and a record of every command that was actually sent.
 *
 * A non-zero exit or a transport failure is an outcome the caller reports; only
 * an abort propagates, so a cancelled scan stops instead of reporting errors.
 */
import { isCommandMissing, isPermissionDenied, PROBE_TIMEOUT_MS } from '../../devops/exec.js';
import type { WorkspaceRemoteSession } from '../../session/adapters.js';
import { assertReadOnlyCommand, ReadOnlyViolation } from './read-only.js';
import { firstLine } from './common.js';

export type RunOutcome =
  | { kind: 'ok'; stdout: string; stderr: string }
  /** The binary is not installed. */
  | { kind: 'missing'; message: string }
  | { kind: 'denied'; message: string }
  | { kind: 'failed'; message: string; exitCode: number | null }
  | { kind: 'oversized'; message: string }
  /** The guard refused the command; it was never sent. */
  | { kind: 'blocked'; message: string };

export interface Runner {
  run(command: string): Promise<RunOutcome>;
  /** Commands sent so far, in order. */
  readonly commands: string[];
}

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(max: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };
  return async (task) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

export interface RunnerOptions {
  signal?: AbortSignal;
  /** Largest stdout accepted, in characters. */
  limit: number;
  limiter: Limiter;
  timeoutMs?: number;
}

export function abortError(): Error {
  const error = new Error('Scan cancelled');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createRunner(session: WorkspaceRemoteSession, options: RunnerOptions): Runner {
  const commands: string[] = [];
  const { signal, limit, limiter, timeoutMs = PROBE_TIMEOUT_MS } = options;

  const run = (command: string): Promise<RunOutcome> =>
    limiter(async () => {
      if (signal?.aborted) throw abortError();
      try {
        assertReadOnlyCommand(command);
      } catch (err) {
        if (err instanceof ReadOnlyViolation) return { kind: 'blocked', message: err.message };
        throw err;
      }
      commands.push(command);
      let result: Awaited<ReturnType<WorkspaceRemoteSession['exec']>>;
      try {
        result = await session.exec(command, { timeoutMs, ...(signal ? { signal } : {}) });
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) throw abortError();
        return { kind: 'failed', message: errorText(err), exitCode: null };
      }
      if (signal?.aborted) throw abortError();
      const detail = firstLine(result.stderr) || firstLine(result.stdout);
      if (result.exitCode !== 0) {
        if (isCommandMissing(result.exitCode, result.stderr)) return { kind: 'missing', message: detail || 'command not found' };
        if (isPermissionDenied(result.stderr)) return { kind: 'denied', message: detail };
        return { kind: 'failed', message: detail || `exited with ${result.exitCode}`, exitCode: result.exitCode };
      }
      if (result.stdout.length > limit) {
        return { kind: 'oversized', message: `output is larger than ${Math.round(limit / 1024 / 1024)} MiB; refusing to draw a partial copy` };
      }
      return { kind: 'ok', stdout: result.stdout, stderr: result.stderr };
    });

  return { run, commands };
}
