/**
 * Dockerfile lint.
 *
 * The parser reads a Dockerfile the way BuildKit does: parser directives only
 * at the top, escape-character line continuations, comment and blank lines
 * dropped inside continuations, heredoc bodies on RUN/COPY/ADD, and build
 * stages. The rules then look for the mistakes that most often reach
 * production images. Every issue carries the line its instruction starts on,
 * and a secret's value is never copied into an issue, only its name.
 */
import { makeResult, validateRemotePath } from '../../exec.js';
import type { DevOpsTool, Finding, FindingSeverity, ResultTable } from '../../types.js';
import { parseImageRef, tagProblem } from './image-ref.js';
import { catCommand, readRemoteText } from './remote-text.js';

export interface DockerInstruction {
  /** Upper-cased instruction name. */
  keyword: string;
  /** Everything after the keyword, continuation lines joined. */
  args: string;
  /** Leading `--name=value` flags, quotes removed. */
  flags: string[];
  /** `args` after the flags. */
  body: string;
  /** Heredoc bodies in order, without their terminator lines. */
  heredocs: string[];
  /** 1-based line the instruction starts on. */
  line: number;
  /** Build stage index; -1 for the ARGs before the first FROM. */
  stage: number;
}

export interface ParsedDockerfile {
  instructions: DockerInstruction[];
  escape: '\\' | '`';
}

export type DockerfileRule =
  | 'from-latest'
  | 'from-untagged'
  | 'from-arg'
  | 'no-user'
  | 'user-root'
  | 'apt-recommends'
  | 'apt-lists'
  | 'add-local'
  | 'curl-pipe-shell'
  | 'secret-literal'
  | 'sudo'
  | 'expose-ssh'
  | 'no-healthcheck'
  | 'copy-before-install'
  | 'unknown-instruction'
  | 'no-from';

export interface DockerfileIssue {
  rule: DockerfileRule;
  severity: FindingSeverity;
  line: number;
  message: string;
}

export interface DockerfileReport {
  instructions: DockerInstruction[];
  /** Number of FROM instructions. */
  stages: number;
  /** Sorted by line, then severity. */
  issues: DockerfileIssue[];
}

export const DOCKERFILE_MAX_BYTES = 256 * 1024;

const SEVERITY: Record<DockerfileRule, FindingSeverity> = {
  'from-latest': 'warning',
  'from-untagged': 'warning',
  'from-arg': 'info',
  'no-user': 'warning',
  'user-root': 'warning',
  'apt-recommends': 'info',
  'apt-lists': 'info',
  'add-local': 'info',
  'curl-pipe-shell': 'critical',
  'secret-literal': 'critical',
  sudo: 'warning',
  'expose-ssh': 'warning',
  'no-healthcheck': 'info',
  'copy-before-install': 'info',
  'unknown-instruction': 'warning',
  'no-from': 'warning'
};

const RULE_TITLES: Record<DockerfileRule, string> = {
  'from-latest': 'Base image uses :latest',
  'from-untagged': 'Base image has no tag',
  'from-arg': 'Base image set by a build argument',
  'no-user': 'Final stage sets no USER',
  'user-root': 'Final stage runs as root',
  'apt-recommends': 'apt install without --no-install-recommends',
  'apt-lists': 'apt package lists left in the image',
  'add-local': 'ADD used for local files',
  'curl-pipe-shell': 'Download piped into a shell',
  'secret-literal': 'Secret in ENV or ARG',
  sudo: 'sudo in a build step',
  'expose-ssh': 'SSH port exposed',
  'no-healthcheck': 'No HEALTHCHECK',
  'copy-before-install': 'Whole context copied before installing dependencies',
  'unknown-instruction': 'Unknown instruction',
  'no-from': 'No FROM instruction'
};

const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, warning: 1, info: 2, ok: 3 };

const INSTRUCTIONS = new Set([
  'FROM',
  'RUN',
  'CMD',
  'LABEL',
  'MAINTAINER',
  'EXPOSE',
  'ENV',
  'ADD',
  'COPY',
  'ENTRYPOINT',
  'VOLUME',
  'USER',
  'WORKDIR',
  'ARG',
  'ONBUILD',
  'STOPSIGNAL',
  'HEALTHCHECK',
  'SHELL'
]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const DIRECTIVE = /^#\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*?)\s*$/;
const KNOWN_DIRECTIVES = new Set(['syntax', 'escape', 'check']);
const HEREDOC_KEYWORDS = new Set(['RUN', 'COPY', 'ADD']);
const HEREDOC_WORD = /^\d*<<(-?)([^<]+)$/;

interface Word {
  /** Quotes and escapes removed. */
  text: string;
  /** As written. */
  raw: string;
  end: number;
}

/** Split on unquoted whitespace, the way BuildKit reads instruction arguments. */
function splitWords(input: string, escape: string): Word[] {
  const words: Word[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;
    const start = i;
    let text = '';
    let quote: string | null = null;
    while (i < input.length) {
      const c = input[i]!;
      if (quote !== null) {
        if (c === quote) quote = null;
        else if (c === escape && quote === '"' && i + 1 < input.length) text += input[++i];
        else text += c;
        i++;
        continue;
      }
      if (/\s/.test(c)) break;
      if (c === '"' || c === "'") quote = c;
      else if (c === escape && i + 1 < input.length) text += input[++i];
      else text += c;
      i++;
    }
    words.push({ text, raw: input.slice(start, i), end: i });
  }
  return words;
}

function unquote(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  return value;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

export function parseDockerfile(text: string): ParsedDockerfile {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

  // Parser directives count only before the first comment, blank line or instruction.
  let escape: '\\' | '`' = '\\';
  const seen = new Set<string>();
  let i = 0;
  for (; i < lines.length; i++) {
    const directive = DIRECTIVE.exec(lines[i]!);
    if (!directive) break;
    const key = directive[1]!.toLowerCase();
    if (!KNOWN_DIRECTIVES.has(key) || seen.has(key)) break;
    seen.add(key);
    if (key === 'escape' && (directive[2] === '\\' || directive[2] === '`')) escape = directive[2];
  }
  const continuation = escape === '`' ? /`[ \t]*$/ : /\\[ \t]*$/;

  const instructions: DockerInstruction[] = [];
  let stage = -1;
  while (i < lines.length) {
    if (isBlankOrComment(lines[i]!)) {
      i++;
      continue;
    }
    const line = i + 1;
    let logical = '';
    let current = lines[i]!;
    for (;;) {
      if (!continuation.test(current)) {
        logical += current;
        i++;
        break;
      }
      logical += current.replace(continuation, '');
      i++;
      while (i < lines.length && isBlankOrComment(lines[i]!)) i++;
      if (i >= lines.length) break;
      current = lines[i]!;
    }

    const split = /^\s*(\S+)\s*([\s\S]*)$/.exec(logical);
    if (!split) continue;
    const keyword = split[1]!.toUpperCase();
    const args = split[2]!.trim();
    const flags: string[] = [];
    let bodyStart = 0;
    for (const word of splitWords(args, escape)) {
      if (!/^--[A-Za-z]/.test(word.raw)) break;
      flags.push(word.text);
      bodyStart = word.end;
    }
    const body = args.slice(bodyStart).trim();

    const heredocs: string[] = [];
    if (HEREDOC_KEYWORDS.has(keyword)) {
      for (const word of splitWords(body, escape)) {
        const heredoc = HEREDOC_WORD.exec(word.raw);
        if (!heredoc) continue;
        const stripTabs = heredoc[1] === '-';
        const terminator = unquote(heredoc[2]!);
        const content: string[] = [];
        while (i < lines.length) {
          const bodyLine = stripTabs ? lines[i]!.replace(/^\t+/, '') : lines[i]!;
          i++;
          if (bodyLine === terminator) break;
          content.push(bodyLine);
        }
        heredocs.push(content.join('\n'));
      }
    }

    if (keyword === 'FROM') stage++;
    instructions.push({ keyword, args, flags, body, heredocs, line, stage });
  }
  return { instructions, escape };
}

/** `["a", "b"]` exec form; anything that is not a JSON string array is shell form. */
function execForm(body: string): string[] | null {
  if (!body.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed as string[];
  } catch {
    // Not JSON: Docker runs it through the shell instead.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shell scripts inside RUN
// ---------------------------------------------------------------------------

type ShellToken = { word: string } | { op: string } | { redirect: string };

/** Read the end of a `$(...)`, `${...}` or backquote span starting at `start`. */
function spanEnd(script: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let j = start; j < script.length; j++) {
    const c = script[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (open !== close && c === open) depth++;
    else if (c === close) {
      if (open === close || --depth === 0) return j;
    }
  }
  return script.length - 1;
}

/**
 * Split a POSIX shell script into words, operators and redirections. Quoted
 * text stays inside its word, so `echo "a | sh"` is one command, not a pipe.
 */
function lexShell(script: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = '';
  let inWord = false;
  const endWord = (): void => {
    if (inWord) tokens.push({ word });
    word = '';
    inWord = false;
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    const next = script[i + 1];
    if (c === '\\') {
      if (next === '\n') {
        i++;
      } else if (next !== undefined) {
        word += next;
        inWord = true;
        i++;
      }
      continue;
    }
    if (c === "'") {
      const close = script.indexOf("'", i + 1);
      const stop = close < 0 ? script.length : close;
      word += script.slice(i + 1, stop);
      inWord = true;
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < script.length && script[j] !== '"'; j++) {
        if (script[j] === '\\' && j + 1 < script.length && '"\\$`\n'.includes(script[j + 1]!)) {
          if (script[j + 1] !== '\n') word += script[j + 1];
          j++;
          continue;
        }
        word += script[j];
      }
      inWord = true;
      i = j;
      continue;
    }
    if (c === '$' && (next === '(' || next === '{')) {
      const end = spanEnd(script, i + 1, next, next === '(' ? ')' : '}');
      word += script.slice(i, end + 1);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '`') {
      const end = spanEnd(script, i, '`', '`');
      word += script.slice(i, end + 1);
      inWord = true;
      i = end === i ? script.length : end;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      continue;
    }
    if (c === '#' && !inWord) {
      const end = script.indexOf('\n', i);
      i = end < 0 ? script.length : end - 1;
      continue;
    }
    if (c === '\n' || c === ';' || c === '(' || c === ')') {
      endWord();
      tokens.push({ op: c });
      continue;
    }
    if (c === '&') {
      endWord();
      if (next === '&') {
        tokens.push({ op: '&&' });
        i++;
      } else if (next === '>') {
        let j = i + 1;
        while (script[j] === '>') j++;
        tokens.push({ redirect: script.slice(i, j) });
        i = j - 1;
      } else {
        tokens.push({ op: '&' });
      }
      continue;
    }
    if (c === '|') {
      endWord();
      if (next === '|') {
        tokens.push({ op: '||' });
        i++;
      } else {
        tokens.push({ op: '|' });
        if (next === '&') i++;
      }
      continue;
    }
    if (c === '<' || c === '>') {
      // Digits right before a redirection are its file descriptor: 2>&1.
      let fd = '';
      if (inWord && /^\d+$/.test(word)) {
        fd = word;
        word = '';
        inWord = false;
      } else {
        endWord();
      }
      let j = i;
      while (script[j] === '<' || script[j] === '>') j++;
      if (script[j] === '&') {
        j++;
        while (j < script.length && /[0-9-]/.test(script[j]!)) j++;
      } else if (script[j] === '|') {
        j++;
      }
      tokens.push({ redirect: fd + script.slice(i, j) });
      i = j - 1;
      continue;
    }
    word += c;
    inWord = true;
  }
  endWord();
  return tokens;
}

/** Commands as word lists, grouped into pipelines; redirections are dropped. */
function pipelines(tokens: ShellToken[]): string[][][] {
  const result: string[][][] = [];
  let pipeline: string[][] = [];
  let stage: string[] = [];
  let skipTarget = false;
  const endStage = (): void => {
    if (stage.length > 0) pipeline.push(stage);
    stage = [];
  };
  const endPipeline = (): void => {
    endStage();
    if (pipeline.length > 0) result.push(pipeline);
    pipeline = [];
  };
  for (const token of tokens) {
    if ('word' in token) {
      if (skipTarget) skipTarget = false;
      else stage.push(token.word);
    } else if ('redirect' in token) {
      skipTarget = !/[<>]&[0-9-]+$/.test(token.redirect);
    } else if (token.op === '|') {
      skipTarget = false;
      endStage();
    } else {
      skipTarget = false;
      endPipeline();
    }
  }
  endPipeline();
  return result;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh']);
const DOWNLOADERS = new Set(['curl', 'wget']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

function withoutAssignments(words: string[]): string[] {
  let k = 0;
  while (k < words.length && ASSIGNMENT.test(words[k]!)) k++;
  return words.slice(k);
}

/** Drop privilege and environment wrappers: `sudo -E env X=1 bash` is `bash`. */
function unwrap(stage: string[]): string[] {
  let words = withoutAssignments(stage);
  for (let guard = 0; guard < 6 && words.length > 0; guard++) {
    const name = basename(words[0]!);
    if (name === 'sudo' || name === 'doas') {
      let k = 1;
      while (k < words.length && words[k]!.startsWith('-')) {
        if (/^-[ugCDhpRrTU]$/.test(words[k]!)) k++;
        k++;
      }
      words = withoutAssignments(words.slice(k));
    } else if (name === 'env') {
      let k = 1;
      while (k < words.length && (words[k]!.startsWith('-') || ASSIGNMENT.test(words[k]!))) k++;
      words = words.slice(k);
    } else if (name === 'exec' || name === 'command' || name === 'nohup' || name === 'time') {
      words = words.slice(1);
    } else {
      break;
    }
  }
  return words;
}

function commandName(words: string[]): string {
  return basename(words[0] ?? '');
}

/** `apt-get [options] install …`; null when the command is not an apt install. */
function aptInstall(stage: string[]): { noRecommends: boolean } | null {
  const words = unwrap(stage);
  const name = commandName(words);
  if (name !== 'apt-get' && name !== 'apt') return null;
  let subcommand: string | null = null;
  for (let k = 1; k < words.length; k++) {
    const word = words[k]!;
    if (word.startsWith('-')) {
      if (word === '-o' || word === '-c' || word === '-t') k++;
      continue;
    }
    subcommand = word;
    break;
  }
  if (subcommand !== 'install') return null;
  const noRecommends = words.some(
    (word) => word === '--no-install-recommends' || /APT::Install-Recommends=(?:false|0|no)\b/i.test(word)
  );
  return { noRecommends };
}

function removesAptLists(stage: string[]): boolean {
  const words = unwrap(stage);
  return commandName(words) === 'rm' && words.slice(1).some((word) => word.startsWith('/var/lib/apt/lists'));
}

/** Language and system package installs that a source change should not re-run. */
function installsDependencies(stage: string[]): boolean {
  const words = unwrap(stage);
  const name = commandName(words);
  const positional = words.slice(1).filter((word) => !word.startsWith('-'));
  const first = positional[0] ?? '';
  const second = positional[1] ?? '';
  switch (name) {
    case 'npm':
      return ['ci', 'install', 'i', 'add', 'clean-install', 'install-clean'].includes(first);
    case 'yarn':
      return first === '' || first === 'install' || first === 'add';
    case 'pnpm':
    case 'bun':
      return first === 'install' || first === 'i' || first === 'add';
    case 'pip':
    case 'pip3':
    case 'poetry':
    case 'composer':
    case 'gem':
      return first === 'install';
    case 'pipenv':
      return first === 'install' || first === 'sync';
    case 'bundle':
    case 'bundler':
      return first === '' || first === 'install';
    case 'uv':
      return first === 'sync' || (first === 'pip' && second === 'install');
    case 'go':
      return (first === 'mod' && second === 'download') || first === 'get';
    case 'cargo':
      return first === 'fetch';
    case 'dotnet':
      return first === 'restore';
    case 'mvn':
    case 'mvnw':
      return positional.some((word) => word.startsWith('dependency:'));
    case 'apt-get':
    case 'apt':
      return aptInstall(words) !== null;
    case 'yum':
    case 'dnf':
    case 'microdnf':
      return first === 'install';
    case 'apk':
      return first === 'add';
    case 'zypper':
      return first === 'install' || first === 'in';
    default:
      break;
  }
  if (/^python[0-9.]*$/.test(name)) {
    const module = words.indexOf('-m');
    return module > 0 && /^pip[0-9.]*$/.test(words[module + 1] ?? '') && words.slice(module + 2).includes('install');
  }
  return false;
}

/** Every command a RUN executes: shell form, `sh -c` exec form, and heredoc scripts. */
function runPipelines(ins: DockerInstruction): string[][][] {
  const exec = execForm(ins.body);
  const scripts: string[] = [];
  if (exec) {
    const flag = exec.findIndex((word, k) => k > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
    const script = flag > 0 ? exec[flag + 1] : undefined;
    if (exec.length === 0) return [];
    if (!SHELLS.has(basename(exec[0]!)) || script === undefined) return [[exec]];
    scripts.push(script);
  } else {
    scripts.push(ins.body);
  }
  scripts.push(...ins.heredocs);
  return scripts.flatMap((script) => pipelines(lexShell(script)));
}

/** `--mount=type=cache,target=/var/lib/apt/lists` keeps the lists out of the layer. */
function mountsAptLists(flags: string[]): boolean {
  return flags.some((flag) => {
    if (!flag.startsWith('--mount=')) return false;
    const fields = new Map<string, string>();
    for (const part of flag.slice('--mount='.length).split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields.set(part.slice(0, eq).toLowerCase(), part.slice(eq + 1));
    }
    const type = fields.get('type') ?? 'bind';
    const target = fields.get('target') ?? fields.get('dst') ?? fields.get('destination') ?? '';
    return (type === 'cache' || type === 'tmpfs') && target.replace(/\/+$/, '') === '/var/lib/apt/lists';
  });
}

// ---------------------------------------------------------------------------
// ENV, ARG, USER and FROM values
// ---------------------------------------------------------------------------

interface NameValue {
  name: string;
  value: string | null;
}

/** `ENV a=1 b=2`, or the legacy `ENV NAME the rest of the line`. */
function envPairs(body: string, escape: string): NameValue[] {
  const words = splitWords(body, escape);
  const first = words[0];
  if (!first) return [];
  if (!first.text.includes('=')) {
    const rest = splitWords(body.slice(first.end), escape)
      .map((word) => word.text)
      .join(' ');
    return [{ name: first.text, value: rest }];
  }
  return words.filter((word) => word.text.includes('=')).map((word) => splitPair(word.text));
}

function argPairs(body: string, escape: string): NameValue[] {
  return splitWords(body, escape).map((word) => splitPair(word.text));
}

function splitPair(text: string): NameValue {
  const eq = text.indexOf('=');
  return eq < 0 ? { name: text, value: null } : { name: text.slice(0, eq), value: text.slice(eq + 1) };
}

const SECRET_PARTS = new Set([
  'KEY',
  'KEYS',
  'SECRET',
  'SECRETS',
  'PASSWORD',
  'PASSWORDS',
  'PASSWD',
  'PASS',
  'PASSPHRASE',
  'TOKEN',
  'TOKENS',
  'APIKEY',
  'ACCESSKEY',
  'SECRETKEY',
  'PRIVATEKEY',
  'AUTHTOKEN',
  'ACCESSTOKEN'
]);
/** Public key material and signing-key fingerprints are not secrets. */
const PUBLIC_PARTS = new Set(['PUBLIC', 'PUB', 'GPG', 'PGP']);
/** `DB_PASSWORD_FILE` points at a secret; it does not hold one. */
const DESCRIPTIVE_LAST_PARTS = new Set([
  'FILE',
  'PATH',
  'DIR',
  'URL',
  'URI',
  'ID',
  'NAME',
  'LENGTH',
  'SIZE',
  'TYPE',
  'FINGERPRINT',
  'HEADER',
  'ENDPOINT',
  'HOST',
  'PORT',
  'USER',
  'USERNAME',
  'VERSION'
]);

function isSecretName(name: string): boolean {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  if (!parts.some((part) => SECRET_PARTS.has(part))) return false;
  if (parts.some((part) => PUBLIC_PARTS.has(part))) return false;
  return !DESCRIPTIVE_LAST_PARTS.has(parts[parts.length - 1]!);
}

/** A non-empty value with no `$` reference is baked into the image as written. */
function isLiteral(value: string | null): boolean {
  return value !== null && value.trim() !== '' && !value.includes('$');
}

const VAR_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** Expand `$NAME`, `${NAME}`, `${NAME:-word}` and `${NAME:+word}` from known values. */
function expandVars(text: string, vars: ReadonlyMap<string, string | null>): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const value = text.replace(
    VAR_REF,
    (whole: string, braced: string | undefined, op: string | undefined, word: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? '';
      const current = vars.get(name);
      const set = current !== undefined && current !== null;
      if (op === ':-') return set && current !== '' ? current : (word ?? '');
      if (op === '-') return set ? current : (word ?? '');
      if (op === ':+') return set && current !== '' ? (word ?? '') : '';
      if (op === '+') return set ? (word ?? '') : '';
      if (set) return current;
      unresolved.push(name);
      return whole;
    }
  );
  return { value, unresolved };
}

function isRootUser(value: string): boolean {
  const user = value.split(':')[0] ?? '';
  return user === 'root' || /^0+$/.test(user);
}

function exposesSsh(body: string, escape: string): boolean {
  return splitWords(body, escape).some((word) => {
    const port = /^(\d+)(?:-(\d+))?(?:\/[A-Za-z]+)?$/.exec(word.text);
    if (!port) return false;
    const low = Number(port[1]);
    const high = port[2] ? Number(port[2]) : low;
    return low <= 22 && high >= 22;
  });
}

const REMOTE_SOURCE = /^(?:https?|git|ssh):\/\/|^git@|\.git(?:#.*)?$/i;
const TAR_ARCHIVE = /\.(?:tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|tzst)$/i;
const WHOLE_CONTEXT = new Set(['.', './', '*', './*']);

/** COPY/ADD sources: every argument but the destination; heredocs are not paths. */
function copySources(ins: DockerInstruction, escape: string): string[] {
  const exec = execForm(ins.body);
  if (exec) return exec.slice(0, -1);
  return splitWords(ins.body, escape)
    .filter((word) => !word.raw.startsWith('<<'))
    .map((word) => word.text)
    .slice(0, -1);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface StageInfo {
  from: DockerInstruction;
  alias: string | null;
  /** The earlier stage this one builds on, or null for an image. */
  base: number | null;
  users: Array<{ ins: DockerInstruction; value: string; root: boolean | null }>;
  healthchecks: DockerInstruction[];
}

function sortIssues(issues: DockerfileIssue[]): DockerfileIssue[] {
  return [...issues].sort(
    (a, b) =>
      a.line - b.line || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.rule.localeCompare(b.rule)
  );
}

export function lintDockerfile(text: string): DockerfileReport {
  const { instructions, escape } = parseDockerfile(text);
  const issues: DockerfileIssue[] = [];
  const report = (rule: DockerfileRule, line: number, message: string): void => {
    issues.push({ rule, severity: SEVERITY[rule], line, message });
  };

  for (const ins of instructions) {
    if (!INSTRUCTIONS.has(ins.keyword)) {
      report('unknown-instruction', ins.line, `Unknown instruction ${ins.keyword}; docker build stops here`);
    }
  }
  if (!instructions.some((ins) => ins.keyword === 'FROM')) {
    report('no-from', 1, 'No FROM instruction: this is not a Dockerfile, or its base image line is missing');
    return { instructions, stages: 0, issues: sortIssues(issues) };
  }

  const globalArgs = new Map<string, string | null>();
  const stages: StageInfo[] = [];
  let vars = new Map<string, string | null>();
  let pendingCopies: Array<{ ins: DockerInstruction; source: string }> = [];

  for (const ins of instructions) {
    const stage = stages[stages.length - 1];
    switch (ins.keyword) {
      case 'FROM': {
        vars = new Map();
        pendingCopies = [];
        const words = splitWords(ins.body, escape);
        const image = words[0]?.text ?? '';
        const alias = words[1]?.text.toLowerCase() === 'as' ? (words[2]?.text ?? null) : null;
        const expanded = expandVars(image, globalArgs);
        const name = expanded.value.toLowerCase();
        const base = stages.findIndex((earlier) => earlier.alias !== null && earlier.alias.toLowerCase() === name);
        stages.push({ from: ins, alias, base: base >= 0 ? base : null, users: [], healthchecks: [] });
        if (base >= 0 || name === 'scratch') break;
        if (expanded.unresolved.length > 0) {
          report(
            'from-arg',
            ins.line,
            `The base image ${image} comes from build argument ${expanded.unresolved.join(', ')} without a default, so its tag cannot be checked`
          );
          break;
        }
        const ref = parseImageRef(expanded.value);
        const problem = ref ? tagProblem(ref) : null;
        if (problem === 'latest') {
          report('from-latest', ins.line, `Base image ${expanded.value} uses the latest tag; pin a version or a digest so rebuilds are reproducible`);
        } else if (problem === 'untagged') {
          report('from-untagged', ins.line, `Base image ${expanded.value} has no tag, so it resolves to latest; pin a version or a digest`);
        }
        break;
      }
      case 'ARG':
      case 'ENV': {
        const pairs = ins.keyword === 'ENV' ? envPairs(ins.body, escape) : argPairs(ins.body, escape);
        for (const pair of pairs) {
          if (isSecretName(pair.name) && isLiteral(pair.value)) {
            report(
              'secret-literal',
              ins.line,
              `${ins.keyword} ${pair.name} is set to a literal value, which anyone with the image can read from its history; pass it as a build secret (RUN --mount=type=secret) or at run time`
            );
          }
          if (ins.stage === -1) {
            globalArgs.set(pair.name, pair.value);
          } else if (ins.keyword === 'ARG') {
            vars.set(pair.name, pair.value ?? globalArgs.get(pair.name) ?? null);
          } else {
            const expanded = expandVars(pair.value ?? '', vars);
            vars.set(pair.name, expanded.unresolved.length > 0 ? null : expanded.value);
          }
        }
        break;
      }
      case 'RUN': {
        const commands = runPipelines(ins);
        let sudo = false;
        let pipedShell: { tool: string; shell: string } | null = null;
        let aptInstalls = false;
        let recommends = false;
        let listsRemoved = false;
        let installs = false;
        for (const pipeline of commands) {
          const download = pipeline.findIndex((cmd) => DOWNLOADERS.has(commandName(unwrap(cmd))));
          if (download >= 0 && !pipedShell) {
            const shell = pipeline.slice(download + 1).find((cmd) => SHELLS.has(commandName(unwrap(cmd))));
            if (shell) pipedShell = { tool: commandName(unwrap(pipeline[download]!)), shell: commandName(unwrap(shell)) };
          }
          for (const cmd of pipeline) {
            if (commandName(withoutAssignments(cmd)) === 'sudo') sudo = true;
            const apt = aptInstall(cmd);
            if (apt) {
              aptInstalls = true;
              if (!apt.noRecommends) recommends = true;
            }
            if (removesAptLists(cmd)) listsRemoved = true;
            if (installsDependencies(cmd)) installs = true;
          }
        }
        if (pipedShell) {
          report(
            'curl-pipe-shell',
            ins.line,
            `RUN pipes a ${pipedShell.tool} download straight into ${pipedShell.shell}, so whatever the server returns runs unverified; download it, check a checksum or signature, then run it`
          );
        }
        if (sudo) {
          report('sudo', ins.line, 'RUN uses sudo; build steps already run as the current USER, so switch users with USER instead');
        }
        if (recommends) {
          report('apt-recommends', ins.line, 'apt install without --no-install-recommends pulls in optional packages and grows the image');
        }
        if (aptInstalls && !listsRemoved && !mountsAptLists(ins.flags)) {
          report(
            'apt-lists',
            ins.line,
            'apt install leaves /var/lib/apt/lists in the layer; remove it in the same RUN (rm -rf /var/lib/apt/lists/*) or use a cache mount'
          );
        }
        if (installs) {
          for (const copy of pendingCopies) {
            report(
              'copy-before-install',
              copy.ins.line,
              `COPY ${copy.source} copies the whole build context before the dependency install on line ${ins.line}, so any source change re-runs the install; copy the dependency manifests first`
            );
          }
          pendingCopies = [];
        }
        break;
      }
      case 'COPY': {
        if (ins.flags.some((flag) => flag.startsWith('--from='))) break;
        const whole = copySources(ins, escape).find((source) => WHOLE_CONTEXT.has(source));
        if (whole !== undefined) pendingCopies.push({ ins, source: whole });
        break;
      }
      case 'ADD': {
        const local = copySources(ins, escape).filter((source) => !REMOTE_SOURCE.test(source) && !TAR_ARCHIVE.test(source));
        if (local.length > 0) {
          report(
            'add-local',
            ins.line,
            `ADD copies local ${local.length === 1 ? 'path' : 'paths'} ${local.join(', ')}; COPY does the same without ADD's URL fetching and archive extraction`
          );
        }
        break;
      }
      case 'EXPOSE': {
        if (exposesSsh(ins.body, escape)) {
          report('expose-ssh', ins.line, 'EXPOSE 22 advertises SSH; containers should not run an SSH daemon (use docker exec or kubectl exec)');
        }
        break;
      }
      case 'USER': {
        const value = splitWords(ins.body, escape)[0]?.text ?? '';
        const expanded = expandVars(value, vars);
        stage?.users.push({ ins, value, root: expanded.unresolved.length > 0 ? null : isRootUser(expanded.value) });
        break;
      }
      case 'HEALTHCHECK': {
        stage?.healthchecks.push(ins);
        break;
      }
      default:
        break;
    }
  }

  // USER and HEALTHCHECK carry over from a stage the final stage builds on.
  const finalStage = stages[stages.length - 1]!;
  const lineage: StageInfo[] = [];
  for (let current: StageInfo | undefined = finalStage; current && lineage.length < stages.length; ) {
    lineage.push(current);
    current = current.base === null ? undefined : stages[current.base];
  }
  const user = lineage.map((info) => info.users[info.users.length - 1]).find((entry) => entry !== undefined);
  if (!user) {
    report(
      'no-user',
      finalStage.from.line,
      'The final stage sets no USER, so the container runs as whichever user the base image chose, which is usually root'
    );
  } else if (user.root === true) {
    report('user-root', user.ins.line, `The final stage switches to USER ${user.value}, so the container runs as root`);
  }
  const health = lineage.map((info) => info.healthchecks[info.healthchecks.length - 1]).find((entry) => entry !== undefined);
  if (!health) {
    report(
      'no-healthcheck',
      finalStage.from.line,
      'The final stage has no HEALTHCHECK, so Docker cannot tell a hung container from a healthy one (Kubernetes uses its own probes instead)'
    );
  } else if (/^none$/i.test(splitWords(health.body, escape)[0]?.text ?? '')) {
    report('no-healthcheck', health.line, 'HEALTHCHECK NONE switches health checking off, including any check the base image defined');
  }

  return { instructions, stages: stages.length, issues: sortIssues(issues) };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const dockerfileLintTool: DevOpsTool = {
  id: 'dockerfile-lint',
  group: 'delivery',
  title: 'Dockerfile lint',
  description:
    'Reads a Dockerfile from the server and checks it for unpinned base images, root users, secrets in ENV/ARG, piped install scripts and layer order that defeats the build cache.',
  requires: ['cat (only when SFTP is unavailable)'],
  inputs: [
    {
      key: 'path',
      label: 'Dockerfile path',
      placeholder: '/srv/app/Dockerfile',
      required: true,
      validate: validateRemotePath
    }
  ],
  preview: (input) => [catCommand(input.path ?? '')],
  async run(session, input) {
    const path = (input.path ?? '').trim();
    const invalid = validateRemotePath(path);
    if (invalid) return makeResult('error', invalid);

    const read = await readRemoteText(session, path, DOCKERFILE_MAX_BYTES);
    if (!read.ok) {
      const notes = read.denied ? [`The account ${session.user} has no read permission for ${path}.`] : [];
      return makeResult('error', `Could not read ${path}: ${read.error}`, { notes, evidence: read.evidence });
    }

    const lint = lintDockerfile(read.text);
    if (lint.stages === 0) {
      return makeResult('error', `${path} has no FROM instruction, so it is not a Dockerfile`, { evidence: read.evidence });
    }

    const findings: Finding[] = lint.issues.map((issue) => ({
      severity: issue.severity,
      title: RULE_TITLES[issue.rule],
      detail: issue.message,
      subject: `${path}:${issue.line}`
    }));
    if (findings.length === 0) findings.push({ severity: 'ok', title: 'No issues found', subject: path });
    const table: ResultTable = {
      id: 'issues',
      title: 'Issues by line',
      columns: [
        { key: 'line', label: 'Line', numeric: true },
        { key: 'severity', label: 'Severity' },
        { key: 'rule', label: 'Rule' },
        { key: 'message', label: 'Detail' }
      ],
      rows: lint.issues.map((issue) => ({ line: issue.line, severity: issue.severity, rule: issue.rule, message: issue.message }))
    };
    const count = (severity: FindingSeverity): number => lint.issues.filter((issue) => issue.severity === severity).length;
    const total = lint.issues.length;
    const stages = `${lint.stages} build stage${lint.stages === 1 ? '' : 's'}`;
    const summary =
      total === 0
        ? `No issues in ${path} (${stages})`
        : `${total} issue${total === 1 ? '' : 's'} in ${path} (${stages}): ${count('critical')} critical, ${count('warning')} warning, ${count('info')} info`;
    return makeResult('ok', summary, {
      findings,
      tables: [table],
      notes: ['Only the file itself is checked; base images are not pulled, so a USER or HEALTHCHECK set inside a base image is not seen.'],
      evidence: read.evidence
    });
  }
};
