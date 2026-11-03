/**
 * Detached remote execution.
 *
 * Long operations run under `setsid` on the server with their output in a job
 * directory. Closing the browser only drops the observation channel; the job
 * keeps running, and a later session reattaches by reading the same files.
 */
export interface JobSession {
    execCommand(command: string, timeoutMs?: number): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
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
export declare function buildStartCommand(id: string, script: string): string;
/**
 * Launch the prepared script detached. `;` before `setsid` makes `&` apply to
 * the setsid process alone, so `$!` is the PID of the new session leader —
 * which is also its process-group id, so `kill -TERM -$pid` reaches children.
 */
export declare function buildLaunchCommand(id: string): string;
export declare function startDetachedJob(session: JobSession, id: string, script: string): Promise<{
    pid: number;
}>;
export declare function buildPollCommand(id: string): string;
export declare function parsePollOutput(stdout: string): DetachedStatus;
export declare function pollDetachedJob(session: JobSession, id: string): Promise<DetachedStatus>;
export declare function buildCancelCommand(id: string): string;
/**
 * Ask the remote process group to stop. Cancellation is only *confirmed* when
 * a later poll reports an exit code — the caller must not mark the job
 * cancelled before then.
 */
export declare function requestCancelDetachedJob(session: JobSession, id: string): Promise<{
    signalled: boolean;
    hadPid: boolean;
}>;
export declare function buildTailCommand(id: string, stream: 'stdout' | 'stderr'): string;
//# sourceMappingURL=remote-job-runner.d.ts.map