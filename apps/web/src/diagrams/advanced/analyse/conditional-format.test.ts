import { describe, expect, it, vi } from 'vitest';
import { makeGraph, makeNode } from '../../fixtures';
import type { NodeTone } from '../../model';
import {
  MAX_BADGE_LENGTH,
  MAX_RULES,
  RULES_STORAGE_PREFIX,
  addRule,
  applyRules,
  blankRule,
  compileRule,
  loadRules,
  moveRule,
  removeRule,
  rulesHighlight,
  rulesStorageKey,
  saveRules,
  suggestFields,
  updateRule,
  validateRule,
  type FormatRule
} from './conditional-format';
import { buildEstate } from './test-estate';

function rule(overrides: Partial<FormatRule> = {}): FormatRule {
  return { id: 'rule-1', field: 'restarts', op: '>', value: '3', tone: 'danger', badge: '', enabled: true, ...overrides };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key)
  };
}

describe('validateRule', () => {
  it('accepts a complete rule', () => {
    expect(validateRule(rule())).toBeNull();
    expect(validateRule(rule({ field: 'tag:app', op: '=', value: 'web', tone: null, badge: 'web' }))).toBeNull();
    expect(validateRule(rule({ field: 'status', op: '!=', value: 'healthy' }))).toBeNull();
    expect(validateRule(rule({ op: 'exists', value: '' }))).toBeNull();
    expect(validateRule(rule({ op: 'exists', value: 'false' }))).toBeNull();
  });

  it('asks for a field and a tag key', () => {
    expect(validateRule(rule({ field: '' }))).toMatch(/field/i);
    expect(validateRule(rule({ field: '   ' }))).toMatch(/field/i);
    expect(validateRule(rule({ field: 'tag:' }))).toMatch(/tag/i);
    expect(validateRule(rule({ field: 'tag:   ' }))).toMatch(/tag/i);
  });

  it('rejects an unknown operator', () => {
    expect(validateRule(rule({ op: '~=' as never }))).toMatch(/operator/i);
  });

  it('asks for a value, and a number for the ordering operators', () => {
    expect(validateRule(rule({ op: '=', value: '' }))).toMatch(/value/i);
    expect(validateRule(rule({ op: 'contains', value: '  ' }))).toMatch(/value/i);
    expect(validateRule(rule({ op: '>', value: 'many' }))).toMatch(/number/i);
    expect(validateRule(rule({ op: '<=', value: '' }))).toMatch(/value|number/i);
    expect(validateRule(rule({ op: '>=', value: '2/3' }))).toMatch(/number/i);
  });

  it('limits exists to yes or no', () => {
    expect(validateRule(rule({ op: 'exists', value: 'maybe' }))).toMatch(/exists/i);
  });

  it('needs a known tone or a badge, and a short badge', () => {
    expect(validateRule(rule({ tone: null, badge: '' }))).toMatch(/tone or a badge/i);
    expect(validateRule(rule({ tone: null, badge: '   ' }))).toMatch(/tone or a badge/i);
    expect(validateRule(rule({ tone: 'rainbow' as NodeTone }))).toMatch(/tone/i);
    expect(validateRule(rule({ badge: 'x'.repeat(MAX_BADGE_LENGTH + 1) }))).toMatch(/badge/i);
    expect(validateRule(rule({ badge: 'x'.repeat(MAX_BADGE_LENGTH) }))).toBeNull();
  });

  it('never throws on rubbish', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, { field: 5, op: {}, value: [], tone: 3, badge: null }]) {
      expect(() => validateRule(bad as never)).not.toThrow();
      expect(typeof validateRule(bad as never)).toBe('string');
    }
  });
});

describe('compileRule and matching', () => {
  const matches = (r: FormatRule, node = makeNode('n')): boolean => compileRule(r)?.test(node) ?? false;

  it('returns null for an invalid rule', () => {
    expect(compileRule(rule({ field: '' }))).toBeNull();
  });

  it('compares numbers numerically when both sides are numbers', () => {
    const node = makeNode('n', { fields: { restarts: 12, ratio: '9', label2: 'abc' } });
    expect(matches(rule({ op: '>', value: '3' }), node)).toBe(true);
    // 12 > 3 numerically; as text "12" < "3", which is the bug this guards against.
    expect(matches(rule({ op: '<', value: '3' }), node)).toBe(false);
    expect(matches(rule({ op: '>=', value: '12' }), node)).toBe(true);
    expect(matches(rule({ op: '<=', value: '12' }), node)).toBe(true);
    expect(matches(rule({ field: 'ratio', op: '<', value: '10' }), node)).toBe(true);
    expect(matches(rule({ op: '=', value: '12.0' }), node)).toBe(true);
    expect(matches(rule({ op: '!=', value: '12' }), node)).toBe(false);
    expect(matches(rule({ op: '!=', value: '13' }), node)).toBe(true);
  });

  it('does not order text: a non-number field never satisfies > < >= <=', () => {
    const node = makeNode('n', { fields: { restarts: 'lots', ready: '2/3' } });
    for (const op of ['>', '>=', '<', '<='] as const) {
      expect(matches(rule({ op, value: '3' }), node), op).toBe(false);
      expect(matches(rule({ field: 'ready', op, value: '1' }), node), op).toBe(false);
    }
  });

  it('compares text ignoring case', () => {
    const node = makeNode('n', { fields: { phase: 'Running' } });
    expect(matches(rule({ field: 'phase', op: '=', value: 'running' }), node)).toBe(true);
    expect(matches(rule({ field: 'phase', op: '!=', value: 'Running' }), node)).toBe(false);
    expect(matches(rule({ field: 'phase', op: '!=', value: 'Pending' }), node)).toBe(true);
    expect(matches(rule({ field: 'phase', op: 'contains', value: 'UNN' }), node)).toBe(true);
    expect(matches(rule({ field: 'phase', op: 'contains', value: 'zzz' }), node)).toBe(false);
  });

  it('compares booleans as true / false text', () => {
    const node = makeNode('n', { fields: { privileged: true, hostNetwork: false } });
    expect(matches(rule({ field: 'privileged', op: '=', value: 'true' }), node)).toBe(true);
    expect(matches(rule({ field: 'hostNetwork', op: '=', value: 'true' }), node)).toBe(false);
    expect(matches(rule({ field: 'hostNetwork', op: '!=', value: 'true' }), node)).toBe(true);
  });

  it('never matches a null or missing field, even for !=', () => {
    const node = makeNode('n', { fields: { lastWarning: null } });
    for (const op of ['=', '!=', '>', '>=', '<', '<=', 'contains'] as const) {
      const value = op === 'contains' || op === '=' || op === '!=' ? 'x' : '1';
      expect(matches(rule({ field: 'lastWarning', op, value }), node), `null ${op}`).toBe(false);
      expect(matches(rule({ field: 'absent', op, value }), node), `missing ${op}`).toBe(false);
    }
  });

  it('exists matches a reported field; exists = false matches an unreported one', () => {
    const node = makeNode('n', { fields: { podIP: '10.0.0.1', lastWarning: null, zero: 0, empty: '' } });
    expect(matches(rule({ field: 'podIP', op: 'exists', value: '' }), node)).toBe(true);
    expect(matches(rule({ field: 'podIP', op: 'exists', value: 'true' }), node)).toBe(true);
    expect(matches(rule({ field: 'zero', op: 'exists', value: '' }), node)).toBe(true);
    expect(matches(rule({ field: 'empty', op: 'exists', value: '' }), node)).toBe(true);
    expect(matches(rule({ field: 'lastWarning', op: 'exists', value: '' }), node)).toBe(false);
    expect(matches(rule({ field: 'absent', op: 'exists', value: '' }), node)).toBe(false);
    expect(matches(rule({ field: 'lastWarning', op: 'exists', value: 'false' }), node)).toBe(true);
    expect(matches(rule({ field: 'absent', op: 'exists', value: 'false' }), node)).toBe(true);
    expect(matches(rule({ field: 'podIP', op: 'exists', value: 'false' }), node)).toBe(false);
  });

  it('reads the pseudo-fields status, kind and label', () => {
    const node = makeNode('n', { kind: 'k8s-pod', label: 'web-1', status: 'failed' });
    expect(matches(rule({ field: 'status', op: '=', value: 'failed' }), node)).toBe(true);
    expect(matches(rule({ field: 'kind', op: '=', value: 'k8s-pod' }), node)).toBe(true);
    expect(matches(rule({ field: 'label', op: 'contains', value: 'web' }), node)).toBe(true);
    expect(matches(rule({ field: 'label', op: 'exists', value: '' }), node)).toBe(true);
    expect(matches(rule({ field: 'kind', op: 'exists', value: 'false' }), node)).toBe(false);
  });

  it('treats an unknown status as not reported, not as healthy', () => {
    const unknown = makeNode('n', { status: 'unknown' });
    expect(matches(rule({ field: 'status', op: '=', value: 'healthy' }), unknown)).toBe(false);
    expect(matches(rule({ field: 'status', op: '!=', value: 'healthy' }), unknown)).toBe(true);
    expect(matches(rule({ field: 'status', op: '=', value: 'unknown' }), unknown)).toBe(true);
    expect(matches(rule({ field: 'status', op: 'exists', value: '' }), unknown)).toBe(false);
    expect(matches(rule({ field: 'status', op: 'exists', value: 'false' }), unknown)).toBe(true);
    expect(matches(rule({ field: 'status', op: 'exists', value: '' }), makeNode('k', { status: 'healthy' }))).toBe(true);
  });

  it('reads tags with tag:<key>', () => {
    const node = makeNode('n', { tags: { app: 'web', 'app.kubernetes.io/name': 'shop' } });
    expect(matches(rule({ field: 'tag:app', op: '=', value: 'web' }), node)).toBe(true);
    expect(matches(rule({ field: 'tag:app.kubernetes.io/name', op: '=', value: 'shop' }), node)).toBe(true);
    expect(matches(rule({ field: 'tag:tier', op: '=', value: 'web' }), node)).toBe(false);
    expect(matches(rule({ field: 'tag:tier', op: 'exists', value: 'false' }), node)).toBe(true);
    expect(matches(rule({ field: 'tag:app', op: 'exists', value: '' }), node)).toBe(true);
  });

  it('cannot be fooled by a field named after an Object.prototype member', () => {
    const node = makeNode('n', { fields: { a: 1 } });
    for (const field of ['constructor', 'toString', '__proto__', 'tag:constructor']) {
      expect(matches(rule({ field, op: 'exists', value: '' }), node), field).toBe(false);
      expect(matches(rule({ field, op: 'exists', value: 'false' }), node), field).toBe(true);
    }
  });
});

describe('applyRules', () => {
  const nodes = [
    makeNode('a', { fields: { restarts: 12 }, status: 'failed' }),
    makeNode('b', { fields: { restarts: 5 }, status: 'warning' }),
    makeNode('c', { fields: { restarts: 0 }, status: 'healthy' }),
    makeNode('d', { fields: { restarts: null }, status: 'unknown' })
  ];
  const graph = makeGraph(nodes);

  it('lets the first matching rule win per node', () => {
    const result = applyRules(graph, [
      rule({ id: 'r1', op: '>', value: '10', tone: 'danger', badge: 'crashing' }),
      rule({ id: 'r2', op: '>', value: '3', tone: 'warning', badge: 'flaky' })
    ]);
    expect(result.tones).toEqual({ a: 'danger', b: 'warning' });
    expect(result.badges).toEqual({ a: 'crashing', b: 'flaky' });
    expect(result.matched).toBe(2);
    // Each rule counts every node it matches, whichever rule wins.
    expect(result.stats.map((s) => [s.ruleId, s.matches])).toEqual([['r1', 1], ['r2', 2]]);
  });

  it('does not merge: a winning rule without a badge leaves the node without one', () => {
    const result = applyRules(graph, [
      rule({ id: 'r1', op: '>', value: '10', tone: 'danger', badge: '' }),
      rule({ id: 'r2', op: '>', value: '3', tone: null, badge: 'flaky' })
    ]);
    expect(result.tones).toEqual({ a: 'danger' });
    expect(result.badges).toEqual({ b: 'flaky' });
  });

  it('counts how many nodes report the field, so a typo is visible', () => {
    const result = applyRules(graph, [rule({ id: 'r1', field: 'restarts', op: '>', value: '100' }), rule({ id: 'r2', field: 'restartz', op: '>', value: '1' })]);
    expect(result.stats[0]).toMatchObject({ ruleId: 'r1', reported: 3, matches: 0, error: null });
    expect(result.stats[1]).toMatchObject({ ruleId: 'r2', reported: 0, matches: 0 });
  });

  it('skips disabled rules and reports invalid ones without throwing', () => {
    const result = applyRules(graph, [
      rule({ id: 'off', enabled: false, op: '>', value: '0' }),
      rule({ id: 'bad', field: '' }),
      rule({ id: 'ok', op: '>', value: '10' })
    ]);
    expect(Object.keys(result.tones)).toEqual(['a']);
    expect(result.stats.find((s) => s.ruleId === 'off')).toMatchObject({ matches: 0, reported: 0, error: null, enabled: false });
    expect(result.stats.find((s) => s.ruleId === 'bad')?.error).toMatch(/field/i);
    expect(result.errors).toEqual({ bad: expect.stringMatching(/field/i) });
  });

  it('formats nothing for an empty graph or no rules', () => {
    expect(applyRules(makeGraph([]), [rule()]).matched).toBe(0);
    expect(applyRules(graph, []).matched).toBe(0);
    expect(applyRules(graph, []).stats).toEqual([]);
  });

  it('formats the estate: crash-looping pods and failed units', () => {
    const estate = buildEstate();
    const result = applyRules(estate, [
      rule({ id: 'crash', field: 'restarts', op: '>', value: '3', tone: 'danger', badge: 'restarts' }),
      rule({ id: 'failed', field: 'activeState', op: '=', value: 'failed', tone: 'danger', badge: 'failed' })
    ]);
    expect(Object.keys(result.tones).sort()).toEqual(['docker:container:debug', 'k8s:pod:shop/web-7c9f-c3d4e', 'systemd:unit:backup.service']);
    expect(result.badges['systemd:unit:backup.service']).toBe('failed');
    expect(result.badges['k8s:pod:shop/web-7c9f-c3d4e']).toBe('restarts');
  });

  it('handles a large graph quickly', () => {
    const big = makeGraph(Array.from({ length: 5000 }, (_, i) => makeNode(`n${i}`, { fields: { restarts: i } })));
    const started = performance.now();
    const result = applyRules(big, [rule({ op: '>=', value: '4990' }), rule({ id: 'r2', field: 'label', op: 'contains', value: '99' })]);
    expect(result.matched).toBeGreaterThan(10);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('rulesHighlight', () => {
  it('turns a result into tones and badges without dimming', () => {
    const graph = makeGraph([makeNode('a', { fields: { restarts: 9 } })]);
    const result = applyRules(graph, [rule({ op: '>', value: '3', badge: 'hot' })]);
    const highlight = rulesHighlight(result);
    expect(highlight).toMatchObject({ id: 'conditional-format', dimOthers: false, tones: { a: 'danger' }, badges: { a: 'hot' }, nodes: {}, edges: {} });
    expect(highlight?.detail).toContain('1 node');
  });

  it('is null when nothing is formatted', () => {
    expect(rulesHighlight(applyRules(makeGraph([makeNode('a')]), [rule()]))).toBeNull();
  });
});

describe('editing helpers', () => {
  it('adds with the smallest unused id and refuses beyond the cap', () => {
    const first = addRule([], blankRule());
    expect(first.map((r) => r.id)).toEqual(['rule-1']);
    const second = addRule(first, blankRule());
    expect(second.map((r) => r.id)).toEqual(['rule-1', 'rule-2']);
    const gap = addRule([rule({ id: 'rule-2' })], blankRule());
    expect(gap.map((r) => r.id)).toEqual(['rule-2', 'rule-1']);
    const full = Array.from({ length: MAX_RULES }, (_, i) => rule({ id: `rule-${i + 1}` }));
    expect(addRule(full, blankRule())).toBe(full);
  });

  it('updates, removes and moves without mutating', () => {
    const list = [rule({ id: 'a' }), rule({ id: 'b' }), rule({ id: 'c' })];
    expect(updateRule(list, 'b', { value: '9' }).map((r) => r.value)).toEqual(['3', '9', '3']);
    expect(list[1]?.value).toBe('3');
    expect(removeRule(list, 'b').map((r) => r.id)).toEqual(['a', 'c']);
    expect(moveRule(list, 'c', -1).map((r) => r.id)).toEqual(['a', 'c', 'b']);
    expect(moveRule(list, 'a', 1).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(moveRule(list, 'a', -1)).toBe(list);
    expect(moveRule(list, 'c', 1)).toBe(list);
    expect(moveRule(list, 'ghost', 1)).toBe(list);
  });

  it('starts a blank rule that is not valid yet', () => {
    expect(validateRule(blankRule())).not.toBeNull();
  });
});

describe('suggestFields', () => {
  it('lists the pseudo-fields, every reported field and every tag key', () => {
    const graph = makeGraph([makeNode('a', { fields: { restarts: 1, phase: 'Running' }, tags: { app: 'web' } }), makeNode('b', { fields: { restarts: 2, extra: null }, tags: { tier: 'db' } })]);
    expect(suggestFields(graph)).toEqual(['status', 'kind', 'label', 'extra', 'phase', 'restarts', 'tag:app', 'tag:tier']);
  });

  it('is just the pseudo-fields for an empty graph', () => {
    expect(suggestFields(makeGraph([]))).toEqual(['status', 'kind', 'label']);
  });
});

describe('persistence', () => {
  const graph = makeGraph([], [], { hostKey: 'ops@prod-1:22' });

  it('keys rules per estate', () => {
    expect(RULES_STORAGE_PREFIX).toBe('webssh.diagrams.rules.v1:');
    expect(rulesStorageKey(graph)).toBe('webssh.diagrams.rules.v1:ops@prod-1:22');
    expect(rulesStorageKey({ title: 'Terraform plan' })).toBe('webssh.diagrams.rules.v1:import:Terraform plan');
  });

  it('round-trips rules', () => {
    const storage = memoryStorage();
    const rules = [rule({ id: 'a', badge: 'hot' }), rule({ id: 'b', field: 'tag:app', op: 'exists', value: 'false', tone: null, badge: 'no app', enabled: false })];
    expect(saveRules(storage, 'k', rules)).toBe(true);
    expect(loadRules(storage, 'k')).toEqual({ rules, dropped: 0 });
  });

  it('removes the entry when the last rule goes', () => {
    const storage = memoryStorage();
    saveRules(storage, 'k', [rule()]);
    expect(storage.data.has('k')).toBe(true);
    saveRules(storage, 'k', []);
    expect(storage.data.has('k')).toBe(false);
  });

  it('loads nothing from an empty or missing entry', () => {
    expect(loadRules(memoryStorage(), 'k')).toEqual({ rules: [], dropped: 0 });
  });

  it('survives malformed JSON and the wrong shape', () => {
    for (const raw of ['{not json', '42', 'null', '"text"', '{"version":1}', '{"version":1,"rules":"x"}']) {
      expect(() => loadRules(memoryStorage({ k: raw }), 'k'), raw).not.toThrow();
      expect(loadRules(memoryStorage({ k: raw }), 'k').rules, raw).toEqual([]);
    }
  });

  it('keeps well-formed entries and counts the ones it dropped', () => {
    const raw = JSON.stringify({
      version: 1,
      rules: [
        { id: 'a', field: 'restarts', op: '>', value: '3', tone: 'danger', badge: '', enabled: true },
        { id: 'b', field: 'restarts', op: '~~', value: '3', tone: 'danger', badge: '', enabled: true },
        'rubbish',
        null,
        { field: 'status', op: '=', value: 'failed', tone: 'bogus', badge: 5, enabled: 'yes' },
        { id: 'c', field: 'phase', op: '=', value: 7, tone: null, badge: 'x' }
      ]
    });
    const { rules, dropped } = loadRules(memoryStorage({ k: raw }), 'k');
    expect(dropped).toBe(3);
    expect(rules.map((r) => r.id)).toEqual(['a', 'rule-1', 'c']);
    // A structurally odd but readable entry is repaired, not trusted.
    expect(rules[1]).toMatchObject({ field: 'status', op: '=', value: 'failed', tone: null, badge: '', enabled: true });
    expect(rules[2]).toMatchObject({ value: '7', tone: null, badge: 'x' });
  });

  it('accepts a bare array and caps the list', () => {
    const many = Array.from({ length: MAX_RULES + 5 }, (_, i) => ({ id: `r${i}`, field: 'label', op: 'contains', value: 'x', tone: 'info', badge: '', enabled: true }));
    const loaded = loadRules(memoryStorage({ k: JSON.stringify(many) }), 'k');
    expect(loaded.rules.length).toBe(MAX_RULES);
    expect(loaded.dropped).toBe(5);
  });

  it('gives duplicate ids a fresh one', () => {
    const raw = JSON.stringify([
      { id: 'x', field: 'label', op: 'contains', value: 'a', tone: 'info', badge: '', enabled: true },
      { id: 'x', field: 'label', op: 'contains', value: 'b', tone: 'info', badge: '', enabled: true }
    ]);
    const ids = loadRules(memoryStorage({ k: raw }), 'k').rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('reports a failed write instead of throwing', () => {
    const storage = {
      getItem: () => null,
      setItem: vi.fn(() => {
        throw new Error('quota');
      }),
      removeItem: vi.fn()
    };
    expect(saveRules(storage, 'k', [rule()])).toBe(false);
  });

  it('reads nothing when the store throws', () => {
    const storage = {
      getItem: () => {
        throw new Error('denied');
      }
    };
    expect(loadRules(storage, 'k')).toEqual({ rules: [], dropped: 0 });
  });
});
