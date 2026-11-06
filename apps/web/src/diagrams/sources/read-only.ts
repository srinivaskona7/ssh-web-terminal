/**
 * Read-only guard for every command a scan sends.
 *
 * The scan builds its commands from constants plus a validated namespace and
 * names it just read from the host, so the guard is a second, independent
 * check on the final text: an allowlist of exact verb shapes. Anything it does
 * not recognise is refused, however it is spelled. The text is tokenised the
 * way a POSIX shell would split it (quotes removed), so quoting a verb
 * (`kubectl 'delete' ...`) does not hide it.
 *
 * Nothing here executes anything.
 */

const MAX_COMMAND_LENGTH = 32 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Characters a word may contain outside quotes. Everything else must be quoted. */
const BAREWORD = /^[A-Za-z0-9_@%+=:,./-]$/;

export class ReadOnlyViolation extends Error {
  readonly command: string;
  readonly reason: string;

  constructor(command: string, reason: string) {
    super(`Refusing to run a command outside the read-only allowlist (${reason}): ${JSON.stringify(command.slice(0, 160))}`);
    this.name = 'ReadOnlyViolation';
    this.command = command;
    this.reason = reason;
  }
}

type Stages = string[][];

/** Split into pipeline stages of words. Returns an error string when the text uses any other shell syntax. */
function tokenize(command: string): Stages | string {
  if (command.trim().length === 0) return 'the command is empty';
  if (command.length > MAX_COMMAND_LENGTH) return 'the command is too long';
  if (CONTROL.test(command)) return 'control characters and newlines are not allowed';

  const stages: Stages = [[]];
  let word: string | null = null;
  const endWord = (): void => {
    if (word !== null) stages[stages.length - 1]!.push(word);
    word = null;
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return 'unterminated single quote';
      word = (word ?? '') + command.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      const end = command.indexOf('"', i + 1);
      if (end < 0) return 'unterminated double quote';
      const inner = command.slice(i + 1, end);
      if (/[$`\\]/.test(inner)) return 'expansions are not allowed inside double quotes';
      word = (word ?? '') + inner;
      i = end + 1;
    } else if (ch === ' ') {
      endWord();
      i += 1;
    } else if (ch === '|') {
      if (command[i + 1] === '|') return '"||" is not allowed';
      endWord();
      if (stages[stages.length - 1]!.length === 0) return 'a pipeline stage is empty';
      stages.push([]);
      i += 1;
    } else if (BAREWORD.test(ch)) {
      word = (word ?? '') + ch;
      i += 1;
    } else {
      return `${JSON.stringify(ch)} is not allowed outside quotes (redirects, ";", "&", "$", backticks and globs are refused)`;
    }
  }
  endWord();
  if (stages[stages.length - 1]!.length === 0) return 'a pipeline stage is empty';
  return stages;
}

// ---------------------------------------------------------------------------
// Flag parsing shared by the per-program rules.
// ---------------------------------------------------------------------------

type Check = (value: string) => string | null;

interface FlagSpec {
  /** Flags without a value. */
  bare: readonly string[];
  /** Flags that take a value, as `--flag value` or `--flag=value` (short flags: next word). */
  valued: Record<string, Check>;
  /** Aliases that mean the same flag, e.g. `-n` for `--namespace`. */
  alias?: Record<string, string>;
}

interface Parsed {
  positional: string[];
  values: Map<string, string>;
}

function parseFlags(args: readonly string[], spec: FlagSpec): Parsed | string {
  const positional: string[] = [];
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const rawName = eq > 0 ? arg.slice(0, eq) : arg;
    const name = spec.alias?.[rawName] ?? rawName;
    if (spec.bare.includes(name)) {
      if (eq > 0) return `${rawName} does not take a value`;
      values.set(name, '');
      continue;
    }
    const check = spec.valued[name];
    if (!check) return `flag ${rawName} is not allowed`;
    let value: string | undefined;
    if (eq > 0) {
      value = arg.slice(eq + 1);
    } else {
      i += 1;
      value = args[i];
    }
    if (value === undefined) return `flag ${rawName} needs a value`;
    const problem = check(value);
    if (problem) return `${rawName}: ${problem}`;
    values.set(name, value);
  }
  return { positional, values };
}

const pattern =
  (re: RegExp, what: string): Check =>
  (value) =>
    re.test(value) ? null : `${what} has an unexpected shape`;

const NAMESPACE = pattern(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'a namespace');
const DURATION = pattern(/^\d{1,4}[smh]?$/, 'a duration');
const DIGITS = pattern(/^\d{1,6}$/, 'a number');
const SELECTOR = pattern(/^[A-Za-z0-9_./=!, ()-]{1,200}$/, 'a selector');
const OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// ---------------------------------------------------------------------------
// kubectl
// ---------------------------------------------------------------------------

/** Resources whose payload is secret or user-supplied text. Only their names may be listed. */
const DATA_RESOURCES = new Set(['secret', 'secrets', 'configmap', 'configmaps', 'cm']);
const DATA_PATH_SEGMENTS = new Set(['data', 'stringdata', 'binarydata']);

function checkKubectlOutput(output: string | undefined, resources: string): string | null {
  const holdsData = resources.split(',').some((r) => DATA_RESOURCES.has((r.split('.')[0] ?? '').toLowerCase()));
  if (output === undefined) return holdsData ? 'Secrets and ConfigMaps may be listed only by name' : null;
  if (output === 'name') return null;
  if (output === 'json') {
    return holdsData ? 'Secrets and ConfigMaps may be listed only with -o custom-columns or -o name' : null;
  }
  if (output.startsWith('custom-columns=')) {
    const spec = output.slice('custom-columns='.length);
    if (!/^[A-Za-z0-9_.,:-]+$/.test(spec)) return 'custom-columns has an unexpected shape';
    for (const column of spec.split(',')) {
      const path = column.slice(column.indexOf(':') + 1);
      if (path.split('.').some((segment) => DATA_PATH_SEGMENTS.has(segment.toLowerCase()))) {
        return 'custom-columns must not select Secret or ConfigMap data';
      }
    }
    return null;
  }
  return `-o ${output} is not allowed (use json, name or custom-columns)`;
}

function checkKubectl(args: string[]): string | null {
  const [verb, ...rest] = args;
  if (verb === 'config') {
    return rest.length === 1 && rest[0] === 'current-context' ? null : 'only "kubectl config current-context" is allowed';
  }
  if (verb !== 'get') return `"kubectl ${verb ?? ''}" is not a read-only listing`;
  const parsed = parseFlags(rest, {
    bare: ['-A', '--all-namespaces', '--no-headers', '--ignore-not-found'],
    valued: {
      '--namespace': NAMESPACE,
      '--output': pattern(/^[A-Za-z0-9_.,:=-]{1,400}$/, 'an output format'),
      '--request-timeout': DURATION,
      '--field-selector': SELECTOR,
      '--selector': SELECTOR,
      '--chunk-size': DIGITS
    },
    alias: { '-n': '--namespace', '-o': '--output', '-l': '--selector' }
  });
  if (typeof parsed === 'string') return parsed;
  const resources = parsed.positional;
  if (resources.length !== 1) return '"kubectl get" takes exactly one resource list';
  const resource = resources[0]!;
  if (!/^[a-z][a-z0-9.-]*(,[a-z][a-z0-9.-]*)*$/.test(resource)) return 'the resource list has an unexpected shape';
  return checkKubectlOutput(parsed.values.get('--output'), resource);
}

// ---------------------------------------------------------------------------
// docker
// ---------------------------------------------------------------------------

const ACTION = /\{\{\s*([^{}]*?)\s*\}\}/g;
const ACTION_PATH = /^(?:json\s+|if\s+)?(\.(?:[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)?)$/;
/** Whole objects that contain `Config.Env` (or are too broad to vet). */
const INSPECT_DENIED_PATHS = new Set(['.', '.Config', '.HostConfig', '.NetworkSettings', '.State', '.GraphDriver']);

/**
 * A `--format` template. For `inspect` it may name fields only: never `Config.Env`
 * (the container's environment) and never a whole object that would include it.
 */
function checkTemplate(template: string, mode: 'inspect' | 'list'): string | null {
  if (/\{\{|\}\}/.test(template.replace(ACTION, ''))) return 'the template is malformed';
  for (const match of template.matchAll(ACTION)) {
    const action = match[1]!;
    if (action === 'else' || action === 'end') continue;
    const path = ACTION_PATH.exec(action)?.[1];
    if (path === undefined) return `template action {{${action}}} is not allowed`;
    if (mode === 'list') continue;
    if (INSPECT_DENIED_PATHS.has(path) || /^\.Config\.(Env|Cmd|Entrypoint)\b/.test(path)) {
      return `docker inspect must not read ${path} (it can hold secrets); name the fields you need`;
    }
  }
  return null;
}

const listTemplate: Check = (value) => checkTemplate(value, 'list');
const inspectTemplate: Check = (value) => checkTemplate(value, 'inspect');

function checkDockerInspect(args: readonly string[]): string | null {
  const parsed = parseFlags(args, { bare: [], valued: { '--format': inspectTemplate }, alias: { '-f': '--format' } });
  if (typeof parsed === 'string') return parsed;
  if (!parsed.values.has('--format')) return 'docker inspect needs --format: raw inspect output includes Config.Env';
  if (parsed.positional.length === 0) return 'docker inspect needs at least one container, network or volume';
  const bad = parsed.positional.find((p) => !OBJECT_NAME.test(p));
  return bad === undefined ? null : `${JSON.stringify(bad)} is not a plain object name or id`;
}

function checkDockerList(args: readonly string[], bare: readonly string[]): string | null {
  const parsed = parseFlags(args, { bare, valued: { '--format': listTemplate }, alias: { '--quiet': '-q', '--all': '-a' } });
  if (typeof parsed === 'string') return parsed;
  return parsed.positional.length === 0 ? null : 'unexpected arguments';
}

function checkDocker(args: string[]): string | null {
  const [verb, sub, ...more] = args;
  switch (verb) {
    case 'ps':
      return checkDockerList(args.slice(1), ['-a', '-q', '--no-trunc']);
    case 'images':
      return checkDockerList(args.slice(1), ['-a', '-q', '--no-trunc']);
    case 'inspect':
      return checkDockerInspect(args.slice(1));
    case 'image':
      return sub === 'ls' ? checkDockerList(more, ['-a', '-q', '--no-trunc']) : `"docker image ${sub ?? ''}" is not allowed`;
    case 'network':
      if (sub === 'ls') return checkDockerList(more, ['-q', '--no-trunc']);
      if (sub === 'inspect') return checkDockerInspect(more);
      return `"docker network ${sub ?? ''}" is not allowed`;
    case 'volume':
      return sub === 'ls' ? checkDockerList(more, ['-q']) : `"docker volume ${sub ?? ''}" is not allowed`;
    default:
      return `"docker ${verb ?? ''}" is not on the read-only allowlist`;
  }
}

// ---------------------------------------------------------------------------
// systemctl, ss, ps, id and the pipeline filters
// ---------------------------------------------------------------------------

const UNIT_NAME = /^[A-Za-z0-9:_.@\\-]{1,256}\.(service|socket|target|timer|mount|path|slice|scope|device|swap|automount)$/;
const SYSTEMD_PROPERTIES = pattern(/^[A-Za-z]+(,[A-Za-z]+)*$/, 'a property list');
const UNIT_TYPE = pattern(/^(service|socket|target|timer|mount|path|slice|scope)$/, 'a unit type');

function checkSystemctl(args: string[]): string | null {
  const [verb, ...rest] = args;
  if (verb === 'list-units') {
    const parsed = parseFlags(rest, {
      bare: ['--all', '--no-legend', '--no-pager', '--plain', '--full'],
      valued: { '--type': UNIT_TYPE },
      alias: { '-a': '--all', '-l': '--full', '-t': '--type' }
    });
    if (typeof parsed === 'string') return parsed;
    return parsed.positional.length === 0 ? null : 'list-units takes no unit names here';
  }
  if (verb === 'show') {
    const parsed = parseFlags(rest, {
      bare: ['--no-pager', '--value'],
      valued: { '--property': SYSTEMD_PROPERTIES },
      alias: { '-p': '--property' }
    });
    if (typeof parsed === 'string') return parsed;
    const bad = parsed.positional.find((p) => !UNIT_NAME.test(p));
    return bad === undefined ? null : `${JSON.stringify(bad)} is not a unit name`;
  }
  if (verb === 'is-system-running') {
    const parsed = parseFlags(rest, { bare: ['--no-pager'], valued: {} });
    if (typeof parsed === 'string') return parsed;
    return parsed.positional.length === 0 ? null : 'is-system-running takes no arguments';
  }
  return `"systemctl ${verb ?? ''}" is not on the read-only allowlist`;
}

const SS_STATES = new Set(['established', 'listening', 'all', 'connected', 'synchronized']);

function checkSs(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === 'state') {
      const state = args[i + 1];
      if (state === undefined || !SS_STATES.has(state)) return 'ss "state" needs established, listening, connected, synchronized or all';
      i += 1;
      continue;
    }
    // -K closes sockets and -D writes a dump file; only listing letters are accepted.
    if (!/^-[tulpnaH46]+$/.test(arg)) return `ss argument ${JSON.stringify(arg)} is not allowed`;
  }
  return null;
}

const PS_COLUMNS = pattern(/^(?:(?:pid|ppid|comm|cgroup|uid|user)=?)(?:,(?:pid|ppid|comm|cgroup|uid|user)=?)*$/, 'a column list');

function checkPs(args: string[]): string | null {
  let columns = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!/^-[eAwo]+$/.test(arg)) return `ps argument ${JSON.stringify(arg)} is not allowed`;
    if (arg.includes('o')) {
      if (!arg.endsWith('o')) return 'ps -o must come last in its group';
      const value = args[i + 1];
      if (value === undefined) return 'ps -o needs a column list';
      const problem = PS_COLUMNS(value);
      if (problem) return `ps -o: ${problem}`;
      columns = true;
      i += 1;
    }
  }
  return columns ? null : 'ps needs -o with a column list';
}

function checkId(args: string[]): string | null {
  return args.length === 1 && args[0] === '-u' ? null : 'only "id -u" is allowed';
}

function checkHeadTail(args: string[]): string | null {
  return args.length === 2 && args[0] === '-n' && /^\d{1,6}$/.test(args[1]!) ? null : 'only "-n <count>" is allowed';
}

function checkWc(args: string[]): string | null {
  return args.length === 1 && args[0] === '-l' ? null : 'only "wc -l" is allowed';
}

const PROGRAMS: Record<string, (args: string[]) => string | null> = {
  kubectl: checkKubectl,
  docker: checkDocker,
  systemctl: checkSystemctl,
  ss: checkSs,
  ps: checkPs,
  id: checkId
};
/** Text filters that may follow a `|`. They read stdin and write nothing. */
const FILTERS: Record<string, (args: string[]) => string | null> = {
  head: checkHeadTail,
  tail: checkHeadTail,
  wc: checkWc
};

/** Why `command` is not allowed, or null when it is a read-only scan command. */
export function findReadOnlyViolation(command: string): string | null {
  const stages = tokenize(command);
  if (typeof stages === 'string') return stages;
  for (let index = 0; index < stages.length; index += 1) {
    const [program, ...args] = stages[index]!;
    if (program === undefined) return 'a pipeline stage is empty';
    const rule = PROGRAMS[program] ?? (index > 0 ? FILTERS[program] : undefined);
    if (!rule) return `"${program}" is not on the read-only allowlist`;
    const problem = rule(args);
    if (problem) return problem;
  }
  return null;
}

/** Throws `ReadOnlyViolation` unless `command` is on the allowlist. */
export function assertReadOnlyCommand(command: string): void {
  const reason = findReadOnlyViolation(command);
  if (reason !== null) throw new ReadOnlyViolation(command, reason);
}
