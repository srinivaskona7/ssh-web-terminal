import type { ServerCapabilities } from '../discovery/capabilities.js';
import type {
  FieldError,
  PreflightIssue,
  Recipe,
  RecipeField,
  RecipeFieldValueMap,
  RecipePlan,
  RecipeStep
} from './types.js';

/** Safe POSIX single-quote escaping. The only place a value becomes shell text. */
export function posixQuote(value: string): string {
  if (value.includes('\0')) {
    throw new Error('Refusing to quote a value containing NUL');
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildShellCommand(argv: string[]): string {
  if (argv.length === 0) throw new Error('Empty command');
  return argv.map(posixQuote).join(' ');
}

const PLACEHOLDER = /\{\{([a-zA-Z0-9_]+)\}\}/g;

export function substituteArgv(argv: string[], values: RecipeFieldValueMap): string[] {
  return argv.map((token) =>
    token.replace(PLACEHOLDER, (_, id: string) => {
      const value = values[id];
      if (value === undefined || value === null) {
        throw new Error(`Missing required variable "${id}"`);
      }
      if (Array.isArray(value)) {
        throw new Error(`Variable "${id}" is a list and cannot be used inside a command token`);
      }
      const text = String(value);
      if (/[\u0000-\u001f\u007f]/.test(text)) {
        throw new Error(`Variable "${id}" contains control characters`);
      }
      return text;
    })
  );
}

export function isFieldVisible(field: RecipeField, values: RecipeFieldValueMap): boolean {
  if (!field.visibleWhen) return true;
  const other = values[field.visibleWhen.field];
  return field.visibleWhen.equals.some((expected) => String(expected) === String(other));
}

export function visibleFields(recipe: Recipe, values: RecipeFieldValueMap): RecipeField[] {
  return recipe.fields.filter((f) => isFieldVisible(f, values));
}

export function validateFieldValue(field: RecipeField, raw: unknown): FieldError | null {
  if (raw === undefined || raw === null || raw === '') {
    if (field.required && field.type !== 'boolean') {
      return { field: field.id, message: `${field.label} is required` };
    }
    return null;
  }

  const fail = (message: string): FieldError => ({ field: field.id, message });

  switch (field.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return fail(`${field.label} must be a number`);
      if (field.min !== undefined && n < field.min) return fail(`${field.label} must be ≥ ${field.min}`);
      if (field.max !== undefined && n > field.max) return fail(`${field.label} must be ≤ ${field.max}`);
      return null;
    }
    case 'port': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return fail(`${field.label} must be an integer port between 1 and 65535`);
      }
      return null;
    }
    case 'boolean':
      return typeof raw === 'boolean' || raw === 'true' || raw === 'false'
        ? null
        : fail(`${field.label} must be true or false`);
    case 'enum': {
      const allowed = (field.options ?? []).map((o) => o.value);
      return allowed.includes(String(raw))
        ? null
        : fail(`${field.label} must be one of: ${allowed.join(', ')}`);
    }
    case 'hostname': {
      const text = String(raw);
      // RFC 1123 hostname label rules; IP literals are acceptable too.
      const hostname = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
      const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (!hostname.test(text) && !ipv4.test(text)) return fail(`${field.label} is not a valid hostname`);
      return null;
    }
    case 'path': {
      const text = String(raw);
      if (text.includes('\0')) return fail(`${field.label} contains an invalid character`);
      if (text.startsWith('-')) return fail(`${field.label} must not start with "-"`);
      return null;
    }
    case 'version': {
      const text = String(raw);
      return /^[vV]?\d+(\.\d+){0,3}([-+][\w.]+)?$/.test(text)
        ? null
        : fail(`${field.label} must be a version like "1.2.3"`);
    }
    case 'multiline':
      return String(raw).includes('\0') ? fail(`${field.label} contains an invalid character`) : null;
    case 'list':
      return Array.isArray(raw) || typeof raw === 'string'
        ? null
        : fail(`${field.label} must be a list`);
    case 'keyvalue':
      return typeof raw === 'string' || (typeof raw === 'object' && raw !== null)
        ? null
        : fail(`${field.label} must be key/value pairs`);
    case 'secret':
    case 'secret_ref':
    case 'text':
      return null;
    default:
      return null;
  }
}

export function validateValues(
  recipe: Recipe,
  values: RecipeFieldValueMap
): FieldError[] {
  const errors: FieldError[] = [];
  for (const field of visibleFields(recipe, values)) {
    const err = validateFieldValue(field, values[field.id]);
    if (err) errors.push(err);
  }
  return errors;
}

/** Apply declared defaults for fields the user has not supplied. */
export function withDefaults(
  recipe: Recipe,
  values: RecipeFieldValueMap = {}
): RecipeFieldValueMap {
  const out: RecipeFieldValueMap = { ...values };
  for (const field of recipe.fields) {
    if (out[field.id] === undefined && field.default !== undefined) {
      out[field.id] = field.default;
    }
  }
  return out;
}

function parseVersion(text: string | undefined): number[] | null {
  if (!text) return null;
  const cleaned = text.trim().replace(/^[vV]/, '');
  const match = cleaned.match(/^(\d+(?:\.\d+){0,3})/);
  if (!match) return null;
  return match[1]!.split('.').map((p) => Number.parseInt(p, 10));
}

export function compareVersions(a: string | undefined, b: string | undefined): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export type RecipeEvaluation =
  | 'available'
  | 'installed'
  | 'outdated'
  | 'unsupported'
  | 'insufficient_resources'
  | 'requires_privilege'
  | 'requires_configuration';

export function evaluateRecipe(recipe: Recipe, caps: ServerCapabilities): {
  state: RecipeEvaluation;
  reason?: string;
} {
  const support = recipe.support;
  if (support.distros && support.distros.length > 0) {
    const distro = caps.os.distro.toLowerCase();
    const matches = support.distros.some((d) => distro.includes(d.toLowerCase()));
    if (!matches) {
      return {
        state: 'unsupported',
        reason: `Supports ${support.distros.join(', ')}; this host is ${caps.os.distro || 'unknown'}.`
      };
    }
  }
  if (support.arch && support.arch.length > 0 && !support.arch.includes(caps.os.arch)) {
    return {
      state: 'unsupported',
      reason: `Supports ${support.arch.join(', ')}; this host is ${caps.os.arch || 'unknown'}.`
    };
  }
  if (recipe.requiresConfiguration) {
    return {
      state: 'requires_configuration',
      reason: 'This recipe needs a package repository or external configuration before it can run.'
    };
  }
  const tool = caps.tools[recipe.id];
  if (support.minRamMiB && caps.memory.totalMiB > 0 && caps.memory.totalMiB < support.minRamMiB) {
    return {
      state: 'insufficient_resources',
      reason: `Needs ${support.minRamMiB} MiB RAM; host reports ${caps.memory.totalMiB} MiB.`
    };
  }
  if (tool?.state === 'installed') {
    const cmp = compareVersions(tool.version, recipe.versionInstalled);
    if (cmp !== null && cmp < 0) {
      return { state: 'outdated', reason: `Installed ${tool.version}, recipe provides ${recipe.versionInstalled}.` };
    }
    return { state: 'installed', reason: tool.version ? `Version ${tool.version}` : 'Installed' };
  }
  if (recipe.privileges === 'sudo') {
    if (!caps.privilege.isRoot && !caps.privilege.sudoAvailable) {
      return { state: 'requires_privilege', reason: 'sudo is not available for this SSH user.' };
    }
    if (!caps.privilege.isRoot && !caps.privilege.sudoNopasswd) {
      return {
        state: 'requires_privilege',
        reason: 'sudo requires a password; this workspace never stores or forwards sudo passwords.'
      };
    }
  }
  return { state: 'available' };
}

export function stepsForManager(recipe: Recipe, manager: string | null): RecipeStep[] {
  if (manager && recipe.stepsByManager?.[manager]) return recipe.stepsByManager[manager]!;
  return recipe.steps ?? [];
}

export interface PlanOptions {
  /** Skip this recipe's ports from the conflict check (e.g. it owns them). */
  ignorePorts?: number[];
}

export function buildPlan(
  recipe: Recipe,
  values: RecipeFieldValueMap,
  caps: ServerCapabilities,
  options: PlanOptions = {}
): RecipePlan {
  const issues: PreflightIssue[] = [];
  const resolvedValues = withDefaults(recipe, values);
  const fieldErrors = validateValues(recipe, resolvedValues);
  for (const error of fieldErrors) {
    issues.push({ level: 'blocking', code: 'FIELD_INVALID', message: `${error.field}: ${error.message}` });
  }

  const evaluation = evaluateRecipe(recipe, caps);
  if (evaluation.state === 'unsupported' || evaluation.state === 'requires_privilege' || evaluation.state === 'requires_configuration') {
    issues.push({ level: 'blocking', code: `RECIPE_${evaluation.state.toUpperCase()}`, message: evaluation.reason ?? evaluation.state });
  } else if (evaluation.state === 'insufficient_resources') {
    issues.push({ level: 'blocking', code: 'INSUFFICIENT_RESOURCES', message: evaluation.reason ?? 'Insufficient resources' });
  } else if (evaluation.state === 'installed') {
    issues.push({ level: 'warning', code: 'ALREADY_INSTALLED', message: evaluation.reason ?? 'Already installed' });
  }

  if (recipe.support.minDiskMiB && caps.disks.length > 0) {
    const root = caps.disks.find((d) => d.mount === '/') ?? caps.disks[0]!;
    if (root.availableMiB < recipe.support.minDiskMiB) {
      issues.push({
        level: 'blocking',
        code: 'INSUFFICIENT_DISK',
        message: `Needs ${recipe.support.minDiskMiB} MiB free on ${root.mount}; ${root.availableMiB} MiB available.`
      });
    }
  }

  const steps = stepsForManager(recipe, caps.packages.manager).map((step) => {
    if (step.kind === 'exec') {
      try {
        return { ...step, resolvedArgv: substituteArgv(step.argv, resolvedValues) };
      } catch (err) {
        issues.push({
          level: 'blocking',
          code: 'VARIABLE_MISSING',
          message: err instanceof Error ? err.message : String(err)
        });
        return { ...step, resolvedArgv: step.argv.slice() };
      }
    }
    return { ...step };
  });

  for (const port of recipe.provides?.ports ?? []) {
    if (options.ignorePorts?.includes(port)) continue;
    const conflict = caps.listeners.find((l) => l.port === port);
    if (conflict) {
      issues.push({
        level: 'warning',
        code: 'PORT_IN_USE',
        message: `Port ${port} is already listening (${conflict.address}). The service may fail to start.`
      });
    }
  }

  for (const conflictId of recipe.conflicts ?? []) {
    if (caps.tools[conflictId]?.state === 'installed') {
      issues.push({
        level: 'warning',
        code: 'CONFLICT_INSTALLED',
        message: `${conflictId} is already installed and may conflict with ${recipe.name}.`
      });
    }
  }

  return {
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    steps,
    issues,
    canExecute: !issues.some((i) => i.level === 'blocking'),
    requiredPrivilege: recipe.privileges,
    startedAt: Date.now()
  };
}

export interface RecipeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RecipeSession {
  capabilities: ServerCapabilities;
  execStream(
    command: string,
    options?: {
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<RecipeExecResult>;
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
  onStepStart?: (step: RecipeStep & { resolvedArgv?: string[] }, index: number) => void;
  onOutput?: (stepId: string, stream: 'stdout' | 'stderr', chunk: string) => void;
  onStepEnd?: (outcome: StepOutcome) => void;
  signal?: AbortSignal;
}

function tail(text: string, limit = 4000): string {
  return text.length > limit ? text.slice(text.length - limit) : text;
}

export async function executePlan(
  plan: RecipePlan,
  session: RecipeSession,
  options: ExecutionOptions
): Promise<{ outcomes: StepOutcome[]; ok: boolean }> {
  if (!plan.canExecute) {
    throw new Error('Refusing to execute a plan with blocking preflight issues');
  }
  const outcomes: StepOutcome[] = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    options.onStepStart?.(step, i);
    const startedAt = Date.now();
    let command: string;
    if (step.kind === 'exec') {
      const argv = step.resolvedArgv ?? step.argv;
      const needsRoot = (step.asRoot ?? false) && options.asRoot;
      command = buildShellCommand(needsRoot ? ['sudo', '-n', '--', ...argv] : argv);
    } else {
      const bytes = new TextEncoder().encode(step.content);
      if (!step.asRoot && session.writeFile) {
        await session.writeFile(step.path, bytes);
        const outcome: StepOutcome = {
          stepId: step.id,
          title: step.title,
          status: 'succeeded',
          command: `writeFile ${step.path}`,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          stdoutTail: '',
          stderrTail: ''
        };
        outcomes.push(outcome);
        options.onStepEnd?.(outcome);
        continue;
      }
      const b64 = btoa(String.fromCharCode(...bytes));
      const quotedPath = posixQuote(step.path);
      command = step.asRoot
        ? `printf %s ${posixQuote(b64)} | base64 -d | sudo -n tee ${quotedPath} > /dev/null`
        : `printf %s ${posixQuote(b64)} | base64 -d > ${quotedPath}`;
    }

    let result: RecipeExecResult;
    try {
      result = await session.execStream(command, {
        timeoutMs: step.kind === 'exec' ? (step.timeoutMs ?? 15 * 60_000) : 60_000,
        signal: options.signal,
        onStdout: (chunk) => options.onOutput?.(step.id, 'stdout', chunk),
        onStderr: (chunk) => options.onOutput?.(step.id, 'stderr', chunk)
      });
    } catch (err) {
      const outcome: StepOutcome = {
        stepId: step.id,
        title: step.title,
        status: 'failed',
        command,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        stdoutTail: '',
        stderrTail: err instanceof Error ? err.message : String(err)
      };
      outcomes.push(outcome);
      options.onStepEnd?.(outcome);
      return { outcomes, ok: false };
    }

    const ok = result.exitCode === 0;
    const outcome: StepOutcome = {
      stepId: step.id,
      title: step.title,
      status: ok || (step.kind === 'exec' && step.allowFailure) ? 'succeeded' : 'failed',
      command,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr)
    };
    outcomes.push(outcome);
    options.onStepEnd?.(outcome);
    if (!ok && !(step.kind === 'exec' && step.allowFailure)) {
      return { outcomes, ok: false };
    }
  }
  return { outcomes, ok: true };
}

/** Strip sensitive values so a plan/log dump never contains a secret. */
export function redactValues(
  recipe: Recipe,
  values: RecipeFieldValueMap
): RecipeFieldValueMap {
  const out: RecipeFieldValueMap = {};
  for (const [key, value] of Object.entries(values)) {
    const field = recipe.fields.find((f) => f.id === key);
    out[key] = field?.sensitive ? '[redacted]' : value;
  }
  return out;
}
