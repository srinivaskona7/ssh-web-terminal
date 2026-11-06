import type { DiagramGraph } from '../../../model.js';
import { type ExportOptions, isContainer, prepare, representativeLeaf, safeColor, skippedNote } from './common.js';

const RESERVED = new Set(['node', 'edge', 'graph', 'digraph', 'subgraph', 'strict']);

/** Text for a double-quoted DOT string. `&` is escaped so Graphviz does not read entities. */
export function quoteDot(text: string): string {
  const body = text.replace(/[\\"&\n\r]/g, (ch) => (ch === '\\' ? '\\\\' : ch === '"' ? '\\"' : ch === '&' ? '&amp;' : ch === '\n' ? '\\n' : ''));
  return `"${body}"`;
}

export function toDot(graph: Pick<DiagramGraph, 'nodes' | 'edges'>, options: ExportOptions = {}): string {
  const p = prepare(graph, RESERVED);
  const lines = ['digraph G {', `  rankdir=${options.direction === 'TB' ? 'TB' : 'LR'};`, '  compound=true;', '  node [shape=box];'];
  const emit = (id: string, depth: number) => {
    const node = p.byId.get(id)!;
    const pad = '  '.repeat(depth);
    const did = p.ids.get(id)!;
    const color = safeColor(options.palette?.[node.status]);
    if (!isContainer(p, id)) {
      const attrs = [`label=${quoteDot(node.label)}`, ...(color ? [`color=${quoteDot(color)}`] : [])];
      lines.push(`${pad}${did} [${attrs.join(', ')}];`);
      return;
    }
    lines.push(`${pad}subgraph cluster_${did} {`);
    lines.push(`${pad}  label=${quoteDot(node.label)};`);
    if (color) lines.push(`${pad}  color=${quoteDot(color)};`);
    for (const child of p.children.get(id)!) emit(child, depth + 1);
    lines.push(`${pad}}`);
  };
  for (const id of p.roots) emit(id, 1);
  for (const { from, to, label } of p.edges) {
    const attrs: string[] = [];
    if (label !== undefined) attrs.push(`label=${quoteDot(label)}`);
    if (isContainer(p, from)) attrs.push(`ltail=cluster_${p.ids.get(from)}`);
    if (isContainer(p, to)) attrs.push(`lhead=cluster_${p.ids.get(to)}`);
    const suffix = attrs.length > 0 ? ` [${attrs.join(', ')}]` : '';
    lines.push(`  ${p.ids.get(representativeLeaf(p, from))} -> ${p.ids.get(representativeLeaf(p, to))}${suffix};`);
  }
  for (const edge of p.skipped) lines.push(`  // ${skippedNote(edge)}`);
  lines.push('}');
  return `${lines.join('\n')}\n`;
}
