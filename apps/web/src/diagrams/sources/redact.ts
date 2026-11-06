/**
 * Redaction applied to everything a source keeps: `node.evidence.raw`,
 * `node.fields` and `node.tags`.
 *
 * Scans never fetch Secret or ConfigMap data and never ask Docker for
 * `Config.Env`, so the strongest protection is not asking. This module is the
 * second line: anything that reaches a builder (a scan, or a file the user
 * pasted) is stripped before it is stored, because a pasted `kubectl get -o json`
 * can contain whatever the user's cluster does.
 *
 * Names survive (env var names, `valueFrom` references, Secret keys); values do
 * not. The input is never mutated.
 */
import type { FieldValue } from '../model.js';

export const REDACTED = '[redacted]';

/** Keys whose string values are credentials. */
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|credential|private[-_]?key|api[-_]?key/i;
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';
const DATA_KEYS = new Set(['data', 'stringData', 'binaryData']);
/** A string here names a Secret; it is a reference, not secret material. */
const NAME_KEYS = new Set(['secretName']);
/**
 * Objects under a sensitive-looking key that hold only names of Secrets or
 * ConfigMaps (`secretKeyRef`, `imagePullSecrets`, a volume's `secret`), so the
 * references stay visible in the inspector.
 */
const REFERENCE_CONTAINERS = new Set(['secretKeyRef', 'secretRef', 'secret', 'configMapKeyRef', 'configMapRef', 'imagePullSecrets']);
const ENV_KEYS = new Set(['env', 'environment']);
const MAX_DEPTH = 64;

const CHEAP_HINT = /pass|secret|token|api.?key|credential|private key|:\/\//i;
const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi;
const SECRET_FLAG = /(--?[\w-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|credential)[\w-]*)(=|\s+)(?!\[redacted\])(\S+)/gi;
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:PASS(?:WORD|WD)?|SECRET|TOKEN|API_?KEY|CREDENTIAL)[A-Z0-9_]*)=(?!\[redacted\])(\S+)/g;

/** Credentials embedded in free text: PEM blocks, URL passwords, `--password x`, `TOKEN=x`. */
function scrubText(text: string): string {
  if (text.length === 0 || !CHEAP_HINT.test(text)) return text;
  return text
    .replace(PEM, REDACTED)
    .replace(URL_PASSWORD, `$1${REDACTED}@`)
    .replace(SECRET_FLAG, `$1$2${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, `$1=${REDACTED}`);
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function redact<T>(value: T): T {
  return walk(value, 0, false) as T;
}

function walk(value: unknown, depth: number, force: boolean): unknown {
  if (typeof value === 'string') return force ? REDACTED : scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, force));
  return walkObject(value as Rec, depth, force);
}

/** The object holds Secret/ConfigMap payload: by kind, or by shape when `kind` is missing. */
function holdsData(object: Rec): boolean {
  const kind = object['kind'];
  if (kind === 'Secret' || kind === 'ConfigMap') return true;
  return kind === undefined && isRec(object['metadata']);
}

function walkObject(object: Rec, depth: number, force: boolean): Rec {
  const out: Rec = {};
  const data = holdsData(object);
  for (const [key, value] of Object.entries(object)) {
    if (key === 'managedFields' || key === LAST_APPLIED) continue;
    if (data && DATA_KEYS.has(key)) {
      out[key] = redactValues(value);
    } else if (ENV_KEYS.has(key)) {
      out[key] = redactEnv(value, depth + 1);
    } else if (SENSITIVE_KEY.test(key)) {
      out[key] = redactSensitive(key, value, depth + 1, force);
    } else {
      out[key] = walk(value, depth + 1, force);
    }
  }
  return out;
}

function redactSensitive(key: string, value: unknown, depth: number, force: boolean): unknown {
  if (typeof value === 'string') return NAME_KEYS.has(key) && !force ? scrubText(value) : REDACTED;
  if (value === null || typeof value !== 'object') return value;
  // A reference container keeps its names; any other object under a credential key is wiped.
  return walk(value, depth, force || !REFERENCE_CONTAINERS.has(key));
}

/** Every entry of a data map becomes `[redacted]`; the key names stay. */
function redactValues(value: unknown): unknown {
  if (!isRec(value)) return value === null || value === undefined ? value : REDACTED;
  const out: Rec = {};
  for (const key of Object.keys(value)) out[key] = REDACTED;
  return out;
}

/**
 * `env`/`environment` in the three shapes tools print: `[{name, value, valueFrom}]`,
 * Compose's `["KEY=value"]` and `{KEY: value}`. Names and `valueFrom` references stay.
 */
function redactEnv(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === 'string') {
        const eq = entry.indexOf('=');
        return eq > 0 ? `${entry.slice(0, eq)}=${REDACTED}` : entry;
      }
      if (!isRec(entry)) return entry;
      const out: Rec = {};
      for (const [k, v] of Object.entries(entry)) {
        out[k] = k === 'value' && v !== null && v !== undefined ? REDACTED : walk(v, depth + 1, false);
      }
      return out;
    });
  }
  if (isRec(value)) {
    const out: Rec = {};
    for (const [k, v] of Object.entries(value)) out[k] = v === null || v === undefined ? v : REDACTED;
    return out;
  }
  return walk(value, depth, false);
}

/** `node.fields`: credential-looking keys and credentials embedded in text. */
export function redactFields<V extends FieldValue>(fields: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      out[key] = (SENSITIVE_KEY.test(key) ? REDACTED : scrubText(value)) as V;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** `node.tags`: same rule as fields; labels are strings. */
export function redactTags(tags: Record<string, string>): Record<string, string> {
  return redactFields(tags);
}
