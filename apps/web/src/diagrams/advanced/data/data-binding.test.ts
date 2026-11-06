import { describe, expect, it } from 'vitest';
import { makeEdge, makeGraph, makeNode } from '../../fixtures.js';
import { DataParseError, MAX_DATA_BYTES, assertWithinSizeCap, bindRows, coerceCell, parseCsv, parseJsonRows } from './data-binding.js';

describe('parseCsv', () => {
  it('parses a header and rows with LF and CRLF endings and a trailing newline', () => {
    expect(parseCsv('name,team\nweb,core\ndb,data\n').rows).toEqual([
      { name: 'web', team: 'core' },
      { name: 'db', team: 'data' }
    ]);
    expect(parseCsv('name,team\r\nweb,core\r\n').rows).toEqual([{ name: 'web', team: 'core' }]);
    expect(parseCsv('name,team\r\nweb,core\r\n').columns).toEqual(['name', 'team']);
  });

  it('strips a BOM, so the first column is not "\\uFEFFname"', () => {
    expect(parseCsv('﻿name,team\nweb,core').columns).toEqual(['name', 'team']);
  });

  it('handles quoted fields, escaped quotes, embedded delimiters and newlines', () => {
    const csv = 'name,note\n"web, front","said ""hi"""\n"db","line1\nline2"\n';
    expect(parseCsv(csv).rows).toEqual([
      { name: 'web, front', note: 'said "hi"' },
      { name: 'db', note: 'line1\nline2' }
    ]);
  });

  it('keeps empty cells as empty strings and skips blank lines', () => {
    expect(parseCsv('a,b\n1,\n\n,2\n').rows).toEqual([
      { a: '1', b: '' },
      { a: '', b: '2' }
    ]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(parseCsv('a;b\n1;2').rows).toEqual([{ a: '1', b: '2' }]);
    expect(parseCsv('a\tb\n1\t2').rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('reports a ragged row with its line number', () => {
    const failure = (() => {
      try {
        parseCsv('a,b\n1,2\n3\n');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(failure).toBeInstanceOf(DataParseError);
    expect((failure as DataParseError).line).toBe(3);
    expect((failure as DataParseError).message).toMatch(/line 3/i);
  });

  it('counts physical lines when a quoted field spans lines', () => {
    expect(() => parseCsv('a,b\n"x\ny",1\n2')).toThrow(/line 4/i);
  });

  it('rejects empty input, a header-only file gives no rows', () => {
    expect(() => parseCsv('')).toThrow(DataParseError);
    expect(() => parseCsv('\n\n')).toThrow(/no data/i);
    expect(parseCsv('a,b\n').rows).toEqual([]);
  });

  it('rejects empty, duplicate and prototype-polluting headers', () => {
    expect(() => parseCsv('a,,c\n1,2,3')).toThrow(/empty/i);
    expect(() => parseCsv('a,a\n1,2')).toThrow(/duplicate/i);
    expect(() => parseCsv('__proto__,b\n1,2')).toThrow(DataParseError);
  });

  it('reports an unterminated quote at the line it opened', () => {
    expect(() => parseCsv('a,b\n1,"oops\n2,3')).toThrow(/line 2/i);
  });
});

describe('parseJsonRows', () => {
  it('accepts an array of objects and { rows: [...] }', () => {
    const rows = [{ id: 'a', n: 1 }, { id: 'b', n: 2, extra: true }];
    expect(parseJsonRows(JSON.stringify(rows)).rows).toEqual(rows);
    expect(parseJsonRows(JSON.stringify({ rows })).columns).toEqual(['id', 'n', 'extra']);
  });

  it('stringifies nested values and keeps null', () => {
    expect(parseJsonRows('[{"a":{"b":1},"c":null,"d":[1]}]').rows).toEqual([{ a: '{"b":1}', c: null, d: '[1]' }]);
  });

  it('rejects invalid JSON, wrong shapes and non-object entries', () => {
    expect(() => parseJsonRows('{nope')).toThrow(DataParseError);
    expect(() => parseJsonRows('{"x":1}')).toThrow(/array of objects/i);
    expect(() => parseJsonRows('[1]')).toThrow(/row 1/i);
    expect(() => parseJsonRows('[{"__proto__":1}]')).toThrow(DataParseError);
  });
});

describe('coerceCell', () => {
  it('turns numeric strings into numbers, empty into null, and leaves the rest', () => {
    expect(coerceCell('42')).toBe(42);
    expect(coerceCell('-3.5')).toBe(-3.5);
    expect(coerceCell('0')).toBe(0);
    expect(coerceCell('')).toBeNull();
    expect(coerceCell('007')).toBe('007');
    expect(coerceCell('1e3')).toBe('1e3');
    expect(coerceCell('1.')).toBe('1.');
    expect(coerceCell('abc')).toBe('abc');
    expect(coerceCell(true)).toBe(true);
    expect(coerceCell(7)).toBe(7);
  });
});

const graph = () =>
  makeGraph(
    [
      makeNode('k8s:pod:default/web', { label: 'web', tags: { app: 'web' }, fields: { owner: 'abc', port: 80 } }),
      makeNode('k8s:pod:default/db', { label: 'db', tags: { app: 'db' } }),
      makeNode('k8s:pod:default/cache', { label: 'cache' })
    ],
    [makeEdge('k8s:pod:default/web', 'k8s:pod:default/db')],
    { title: 'prod', hostKey: 'ops@h:22' }
  );

describe('bindRows', () => {
  const rows = [
    { name: 'web', cost: '120.5', owner: 'team-a', note: '' },
    { name: 'db', cost: '300', owner: 'team-b', note: 'critical' },
    { name: 'ghost', cost: '1', owner: 'x', note: '' }
  ];

  it('joins on label, merges data.<column> with coercion, and reports the rest', () => {
    const g = graph();
    const result = bindRows(g, rows, { keyColumn: 'name', joinOn: 'label' });
    const web = result.graph.nodes.find((n) => n.label === 'web')!;
    expect(web.fields).toMatchObject({ owner: 'abc', port: 80, 'data.cost': 120.5, 'data.owner': 'team-a', 'data.note': null });
    expect(web.fields).not.toHaveProperty('data.name');
    expect(result.matchedRows).toBe(2);
    expect(result.matchedNodes).toBe(2);
    expect(result.unmatchedRows).toEqual(['ghost']);
    expect(result.unmatchedNodes).toEqual(['k8s:pod:default/cache']);
    expect(result.duplicateKeys).toEqual([]);
    expect(result.graph.title).toBe('prod + data');
    expect(result.graph.hostKey).toBe('ops@h:22');
    expect(result.graph.edges).toEqual(g.edges);
  });

  it('never mutates the input graph', () => {
    const g = graph();
    const snapshot = JSON.stringify(g);
    const result = bindRows(g, rows, { keyColumn: 'name', joinOn: 'label' });
    expect(JSON.stringify(g)).toBe(snapshot);
    expect(result.graph).not.toBe(g);
    expect(result.graph.nodes[0]).not.toBe(g.nodes[0]);
    expect(result.graph.nodes[2]!.fields).not.toBe(g.nodes[2]!.fields);
  });

  it('joins on id, tag:<key> and field:<key>', () => {
    const byId = bindRows(graph(), [{ k: 'k8s:pod:default/db', v: '1' }], { keyColumn: 'k', joinOn: 'id' });
    expect(byId.graph.nodes[1]!.fields['data.v']).toBe(1);
    const byTag = bindRows(graph(), [{ k: 'db', v: 'x' }], { keyColumn: 'k', joinOn: 'tag:app' });
    expect(byTag.matchedNodes).toBe(1);
    expect(byTag.graph.nodes[1]!.fields['data.v']).toBe('x');
    const byField = bindRows(graph(), [{ k: '80', v: 'http' }], { keyColumn: 'k', joinOn: 'field:port' });
    expect(byField.graph.nodes[0]!.fields['data.v']).toBe('http');
  });

  it('applies one row to every node sharing its key, counting the row once', () => {
    const g = makeGraph([makeNode('a', { label: 'same' }), makeNode('b', { label: 'same' })]);
    const result = bindRows(g, [{ name: 'same', v: '1' }], { keyColumn: 'name', joinOn: 'label' });
    expect(result.matchedRows).toBe(1);
    expect(result.matchedNodes).toBe(2);
  });

  it('keeps the first of duplicate keys and reports the key', () => {
    const result = bindRows(graph(), [{ name: 'web', v: 'first' }, { name: 'web', v: 'second' }], { keyColumn: 'name', joinOn: 'label' });
    expect(result.duplicateKeys).toEqual(['web']);
    expect(result.graph.nodes[0]!.fields['data.v']).toBe('first');
    expect(result.matchedRows).toBe(1);
  });

  it('treats a row with no key as unmatched and trims keys', () => {
    const result = bindRows(graph(), [{ name: '', v: '1' }, { name: ' web ', v: '2' }], { keyColumn: 'name', joinOn: 'label' });
    expect(result.unmatchedRows).toEqual(['(empty key)']);
    expect(result.matchedNodes).toBe(1);
  });

  it('does not double the title suffix when applied twice', () => {
    const once = bindRows(graph(), rows, { keyColumn: 'name', joinOn: 'label' }).graph;
    expect(bindRows(once, rows, { keyColumn: 'name', joinOn: 'label' }).graph.title).toBe('prod + data');
  });
});

describe('size cap', () => {
  it('rejects text over 16 MiB and accepts small text', () => {
    expect(MAX_DATA_BYTES).toBe(16 * 1024 * 1024);
    expect(() => assertWithinSizeCap('a,b\n1,2')).not.toThrow();
    expect(() => assertWithinSizeCap('x'.repeat(MAX_DATA_BYTES + 1))).toThrow(/16 MiB/);
    // 3-byte characters: under the cap by length, over it by bytes.
    expect(() => assertWithinSizeCap('€'.repeat(Math.floor(MAX_DATA_BYTES / 3) + 1))).toThrow(/16 MiB/);
  });
});
