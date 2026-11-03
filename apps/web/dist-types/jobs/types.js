/**
 * Durable job model for installations, builds, deployments and automations.
 *
 * State distinguishes the things operators actually care about: the browser
 * losing its connection is NOT the same as the remote operation failing, and a
 * cancellation request is NOT the same as a confirmed cancellation.
 */
export function isTerminalJobState(state) {
    return (state === 'succeeded' ||
        state === 'failed' ||
        state === 'cancelled' ||
        state === 'verification_failed' ||
        state === 'lost');
}
export function isActiveJobState(state) {
    return (state === 'queued' ||
        state === 'running' ||
        state === 'detached' ||
        state === 'cancel_requested');
}
const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,63}$/;
export function isValidJobId(id) {
    return JOB_ID_PATTERN.test(id);
}
export function createJobId(now = Date.now(), random = Math.random) {
    const time = now.toString(36);
    const suffix = Math.floor(random() * 0xffffff)
        .toString(36)
        .padStart(5, '0');
    return `job-${time}-${suffix}`;
}
/** POSIX-safe job directory; the id is validated, never interpolated raw. */
export function jobDirectory(id) {
    if (!isValidJobId(id))
        throw new Error(`Invalid job id "${id}"`);
    return `$HOME/.webssh/jobs/${id}`;
}
//# sourceMappingURL=types.js.map