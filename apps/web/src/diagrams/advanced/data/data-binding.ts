/**
 * Join an uploaded table (CSV or JSON rows) onto the nodes of a graph. The
 * result is a new graph; the input is never changed. Columns land in
 * `node.fields` as `data.<column>` so they show in the inspector and can drive
 * conditional formatting.
 */
import type { DiagramGraph, DiagramNode, FieldValue } from '../../model.js';

export const MAX_DATA_BYTES = 16 * 1024 * 1024;

export type DataRow = Record<string, FieldValue>;

export interface DataTable {
  columns: string[];
  rows: DataRow[];
}

export class DataParseError extends Error {
  constructor(
    message: string,
    readonly line?: number
  ) {
    super(message);
    this.name = 'DataParseError';
  }
}

export function assertWithinSizeCap(text: string): void {
  const tooBig = () => new DataParseError('That data is larger than 16 MiB. Split it or remove columns you do not need.');
  if (text.length > MAX_DATA_BYTES) throw tooBig();
  if (text.length * 3 <= MAX_DATA_BYTES) return;
  if (new TextEncoder().encode(text).length > MAX_DATA_BYTES) throw tooBig();
}

function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  let best = ',';
  for (const d of [';', '\t']) if ((counts[d] ?? 0) > (counts[best] ?? 0)) best = d;
  return best;
}

interface RawRecord {
  fields: string[];
  line: number;
  blank: boolean;
}

function scanRecords(input: string, delimiter: string): RawRecord[] {
  const records: RawRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quotedField = false;
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;
  let atStart = true;

  const endField = () => {
    fields.push(field);
    field = '';
    quotedField = false;
  };
  const endRecord = () => {
    endField();
    const blank = fields.length === 1 && fields[0] === '' && !quotedField;
    records.push({ fields, line: recordLine, blank });
    fields = [];
    atStart = true;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (atStart) {
      recordLine = line;
      atStart = false;
    }
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      quotedField = true;
      quoteLine = line;
    } else if (ch === delimiter) endField();
    else if (ch === '\r' && input[i + 1] === '\n') continue;
    else if (ch === '\n' || ch === '\r') {
      endRecord();
      line += 1;
    } else field += ch;
  }
  if (inQuotes) throw new DataParseError(`A quoted field opened on line ${quoteLine} is never closed.`, quoteLine);
  if (!atStart) endRecord();
  return records;
}

function checkHeader(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((raw) => {
    const name = raw.trim();
    if (name === '') throw new DataParseError('The header row has an empty column name.', 1);
    if (name === '__proto__') throw new DataParseError('"__proto__" is not allowed as a column name.', 1);
    if (seen.has(name)) throw new DataParseError(`The header row has a duplicate column name: "${name}".`, 1);
    seen.add(name);
    return name;
  });
}

export function parseCsv(text: string): DataTable {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(input);
  const records = scanRecords(input, delimiter).filter((r) => !r.blank);
  const [header, ...body] = records;
  if (!header) throw new DataParseError('No data found: the file is empty.');
  const columns = checkHeader(header.fields);
  const rows: DataRow[] = body.map((record) => {
    if (record.fields.length !== columns.length) {
      throw new DataParseError(`Line ${record.line} has ${record.fields.length} fields but the header has ${columns.length}.`, record.line);
    }
    const row: DataRow = {};
    columns.forEach((column, i) => {
      row[column] = record.fields[i]!;
    });
    return row;
  });
  return { columns, rows };
}

function jsonCell(value: unknown): FieldValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value) ?? null;
}

export function parseJsonRows(text: string): DataTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new DataParseError(`That is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(list)) throw new DataParseError('Expected an array of objects, or an object with a "rows" array.');
  const columns: string[] = [];
  const known = new Set<string>();
  const rows = list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DataParseError(`Row ${index + 1} is not an object.`);
    }
    const row: DataRow = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key === '__proto__') throw new DataParseError('"__proto__" is not allowed as a column name.');
      row[key] = jsonCell(value);
      if (!known.has(key)) {
        known.add(key);
        columns.push(key);
      }
    }
    return row;
  });
  return { columns, rows };
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Numbers stay numbers, empty becomes null, everything else is kept as written. */
export function coerceCell(value: FieldValue): FieldValue {
  if (typeof value !== 'string') return value;
  if (value === '') return null;
  return NUMBER.test(value) ? Number(value) : value;
}

export type JoinOn = 'id' | 'label' | `tag:${string}` | `field:${string}`;

export interface BindOptions {
  keyColumn: string;
  joinOn: JoinOn;
}

export interface BindResult {
  graph: DiagramGraph;
  matchedRows: number;
  matchedNodes: number;
  /** Key of each row that matched no node. */
  unmatchedRows: string[];
  /** Id of each node that matched no row. */
  unmatchedNodes: string[];
  duplicateKeys: string[];
  columns: string[];
}

function nodeKey(node: DiagramNode, joinOn: JoinOn): string | undefined {
  if (joinOn === 'id') return node.id;
  if (joinOn === 'label') return node.label;
  if (joinOn.startsWith('tag:')) return node.tags[joinOn.slice(4)];
  const value = node.fields[joinOn.slice(6)];
  return value === undefined || value === null ? undefined : String(value);
}

export function bindRows(graph: DiagramGraph, rows: DataRow[], options: BindOptions): BindResult {
  const { keyColumn, joinOn } = options;
  const byKey = new Map<string, DataRow>();
  const duplicates: string[] = [];
  const unmatchedKeys: string[] = [];
  const columns: string[] = [];
  const knownColumns = new Set<string>();
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (column !== keyColumn && column !== '__proto__' && !knownColumns.has(column)) {
        knownColumns.add(column);
        columns.push(column);
      }
    }
    const raw = row[keyColumn];
    const key = raw === undefined || raw === null ? '' : String(raw).trim();
    if (key === '') {
      unmatchedKeys.push('(empty key)');
      continue;
    }
    if (byKey.has(key)) {
      if (!duplicates.includes(key)) duplicates.push(key);
      continue;
    }
    byKey.set(key, row);
  }

  const matched = new Set<string>();
  const unmatchedNodes: string[] = [];
  let matchedNodes = 0;
  const nodes = graph.nodes.map((node): DiagramNode => {
    const copy: DiagramNode = { ...node, tags: { ...node.tags }, fields: { ...node.fields }, evidence: { ...node.evidence } };
    const key = nodeKey(node, joinOn)?.trim();
    const row = key ? byKey.get(key) : undefined;
    if (!row || !key) {
      unmatchedNodes.push(node.id);
      return copy;
    }
    matched.add(key);
    matchedNodes += 1;
    for (const column of columns) {
      if (Object.prototype.hasOwnProperty.call(row, column)) copy.fields[`data.${column}`] = coerceCell(row[column]!);
    }
    return copy;
  });
  for (const key of byKey.keys()) if (!matched.has(key)) unmatchedKeys.push(key);

  const title = graph.title.endsWith(' + data') ? graph.title : `${graph.title} + data`;
  return {
    graph: { ...graph, title, nodes, edges: graph.edges.map((e) => ({ ...e })), sources: graph.sources.map((s) => ({ ...s })) },
    matchedRows: matched.size,
    matchedNodes,
    unmatchedRows: unmatchedKeys,
    unmatchedNodes,
    duplicateKeys: duplicates,
    columns
  };
}
