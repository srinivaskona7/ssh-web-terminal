/**
 * Small helpers shared by the source builders and the importers.
 *
 * Everything that reads kubectl, docker or Terraform JSON goes through the
 * defensive accessors here: the shapes come from tools we do not control, so a
 * missing or oddly typed field yields `null`, never an exception.
 */
import type { DiagramEdge, DiagramNode, EdgeKind } from '../model.js';

export type Rec = Record<string, unknown>;

export function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rec(value: unknown): Rec {
  return isRec(value) ? value : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A non-empty string, else null. */
export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Walk `path` through nested records; undefined as soon as one step is not a record. */
export function dig(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRec(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Only the string-valued entries of a record (labels, annotations). */
export function strMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRec(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/** Plain code-unit order. `localeCompare` would make scans differ between browsers. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => compareText(a.id, b.id));
}

export function edgeOf(kind: EdgeKind, from: string, to: string, label?: string): DiagramEdge {
  const edge: DiagramEdge = { id: `${kind}:${from}->${to}`, from, to, kind };
  if (label) edge.label = label;
  return edge;
}

/** Later duplicates are dropped; the first edge for an id keeps its label. */
export function dedupeEdges(edges: DiagramEdge[]): DiagramEdge[] {
  const seen = new Map<string, DiagramEdge>();
  for (const edge of edges) if (!seen.has(edge.id)) seen.set(edge.id, edge);
  return [...seen.values()];
}

/** Keep only edges whose two ends are nodes of the graph. */
export function dropDangling(nodes: readonly Pick<DiagramNode, 'id'>[], edges: DiagramEdge[]): { edges: DiagramEdge[]; dropped: number } {
  const ids = new Set(nodes.map((n) => n.id));
  const kept = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { edges: kept, dropped: edges.length - kept.length };
}

export function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Sorted, de-duplicated and comma-joined; null when there is nothing to show. */
export function joinSorted(values: readonly string[]): string | null {
  const unique = [...new Set(values.filter((v) => v.length > 0))].sort(compareText);
  return unique.length > 0 ? unique.join(',') : null;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `{a: 1, b: 2}` as `a=1,b=2`, sorted by key; null when empty. */
export function labelString(labels: Record<string, string>): string | null {
  const entries = Object.entries(labels).sort(([a], [b]) => compareText(a, b));
  return entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join(',') : null;
}
