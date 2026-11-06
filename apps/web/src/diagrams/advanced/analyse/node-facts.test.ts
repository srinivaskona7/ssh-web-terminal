import { describe, expect, it } from 'vitest';
import { makeNode } from '../../fixtures';
import type { NodeKind } from '../../model';
import { KIND_LABELS, compareText, fieldBoolean, fieldNumber, fieldText, fieldValue, groupByKind, kindLabel, statusLabel, tagValue, toNumber } from './node-facts';

describe('fieldValue', () => {
  const node = makeNode('n', { fields: { restarts: 3, name: 'web', ready: true, gone: null }, tags: { app: 'web' } });

  it('returns reported values and null for a field reported as null', () => {
    expect(fieldValue(node, 'restarts')).toBe(3);
    expect(fieldValue(node, 'gone')).toBeNull();
  });

  it('returns undefined for a field the node does not carry', () => {
    expect(fieldValue(node, 'missing')).toBeUndefined();
  });

  it('never reads the prototype chain', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(fieldValue(node, name), name).toBeUndefined();
      expect(tagValue(node, name), name).toBeUndefined();
    }
  });

  it('reads tags by key', () => {
    expect(tagValue(node, 'app')).toBe('web');
    expect(tagValue(node, 'tier')).toBeUndefined();
  });
});

describe('toNumber', () => {
  it('accepts numbers and strings that are entirely a number', () => {
    expect(toNumber(4)).toBe(4);
    expect(toNumber(0)).toBe(0);
    expect(toNumber('12')).toBe(12);
    expect(toNumber(' 3.5 ')).toBe(3.5);
    expect(toNumber('-2')).toBe(-2);
    expect(toNumber('1e3')).toBe(1000);
    expect(toNumber('.5')).toBe(0.5);
  });

  it('rejects everything that is not a plain decimal number', () => {
    for (const value of ['', ' ', 'abc', '2/3', '12px', '0x10', 'Infinity', 'NaN', '1,5', true, false, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(toNumber(value as never), String(value)).toBeNull();
    }
  });
});

describe('field accessors', () => {
  const node = makeNode('n', { fields: { restarts: '7', flag: 'true', off: false, text: 'hello', zero: 0, nothing: null } });

  it('reads numbers, booleans and text, and null when not reported', () => {
    expect(fieldNumber(node, 'restarts')).toBe(7);
    expect(fieldNumber(node, 'text')).toBeNull();
    expect(fieldNumber(node, 'nothing')).toBeNull();
    expect(fieldNumber(node, 'missing')).toBeNull();
    expect(fieldBoolean(node, 'flag')).toBe(true);
    expect(fieldBoolean(node, 'off')).toBe(false);
    expect(fieldBoolean(node, 'text')).toBeNull();
    expect(fieldBoolean(node, 'nothing')).toBeNull();
    expect(fieldText(node, 'text')).toBe('hello');
    expect(fieldText(node, 'zero')).toBe('0');
    expect(fieldText(node, 'off')).toBe('false');
    expect(fieldText(node, 'nothing')).toBeNull();
    expect(fieldText(node, 'missing')).toBeNull();
  });

  it('reads the string "false" as false', () => {
    expect(fieldBoolean(makeNode('x', { fields: { a: 'False' } }), 'a')).toBe(false);
  });
});

describe('labels', () => {
  it('names every node kind', () => {
    const kinds = Object.keys(KIND_LABELS) as NodeKind[];
    expect(kinds.length).toBeGreaterThanOrEqual(33);
    for (const kind of kinds) expect(KIND_LABELS[kind].length, kind).toBeGreaterThan(0);
    expect(kindLabel('k8s-pod')).toBe('Pod');
    expect(kindLabel('systemd-unit')).toBe('systemd unit');
  });

  it('falls back to the raw kind for one it has no label for', () => {
    expect(kindLabel('quantum-widget' as NodeKind)).toBe('quantum-widget');
  });

  it('says "not reported" for an unknown status', () => {
    expect(statusLabel('unknown')).toBe('not reported');
    expect(statusLabel('failed')).toBe('failed');
  });

  it('compares text without locale surprises', () => {
    expect(compareText('a', 'b')).toBeLessThan(0);
    expect(compareText('b', 'a')).toBeGreaterThan(0);
    expect(compareText('a', 'a')).toBe(0);
    expect(['b', 'B', 'a'].sort(compareText)).toEqual(['B', 'a', 'b']);
  });
});

describe('groupByKind', () => {
  const nodes = new Map(
    [
      makeNode('p1', { kind: 'k8s-pod', label: 'p1' }),
      makeNode('p2', { kind: 'k8s-pod', label: 'p2' }),
      makeNode('s1', { kind: 'k8s-service', label: 's1' }),
      makeNode('u1', { kind: 'systemd-unit', label: 'u1' })
    ].map((n) => [n.id, n])
  );

  it('groups ids by kind, largest group first, then by name', () => {
    const groups = groupByKind(['u1', 'p1', 's1', 'p2'], nodes);
    expect(groups.map((g) => [g.kind, g.label, g.ids])).toEqual([
      ['k8s-pod', 'Pod', ['p1', 'p2']],
      ['k8s-service', 'Service', ['s1']],
      ['systemd-unit', 'systemd unit', ['u1']]
    ]);
  });

  it('skips ids that are not nodes and handles an empty list', () => {
    expect(groupByKind(['ghost'], nodes)).toEqual([]);
    expect(groupByKind([], nodes)).toEqual([]);
  });
});
