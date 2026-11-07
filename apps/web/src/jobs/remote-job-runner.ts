import { posixQuote } from '../recipes/engine.js';
import { jobDirectory } from './types.js';

/**
 * Detached remote execution.
 *
 * Long operations run under `setsid` on the server with their output in a job
 * directory. Closing the browser only drops the observation channel; the job
 * keeps running, and a later session reattaches by reading the same files.
 */

export interface JobSession {
  execCommand(
    command: string,
    timeoutMs?: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Write a file over SFTP without passing contents in argv. Preferred over base64-in-exec. */
  writeFile?: (path: string, content: Uint8Array) => Promise<void>;
  chmod?: (path: string, mode: string) => Promise<void>;
  /** False when sudo cannot run non-interactively; recipes then plan accordingly. */
  executeAsRoot?: boolean;
  /** Whether the browser is currently attached to the SSH session. */
  isAttached?: () => boolean;
}

export interface DetachedStatus {
  running: boolean;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
}

/**
 * Quote the job directory so the shell expands `$HOME`. Quoting the whole
 * path would create a literal `$HOME` directory instead.
 */
function shellDir(id: string): string {
  // jobDirectory already rejects anything outside [A-Za-z0-9-], so the
  // remainder needs no further quoting.
  return `"$HOME"/${jobDirectory(id).replace(/^\$HOME\//, '')}`;
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

export function buildStartCommand(id: string, script: string): string {
  const quotedDir = shellDir(id);
  const b64 = posixQuote(base64OfUtf8(script));
  return [
    `mkdir -p ${quotedDir} && chmod 700 ${quotedDir}`,
    `printf %s ${b64} | base64 -d > ${quotedDir}/run.sh`,
    `chmod 700 ${quotedDir}/run.sh`,
    `rm -f ${quotedDir}/exit.code ${quotedDir}/stdout.log ${quotedDir}/stderr.log`
  ].join(' && ');
}

/**
 * Launch the prepared script detached. `;` before `setsid` makes `&` apply to
 * the setsid process alone, so `$!` is the PID of the new session leader —
 * which is also its process-group id, so `kill -TERM -$pid` reaches children.
 */
export function buildLaunchCommand(id: string): string {
  const quotedDir = shellDir(id);
  return (
    `cd ${quotedDir}; ` +
    `setsid sh -c 'sh run.sh > stdout.log 2> stderr.log; echo $? > exit.code' ` +
    `> /dev/null 2>&1 & echo $! > remote.pid; cat remote.pid`
  );
}

export async function startDetachedJob(
  session: JobSession,
  id: string,
  script: string
): Promise<{ pid: number }> {
  // Prefer SFTP write so secrets never appear in `ps`/argv. Fall back to
  // base64-in-exec only when the session has no writeFile (e.g. relay exec-only).
  if (session.writeFile) {
    const quotedDir = shellDir(id);
    const mkdir = await session.execCommand(`mkdir -p ${quotedDir} && chmod 700 ${quotedDir} && rm -f ${quotedDir}/exit.code ${quotedDir}/stdout.log ${quotedDir}/stderr.log`, 30_000);
    if (mkdir.exitCode !== 0) {
      throw new Error(
        `Failed to prepare remote job: ${(mkdir.stderr || mkdir.stdout).trim() || `exit ${mkdir.exitCode}`}`
      );
    }
    const remoteRunSh = `~/.webssh/jobs/${id}/run.sh`;
    await session.writeFile(remoteRunSh, new TextEncoder().encode(script));
    if (session.chmod) await session.chmod(remoteRunSh, '700');
  } else {
    const setup = await session.execCommand(buildStartCommand(id, script), 30_000);
    if (setup.exitCode !== 0) {
      throw new Error(
        `Failed to prepare remote job: ${(setup.stderr || setup.stdout).trim() || `exit ${setup.exitCode}`}`
      );
    }
  }
  const launch = await session.execCommand(buildLaunchCommand(id), 30_000);
  if (launch.exitCode !== 0) {
    throw new Error(
      `Failed to start remote job: ${(launch.stderr || launch.stdout).trim() || `exit ${launch.exitCode}`}`
    );
  }
  const pid = Number.parseInt(launch.stdout.trim().split(/\s+/).pop() ?? '', 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error('Failed to start remote job: the server did not report a process id');
  }
  return { pid };
}

export function buildPollCommand(id: string): string {
  const quotedDir = shellDir(id);
  return [
    `cd ${quotedDir} 2>/dev/null || { echo "@@MISSING"; exit 0; }`,
    `if [ -f exit.code ]; then printf '@@EXIT:%s\\n' "$(cat exit.code)"; else echo "@@RUNNING"; fi`,
    'echo "@@OUT"',
    'tail -c 65536 stdout.log 2>/dev/null || true',
    'echo "@@ERR"',
    'tail -c 65536 stderr.log 2>/dev/null || true'
  ].join('; ');
}

export function parsePollOutput(stdout: string): DetachedStatus {
  if (stdout.includes('@@MISSING')) {
    return { running: false, exitCode: null, stdoutTail: '', stderrTail: '' };
  }
  const exitMatch = stdout.match(/@@EXIT:(-?\d+)/);
  const outIdx = stdout.indexOf('@@OUT');
  const errIdx = stdout.indexOf('@@ERR');
  const stdoutTail = outIdx === -1 ? '' : stdout.slice(outIdx + '@@OUT'.length, errIdx === -1 ? undefined : errIdx);
  const stderrTail = errIdx === -1 ? '' : stdout.slice(errIdx + '@@ERR'.length);
  return {
    running: exitMatch === null,
    exitCode: exitMatch ? Number.parseInt(exitMatch[1]!, 10) : null,
    stdoutTail: stdoutTail.replace(/^\r?\n/, ''),
    stderrTail: stderrTail.replace(/^\r?\n/, '')
  };
}

export async function pollDetachedJob(
  session: JobSession,
  id: string
): Promise<DetachedStatus> {
  const result = await session.execCommand(buildPollCommand(id), 20_000);
  if (result.exitCode !== 0 && !result.stdout) {
    throw new Error(`Failed to poll remote job: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return parsePollOutput(result.stdout);
}

export function buildCancelCommand(id: string): string {
  const quotedDir = shellDir(id);
  return [
    `pid=$(cat ${quotedDir}/remote.pid 2>/dev/null || cat ${quotedDir}/pid 2>/dev/null || true)`,
    'if [ -z "$pid" ]; then echo "@@NOPID"; exit 0; fi',
    'kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
    'echo "@@SIGNALLED"'
  ].join('; ');
}

/**
 * Ask the remote process group to stop. Cancellation is only *confirmed* when
 * a later poll reports an exit code — the caller must not mark the job
 * cancelled before then.
 */
export async function requestCancelDetachedJob(
  session: JobSession,
  id: string
): Promise<{ signalled: boolean; hadPid: boolean }> {
  const result = await session.execCommand(buildCancelCommand(id), 15_000);
  return {
    signalled: result.stdout.includes('@@SIGNALLED'),
    hadPid: !result.stdout.includes('@@NOPID')
  };
}

export function buildTailCommand(id: string, stream: 'stdout' | 'stderr'): string {
  const file = stream === 'stdout' ? 'stdout.log' : 'stderr.log';
  return `tail -c 131072 ${`"$HOME"/${posixQuote(`${jobDirectory(id).replace(/^\$HOME\//, '')}/${file}`)}`} 2>/dev/null || true`;
}
