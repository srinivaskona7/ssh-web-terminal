/**
 * Durable job model for installations, builds, deployments and automations.
 *
 * State distinguishes the things operators actually care about: the browser
 * losing its connection is NOT the same as the remote operation failing, and a
 * cancellation request is NOT the same as a confirmed cancellation.
 */

export type JobKind = 'install' | 'build' | 'deploy' | 'automation' | 'probe' | 'verify';

export type JobState =
  | 'queued'
  | 'running'
  | 'detached'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'verification_failed'
  | 'lost';

export interface JobStepRecord {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  exitCode?: number;
  startedAt?: number;
  endedAt?: number;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface JobServerRef {
  host: string;
  port: number;
  user: string;
  transport: 'cloudflare-relay' | 'go-gateway';
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  title: string;
  server: JobServerRef;
  recipeId?: string;
  recipeVersion?: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
  remoteDir?: string;
  pid?: number;
  exitCode?: number;
  steps: JobStepRecord[];
  /** Variables with sensitive values replaced by "[redacted]". */
  variables: Record<string, string | number | boolean | string[]>;
  /** Explicit note about whether post-install verification passed. */
  verification?: { ran: boolean; ok: boolean; detail?: string };
  error?: string;
  /** The browser is currently attached to this job. */
  attached: boolean;
}

export function isTerminalJobState(state: JobState): boolean {
  return (
    state === 'succeeded' ||
    state === 'failed' ||
    state === 'cancelled' ||
    state === 'verification_failed' ||
    state === 'lost'
  );
}

export function isActiveJobState(state: JobState): boolean {
  return (
    state === 'queued' ||
    state === 'running' ||
    state === 'detached' ||
    state === 'cancel_requested'
  );
}

const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,63}$/;

export function isValidJobId(id: string): boolean {
  return JOB_ID_PATTERN.test(id);
}

export function createJobId(now = Date.now(), random = Math.random): string {
  const time = now.toString(36);
  const suffix = Math.floor(random() * 0xffffff)
    .toString(36)
    .padStart(5, '0');
  return `job-${time}-${suffix}`;
}

/** POSIX-safe job directory; the id is validated, never interpolated raw. */
export function jobDirectory(id: string): string {
  if (!isValidJobId(id)) throw new Error(`Invalid job id "${id}"`);
  return `$HOME/.webssh/jobs/${id}`;
}
