import type { ServerCapabilities } from '../discovery/capabilities.js';
import type { FieldError, Recipe, RecipeField, RecipeFieldValueMap, RecipePlan, RecipeStep } from './types.js';
/** Safe POSIX single-quote escaping. The only place a value becomes shell text. */
export declare function posixQuote(value: string): string;
export declare function buildShellCommand(argv: string[]): string;
export declare function substituteArgv(argv: string[], values: RecipeFieldValueMap): string[];
export declare function isFieldVisible(field: RecipeField, values: RecipeFieldValueMap): boolean;
export declare function visibleFields(recipe: Recipe, values: RecipeFieldValueMap): RecipeField[];
export declare function validateFieldValue(field: RecipeField, raw: unknown): FieldError | null;
export declare function validateValues(recipe: Recipe, values: RecipeFieldValueMap): FieldError[];
/** Apply declared defaults for fields the user has not supplied. */
export declare function withDefaults(recipe: Recipe, values?: RecipeFieldValueMap): RecipeFieldValueMap;
export declare function compareVersions(a: string | undefined, b: string | undefined): number | null;
export type RecipeEvaluation = 'available' | 'installed' | 'outdated' | 'unsupported' | 'insufficient_resources' | 'requires_privilege' | 'requires_configuration';
export declare function evaluateRecipe(recipe: Recipe, caps: ServerCapabilities): {
    state: RecipeEvaluation;
    reason?: string;
};
export declare function stepsForManager(recipe: Recipe, manager: string | null): RecipeStep[];
export interface PlanOptions {
    /** Skip this recipe's ports from the conflict check (e.g. it owns them). */
    ignorePorts?: number[];
}
export declare function buildPlan(recipe: Recipe, values: RecipeFieldValueMap, caps: ServerCapabilities, options?: PlanOptions): RecipePlan;
export interface RecipeExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
export interface RecipeSession {
    capabilities: ServerCapabilities;
    execStream(command: string, options?: {
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<RecipeExecResult>;
    /** Optional SFTP write; falls back to a base64 tee pipeline when absent. */
    writeFile?(path: string, data: Uint8Array): Promise<void>;
}
export interface StepOutcome {
    stepId: string;
    title: string;
    status: 'succeeded' | 'failed' | 'skipped';
    command: string;
    exitCode: number;
    durationMs: number;
    stdoutTail: string;
    stderrTail: string;
}
export interface ExecutionOptions {
    asRoot: boolean;
    onStepStart?: (step: RecipeStep & {
        resolvedArgv?: string[];
    }, index: number) => void;
    onOutput?: (stepId: string, stream: 'stdout' | 'stderr', chunk: string) => void;
    onStepEnd?: (outcome: StepOutcome) => void;
    signal?: AbortSignal;
}
export declare function executePlan(plan: RecipePlan, session: RecipeSession, options: ExecutionOptions): Promise<{
    outcomes: StepOutcome[];
    ok: boolean;
}>;
/** Strip sensitive values so a plan/log dump never contains a secret. */
export declare function redactValues(recipe: Recipe, values: RecipeFieldValueMap): RecipeFieldValueMap;
//# sourceMappingURL=engine.d.ts.map