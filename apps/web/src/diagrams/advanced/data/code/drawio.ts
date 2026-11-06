/**
 * diagrams.net / draw.io file, uncompressed. Layout is a plain grid per
 * container; draw.io users re-layout on open. Labels are plain text (no
 * `html=1`), so `<` and `&` in a label stay literal.
 */
import type { DiagramGraph } from '../../../model.js';
import { type ExportOptions, type Prepared, isContainer, prepare, safeColor } from './common.js';

const LEAF_W = 160;
const LEAF_H = 48;
const GAP = 24;
const PAD = 16;
const HEADER = 30;

function xmlAttr(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n|\r|\n/g, '&#xa;');
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function arrange(p: Prepared, ids: string[], sizes: Map<string, Box>, top: number, left: number): { w: number; h: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
  const rows = Math.ceil(ids.length / cols);
  const cellW = Math.max(LEAF_W, ...ids.map((id) => sizes.get(id)?.w ?? LEAF_W));
  const cellH = Math.max(LEAF_H, ...ids.map((id) => sizes.get(id)?.h ?? LEAF_H));
  ids.forEach((id, i) => {
    const box = sizes.get(id)!;
    box.x = left + (i % cols) * (cellW + GAP);
    box.y = top + Math.floor(i / cols) * (cellH + GAP);
  });
  return { w: cols * cellW + (cols - 1) * GAP, h: rows * cellH + (rows - 1) * GAP };
}

function measure(p: Prepared, id: string, sizes: Map<string, Box>): void {
  const kids = p.children.get(id);
  const box: Box = { x: 0, y: 0, w: LEAF_W, h: LEAF_H };
  sizes.set(id, box);
  if (!kids || kids.length === 0) return;
  for (const kid of kids) measure(p, kid, sizes);
  const area = arrange(p, kids, sizes, HEADER + PAD, PAD);
  box.w = area.w + PAD * 2;
  box.h = area.h + HEADER + PAD * 2;
}

export function toDrawio(graph: Pick<DiagramGraph, 'nodes' | 'edges'> & { title?: string }, options: ExportOptions = {}): string {
  // Cell ids 0 and 1 belong to the root cells, so keep node ids clear of them.
  const p = prepare(graph, new Set(['0', '1']));
  const sizes = new Map<string, Box>();
  for (const id of p.roots) measure(p, id, sizes);
  arrange(p, p.roots, sizes, 20, 20);

  const parentOf = new Map<string, string>();
  for (const [parent, kids] of p.children) for (const kid of kids) parentOf.set(kid, parent);

  const cells: string[] = [];
  const emitNode = (id: string) => {
    const node = p.byId.get(id)!;
    const box = sizes.get(id)!;
    const color = safeColor(options.palette?.[node.status]);
    const stroke = color ? `strokeColor=${color};strokeWidth=2;` : '';
    const style = isContainer(p, id) ? `swimlane;whiteSpace=wrap;startSize=${HEADER};${stroke}` : `rounded=1;whiteSpace=wrap;${stroke}`;
    const parent = parentOf.has(id) ? p.ids.get(parentOf.get(id)!)! : '1';
    cells.push(
      `<mxCell id="${xmlAttr(p.ids.get(id)!)}" value="${xmlAttr(node.label)}" style="${xmlAttr(style)}" vertex="1" parent="${xmlAttr(parent)}"><mxGeometry x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" as="geometry"/></mxCell>`
    );
    for (const kid of p.children.get(id) ?? []) emitNode(kid);
  };
  for (const id of p.roots) emitNode(id);
  p.edges.forEach(({ from, to, label }, i) => {
    cells.push(
      `<mxCell id="edge_${i + 1}" value="${xmlAttr(label ?? '')}" style="endArrow=classic;rounded=0;" edge="1" parent="1" source="${xmlAttr(p.ids.get(from)!)}" target="${xmlAttr(p.ids.get(to)!)}"><mxGeometry relative="1" as="geometry"/></mxCell>`
    );
  });
  const name = xmlAttr(graph.title ?? 'Diagram');
  return (
    `<mxfile host="webssh-studio"><diagram id="page-1" name="${name}"><mxGraphModel grid="1" gridSize="10" page="0"><root>` +
    `<mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>\n`
  );
}
