/**
 * Typed, versioned installation recipe schema.
 *
 * A recipe is data, not prose: the UI renders forms from `fields`, the engine
 * validates every value, and execution is a list of explicit steps. Values are
 * substituted into argv elements and POSIX-quoted — never concatenated into a
 * shell string unquoted.
 */

export type RecipeFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'version'
  | 'path'
  | 'port'
  | 'hostname'
  | 'multiline'
  | 'secret'
  | 'secret_ref'
  | 'list'
  | 'keyvalue';

export interface RecipeField {
  id: string;
  label: string;
  description: string;
  type: RecipeFieldType;
  required: boolean;
  default?: string | number | boolean | string[];
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  /** JavaScript regex source; values must match exactly. */
  pattern?: string;
  placeholder?: string;
  /** Sensitive fields are never written to job history or logs. */
  sensitive: boolean;
  /** Whether the value may be persisted in the local form draft. */
  savable: boolean;
  advanced?: boolean;
  /** Field is only shown when another field equals one of these values. */
  visibleWhen?: { field: string; equals: Array<string | number | boolean> };
}

export type RecipeStep =
  | {
      id: string;
      title: string;
      kind: 'exec';
      /** Each element becomes one quoted argv token; `{{field}}` may appear. */
      argv: string[];
      asRoot?: boolean;
      allowFailure?: boolean;
      timeoutMs?: number;
    }
  | {
      id: string;
      title: string;
      kind: 'writeFile';
      path: string;
      content: string;
      mode?: string;
      asRoot?: boolean;
    };

export interface RecipeSupport {
  /** Distro IDs from /etc/os-release, e.g. ['ubuntu','debian']. Empty = any. */
  distros?: string[];
  /** uname -m values, e.g. ['x86_64','aarch64']. Empty = any. */
  arch?: string[];
  packageManagers?: string[];
  minRamMiB?: number;
  minDiskMiB?: number;
}

export interface Recipe {
  id: string;
  version: string;
  name: string;
  category:
    | 'development'
    | 'containers'
    | 'kubernetes'
    | 'automation'
    | 'build'
    | 'services'
    | 'data'
    | 'observability'
    | 'terminal';
  description: string;
  documentationUrl?: string;
  license: string;
  /** Version this recipe installs by default. */
  versionInstalled: string;
  support: RecipeSupport;
  privileges: 'user' | 'sudo';
  fields: RecipeField[];
  /** Steps for any package manager; distro-specific overrides win. */
  steps?: RecipeStep[];
  /** Keys are package-manager command names (`apt-get`, `dnf`, ...). */
  stepsByManager?: Record<string, RecipeStep[]>;
  verify: RecipeStep[];
  update?: RecipeStep[];
  remove?: RecipeStep[];
  provides?: {
    services?: string[];
    ports?: number[];
    files?: string[];
    users?: string[];
    persistentData?: string[];
  };
  rebootRequired?: boolean;
  rollback: 'supported' | 'limited' | 'none';
  conflicts?: string[];
  /** True when the recipe is a plan-only entry that needs external config. */
  requiresConfiguration?: boolean;
}

export interface RecipeFieldValueMap {
  [fieldId: string]: string | number | boolean | string[];
}

export interface FieldError {
  field: string;
  message: string;
}

export interface PreflightIssue {
  level: 'blocking' | 'warning';
  code: string;
  message: string;
}

export interface RecipePlan {
  recipeId: string;
  recipeVersion: string;
  steps: Array<RecipeStep & { resolvedArgv?: string[] }>;
  issues: PreflightIssue[];
  canExecute: boolean;
  requiredPrivilege: 'user' | 'sudo';
  startedAt: number;
}
