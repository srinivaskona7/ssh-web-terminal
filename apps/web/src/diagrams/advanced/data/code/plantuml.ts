import type { DiagramGraph } from '../../../model.js';
import { type ExportOptions, isContainer, prepare, safeColor, skippedNote } from './common.js';

const RESERVED = new Set(['component', 'rectangle', 'node', 'folder', 'package', 'cloud', 'database', 'frame', 'actor', 'interface', 'as', 'end', 'left', 'right', 'top', 'bottom', 'skinparam', 'title']);

/** Double-quoted PlantUML text: `"` becomes `'`, newlines and backslashes are written as escapes. */
export function quotePlantUml(text: string): string {
  const body = text.replace(/[\\"\n\r]/g, (ch) => (ch === '\\' ? '\\\\' : ch === '"' ? "'" : ch === '\n' ? '\\n' : ''));
  return `"${body}"`;
}

export function toPlantUml(graph: Pick<DiagramGraph, 'nodes' | 'edges'>, options: ExportOptions = {}): string {
  const p = prepare(graph, RESERVED);
  const lines = ['@startuml'];
  if (options.direction !== 'TB') lines.push('left to right direction');
  const emit = (id: string, depth: number) => {
    const node = p.byId.get(id)!;
    const pad = '  '.repeat(depth);
    const color = safeColor(options.palette?.[node.status]);
    const tint = color ? ` #line:${color.replace('#', '')}` : '';
    const kind = isContainer(p, id) ? 'rectangle' : 'component';
    const head = `${pad}${kind} ${quotePlantUml(node.label)} as ${p.ids.get(id)}${tint}`;
    if (!isContainer(p, id)) {
      lines.push(head);
      return;
    }
    lines.push(`${head} {`);
    for (const child of p.children.get(id)!) emit(child, depth + 1);
    lines.push(`${pad}}`);
  };
  for (const id of p.roots) emit(id, 0);
  for (const { from, to, label } of p.edges) {
    const suffix = label === undefined ? '' : ` : ${label.replace(/[\r\n]+/g, ' ')}`;
    lines.push(`${p.ids.get(from)} --> ${p.ids.get(to)}${suffix}`);
  }
  for (const edge of p.skipped) lines.push(`' ${skippedNote(edge)}`);
  lines.push('@enduml');
  return `${lines.join('\n')}\n`;
}
