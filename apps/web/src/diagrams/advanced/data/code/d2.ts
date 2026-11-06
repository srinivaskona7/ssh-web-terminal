import type { DiagramGraph } from '../../../model.js';
import { type ExportOptions, isContainer, pathOf, prepare, safeColor, skippedNote } from './common.js';

const RESERVED = new Set([
  'label', 'shape', 'style', 'icon', 'near', 'link', 'tooltip', 'direction', 'width', 'height', 'constraint',
  'class', 'classes', 'vars', 'layers', 'scenarios', 'steps', 'top', 'left', 'grid', 'source', 'target'
]);

/** D2 single-quoted string: no escapes beyond a doubled quote. */
export function quoteD2(text: string): string {
  return `'${text.replace(/[\r\n]+/g, ' ').replace(/'/g, "''")}'`;
}

export function toD2(graph: Pick<DiagramGraph, 'nodes' | 'edges'>, options: ExportOptions = {}): string {
  const p = prepare(graph, RESERVED);
  const lines = [`direction: ${options.direction === 'TB' ? 'down' : 'right'}`];
  const emit = (id: string, depth: number) => {
    const node = p.byId.get(id)!;
    const pad = '  '.repeat(depth);
    const head = `${pad}${p.ids.get(id)}: ${quoteD2(node.label)}`;
    const color = safeColor(options.palette?.[node.status]);
    const container = isContainer(p, id);
    if (!container && !color) {
      lines.push(head);
      return;
    }
    lines.push(`${head} {`);
    if (color) lines.push(`${pad}  style.stroke: ${quoteD2(color)}`);
    if (container) for (const child of p.children.get(id)!) emit(child, depth + 1);
    lines.push(`${pad}}`);
  };
  for (const id of p.roots) emit(id, 0);
  for (const { from, to, label } of p.edges) {
    const suffix = label === undefined ? '' : `: ${quoteD2(label)}`;
    lines.push(`${pathOf(p, from).join('.')} -> ${pathOf(p, to).join('.')}${suffix}`);
  }
  for (const edge of p.skipped) lines.push(`# ${skippedNote(edge)}`);
  return `${lines.join('\n')}\n`;
}
