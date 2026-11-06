import type { DiagramGraph } from '../../../model.js';
import { type ExportOptions, isContainer, prepare, safeColor, skippedNote } from './common.js';

const RESERVED = new Set(['end', 'graph', 'subgraph', 'flowchart', 'style', 'class', 'classdef', 'click', 'default', 'linkstyle', 'direction', 'call', 'href']);

const ENTITIES: Record<string, string> = {
  '#': '#35;',
  '&': '#amp;',
  '"': '#quot;',
  '<': '#lt;',
  '>': '#gt;',
  ';': '#59;',
  '%': '#37;',
  '\n': '<br/>',
  '\r': ''
};

/** Quote-safe Mermaid label text: entity codes for the characters the parser treats specially. */
export function escapeMermaid(text: string): string {
  return text.replace(/[#&"<>;\n\r]|%(?=[%{])/g, (ch) => ENTITIES[ch] ?? ch);
}

export function toMermaid(graph: Pick<DiagramGraph, 'nodes' | 'edges'>, options: ExportOptions = {}): string {
  const p = prepare(graph, RESERVED);
  const lines = [`flowchart ${options.direction ?? 'LR'}`];
  const emit = (id: string, depth: number) => {
    const node = p.byId.get(id)!;
    const pad = '  '.repeat(depth);
    const mid = p.ids.get(id)!;
    const title = `${mid}["${escapeMermaid(node.label)}"]`;
    if (!isContainer(p, id)) {
      lines.push(`${pad}${title}`);
      return;
    }
    lines.push(`${pad}subgraph ${title}`);
    for (const child of p.children.get(id)!) emit(child, depth + 1);
    lines.push(`${pad}end`);
  };
  for (const id of p.roots) emit(id, 1);
  for (const { from, to, label } of p.edges) {
    const arrow = label === undefined ? '-->' : `-->|"${escapeMermaid(label)}"|`;
    lines.push(`  ${p.ids.get(from)} ${arrow} ${p.ids.get(to)}`);
  }
  for (const node of p.nodes) {
    const color = safeColor(options.palette?.[node.status]);
    if (color) lines.push(`  style ${p.ids.get(node.id)} stroke:${color},stroke-width:2px`);
  }
  for (const edge of p.skipped) lines.push(`  %% ${skippedNote(edge)}`);
  return `${lines.join('\n')}\n`;
}
