import type { RecipePlan, Recipe } from '../recipes/types.js';
import { type RecipeSession } from '../recipes/engine.js';
import { type JobSession } from './remote-job-runner.js';
import { type JobRecord, type JobServerRef } from './types.js';
/**
 * Compile recipe steps into one detached POSIX script. Every step is announced
 * with a marker so progress survives a browser reconnect and can be replayed
 * from the remote log.
 */
export declare function buildRecipeScript(plan: RecipePlan, asRoot: boolean): string;
export interface ParsedMarkers {
    completed: Set<string>;
    failed: Map<string, number>;
    done: boolean;
}
export declare function parseJobMarkers(log: string): ParsedMarkers;
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
export declare function buildCommandScript(steps: CommandJobStep[]): string;
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
export declare function startCommandJob(input: StartCommandJobInput): Promise<JobRecord>;
export declare function startRecipeJob(input: StartRecipeJobInput): Promise<JobRecord>;
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
export declare function monitorJob(job: JobRecord, session: JobSession, options?: MonitorOptions): Promise<JobRecord>;
/**
 * Request cancellation and wait for the remote process to actually exit.
 * Returns `cancelled` only on confirmed termination; `cancel_requested`
 * means the signal was sent but the process has not finished yet.
 */
export declare function cancelAndConfirm(job: JobRecord, session: JobSession, timeoutMs?: number): Promise<JobRecord>;
/** Run verification steps and record an explicit verification result. */
export declare function verifyJob(job: JobRecord, recipe: Recipe, session: RecipeSession): Promise<JobRecord>;
//# sourceMappingURL=job-manager.d.ts.map