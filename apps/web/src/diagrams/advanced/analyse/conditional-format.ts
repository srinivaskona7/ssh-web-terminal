/**
 * Conditional formatting (feature 12): rules `field op value -> tone/badge`,
 * evaluated over the drawn graph and handed to the canvas as a `Highlight`.
 *
 * Rules never throw. A rule that does not validate is skipped and carries an
 * error message for the editor. A field the node does not report is never a
 * match (not even for `!=`); only `exists` can ask about absence.
 */
import { storageKeyFor, type DiagramGraph, type DiagramNode, type FieldValue, type Highlight, type NodeTone } from '../../model.js';
import { fieldValue, tagValue, toNumber } from './node-facts.js';

export const RULE_OPS = ['=', '!=', '>', '>=', '<', '<=', 'contains', 'exists'] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export const RULE_TONES: readonly NodeTone[] = ['accent', 'success', 'warning', 'danger', 'info', 'muted'];

/** Fields every node has, besides `node.fields` and `tag:<key>`. */
export const PSEUDO_FIELDS = ['status', 'kind', 'label'] as const;

export const MAX_RULES = 50;
export const MAX_BADGE_LENGTH = 24;
export const RULES_STORAGE_PREFIX = 'webssh.diagrams.rules.v1:';

const ORDERING_OPS: ReadonlySet<string> = new Set(['>', '>=', '<', '<=']);

export interface FormatRule {
  id: string;
  /** A name in `node.fields`, `status`, `kind`, `label`, or `tag:<key>`. */
  field: string;
  op: RuleOp;
  /** Text to compare with. For `exists`: empty or `true` (reported) or `false` (not reported). */
  value: string;
  tone: NodeTone | null;
  badge: string;
  enabled: boolean;
}

/** The message to show beside a rule that cannot be used, or null when it is fine. */
export function validateRule(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return 'Not a rule.';
  const r = input as Record<string, unknown>;
  const field = typeof r.field === 'string' ? r.field.trim() : '';
  if (field === '') return 'Choose a field.';
  if (field.startsWith('tag:') && field.slice(4).trim() === '') return 'A tag rule needs a key, for example tag:app.';
  const op = r.op;
  if (typeof op !== 'string' || !(RULE_OPS as readonly string[]).includes(op)) {
    return `Unknown operator "${String(op)}". Use one of ${RULE_OPS.join(' ')}.`;
  }
  const value = typeof r.value === 'string' ? r.value.trim() : '';
  if (op === 'exists') {
    if (value !== '' && value !== 'true' && value !== 'false') return 'exists takes yes or no.';
  } else if (value === '') {
    return 'Enter a value to compare with.';
  } else if (ORDERING_OPS.has(op) && toNumber(value) === null) {
    return `${op} compares numbers, but "${value}" is not a number.`;
  }
  const tone = r.tone;
  if (tone !== null && tone !== undefined && !(RULE_TONES as readonly unknown[]).includes(tone)) {
    return `Unknown tone "${String(tone)}".`;
  }
  const badge = typeof r.badge === 'string' ? r.badge.trim() : '';
  if (badge.length > MAX_BADGE_LENGTH) return `Badge text is limited to ${MAX_BADGE_LENGTH} characters.`;
  if (!tone && badge === '') return 'Choose a tone or a badge, or the rule changes nothing.';
  return null;
}

interface Resolved {
  /** What a comparison reads; undefined or null when the node does not report it. */
  value: FieldValue | undefined;
  /** What `exists` asks about. */
  reported: boolean;
}

function resolve(node: DiagramNode, field: string): Resolved {
  if (field === 'status') {
    // The literal status is comparable ("status != healthy" is true for an
    // unknown node), but an unknown status is not a reported one.
    return { value: node.status, reported: node.status !== 'unknown' };
  }
  if (field === 'kind') return { value: node.kind, reported: true };
  if (field === 'label') return { value: node.label, reported: true };
  const value = field.startsWith('tag:') ? tagValue(node, field.slice(4).trim()) : fieldValue(node, field);
  return { value, reported: value !== undefined && value !== null };
}

export interface CompiledRule {
  rule: FormatRule;
  /** Does the node report the rule's field? */
  reports: (node: DiagramNode) => boolean;
  test: (node: DiagramNode) => boolean;
}

/** Null when the rule does not validate. */
export function compileRule(rule: FormatRule): CompiledRule | null {
  if (validateRule(rule) !== null) return null;
  const field = rule.field.trim();
  const wanted = rule.value.trim();
  const wantedNumber = toNumber(wanted);
  const wantedText = wanted.toLowerCase();

  const reports = (node: DiagramNode): boolean => resolve(node, field).reported;
  const same = (value: FieldValue): boolean => {
    const left = toNumber(value);
    return left !== null && wantedNumber !== null ? left === wantedNumber : String(value).toLowerCase() === wantedText;
  };
  const order = (value: FieldValue, compare: (left: number, right: number) => boolean): boolean => {
    const left = toNumber(value);
    return left !== null && wantedNumber !== null && compare(left, wantedNumber);
  };

  const test = (node: DiagramNode): boolean => {
    const resolved = resolve(node, field);
    if (rule.op === 'exists') return resolved.reported === (wanted !== 'false');
    const value = resolved.value;
    if (value === undefined || value === null) return false;
    switch (rule.op) {
      case '=':
        return same(value);
      case '!=':
        return !same(value);
      case '>':
        return order(value, (l, r) => l > r);
      case '>=':
        return order(value, (l, r) => l >= r);
      case '<':
        return order(value, (l, r) => l < r);
      case '<=':
        return order(value, (l, r) => l <= r);
      case 'contains':
        return String(value).toLowerCase().includes(wantedText);
    }
  };
  return { rule, reports, test };
}

export interface RuleStat {
  ruleId: string;
  enabled: boolean;
  /** Why the rule is not applied; null for a usable rule. */
  error: string | null;
  /** Nodes that report the rule's field. */
  reported: number;
  /** Nodes the rule matches, whether or not an earlier rule won them. */
  matches: number;
}

export interface FormatResult {
  tones: Record<string, NodeTone>;
  badges: Record<string, string>;
  /** Nodes that got a tone or a badge. */
  matched: number;
  stats: RuleStat[];
  errors: Record<string, string>;
}

/** The first enabled, valid rule that matches a node decides its tone and badge. Rules are not merged. */
export function applyRules(graph: Pick<DiagramGraph, 'nodes'>, rules: readonly FormatRule[]): FormatResult {
  const errors: Record<string, string> = {};
  const stats: RuleStat[] = [];
  const active: { compiled: CompiledRule; stat: RuleStat }[] = [];
  for (const rule of rules) {
    const error = validateRule(rule);
    const stat: RuleStat = { ruleId: rule.id, enabled: rule.enabled, error, reported: 0, matches: 0 };
    stats.push(stat);
    if (error !== null) {
      errors[rule.id] = error;
      continue;
    }
    if (!rule.enabled) continue;
    const compiled = compileRule(rule);
    if (compiled) active.push({ compiled, stat });
  }

  const tones: Record<string, NodeTone> = {};
  const badges: Record<string, string> = {};
  let matched = 0;
  for (const node of graph.nodes) {
    let won = false;
    for (const { compiled, stat } of active) {
      if (compiled.reports(node)) stat.reported += 1;
      if (!compiled.test(node)) continue;
      stat.matches += 1;
      if (won) continue;
      won = true;
      if (compiled.rule.tone) tones[node.id] = compiled.rule.tone;
      const badge = compiled.rule.badge.trim();
      if (badge !== '') badges[node.id] = badge;
    }
    if (won) matched += 1;
  }
  return { tones, badges, matched, stats, errors };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Null when no node is formatted, so the studio shows no overlay at all. */
export function rulesHighlight(result: FormatResult): Highlight | null {
  if (result.matched === 0) return null;
  const rules = result.stats.filter((s) => s.enabled && s.error === null).length;
  return {
    id: 'conditional-format',
    title: 'Conditional formatting',
    detail: `${plural(result.matched, 'node')} formatted by ${plural(rules, 'rule')}.`,
    nodes: {},
    edges: {},
    dimOthers: false,
    tones: result.tones,
    badges: result.badges
  };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** A draft for the editor; it has no id until `addRule` gives it one. */
export function blankRule(): FormatRule {
  return { id: '', field: '', op: '=', value: '', tone: 'warning', badge: '', enabled: true };
}

function freshId(used: ReadonlySet<string>): string {
  let n = 1;
  while (used.has(`rule-${n}`)) n += 1;
  return `rule-${n}`;
}

/** Appends with the smallest unused id; returns the same list once it holds `MAX_RULES`. */
export function addRule(rules: readonly FormatRule[], draft: FormatRule): readonly FormatRule[] {
  if (rules.length >= MAX_RULES) return rules;
  return [...rules, { ...draft, id: freshId(new Set(rules.map((r) => r.id))) }];
}

export function updateRule(rules: readonly FormatRule[], id: string, patch: Partial<Omit<FormatRule, 'id'>>): FormatRule[] {
  return rules.map((r) => (r.id === id ? { ...r, ...patch } : r));
}

export function removeRule(rules: readonly FormatRule[], id: string): FormatRule[] {
  return rules.filter((r) => r.id !== id);
}

/** Earlier rules win, so order matters. Returns the same list when the move goes nowhere. */
export function moveRule(rules: readonly FormatRule[], id: string, delta: -1 | 1): readonly FormatRule[] {
  const from = rules.findIndex((r) => r.id === id);
  const to = from + delta;
  const moving = rules[from];
  const displaced = rules[to];
  if (from === -1 || !moving || !displaced) return rules;
  const next = [...rules];
  next[from] = displaced;
  next[to] = moving;
  return next;
}

/** Field names worth offering in the editor: the pseudo-fields, then what the graph reports, then tag keys. */
export function suggestFields(graph: Pick<DiagramGraph, 'nodes'>): string[] {
  const fields = new Set<string>();
  const tags = new Set<string>();
  for (const node of graph.nodes) {
    for (const key of Object.keys(node.fields)) fields.add(key);
    for (const key of Object.keys(node.tags)) tags.add(`tag:${key}`);
  }
  const sorted = (set: Set<string>): string[] => [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...PSEUDO_FIELDS, ...sorted(fields), ...sorted(tags)];
}

// ---------------------------------------------------------------------------
// Persistence: per estate, in localStorage
// ---------------------------------------------------------------------------

export function rulesStorageKey(graph: Pick<DiagramGraph, 'hostKey' | 'title'>): string {
  return `${RULES_STORAGE_PREFIX}${storageKeyFor(graph)}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function coerceRule(entry: unknown): FormatRule | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.field !== 'string') return null;
  const op = entry.op;
  if (typeof op !== 'string' || !(RULE_OPS as readonly string[]).includes(op)) return null;
  const value = typeof entry.value === 'string' ? entry.value : typeof entry.value === 'number' || typeof entry.value === 'boolean' ? String(entry.value) : '';
  const tone = (RULE_TONES as readonly unknown[]).includes(entry.tone) ? (entry.tone as NodeTone) : null;
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    field: entry.field,
    op: op as RuleOp,
    value,
    tone,
    badge: typeof entry.badge === 'string' ? entry.badge : '',
    enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true
  };
}

/** Never throws: a missing, unreadable or malformed entry loads as no rules. `dropped` counts entries that could not be read. */
export function loadRules(storage: Pick<Storage, 'getItem'>, key: string): { rules: FormatRule[]; dropped: number } {
  const none = { rules: [], dropped: 0 };
  let list: unknown[];
  try {
    const raw = storage.getItem(key);
    if (!raw) return none;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed;
    else if (isRecord(parsed) && Array.isArray(parsed.rules)) list = parsed.rules;
    else return none;
  } catch {
    return none;
  }

  let dropped = Math.max(0, list.length - MAX_RULES);
  const kept: FormatRule[] = [];
  for (const entry of list.slice(0, MAX_RULES)) {
    const rule = coerceRule(entry);
    if (rule) kept.push(rule);
    else dropped += 1;
  }

  const used = new Set<string>();
  for (const rule of kept) {
    if (rule.id !== '' && !used.has(rule.id)) used.add(rule.id);
    else rule.id = '';
  }
  for (const rule of kept) {
    if (rule.id !== '') continue;
    rule.id = freshId(used);
    used.add(rule.id);
  }
  return { rules: kept, dropped };
}

/** False when the browser refused the write (private mode, quota). */
export function saveRules(storage: Pick<Storage, 'setItem' | 'removeItem'>, key: string, rules: readonly FormatRule[]): boolean {
  try {
    if (rules.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ version: 1, rules }));
    return true;
  } catch {
    return false;
  }
}
