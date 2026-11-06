/**
 * Deterministic text and box metrics.
 *
 * jsdom has no `getBBox` or `getComputedTextLength`, and a layout that depends
 * on the browser's font cannot be tested or reproduced, so label widths are
 * estimated from per-character classes. The numbers are SVG geometry (user
 * units), not CSS lengths; the stylesheet draws the same sizes with tokens.
 */

/** Matches `--font-size-sm` (label) and `--font-size-xs` (sub-label). */
export const LABEL_FONT_SIZE = 12;
export const SUB_FONT_SIZE = 11;

export const NODE_HEIGHT = 44;
export const NODE_MIN_WIDTH = 108;
export const NODE_MAX_WIDTH = 248;
export const NODE_PAD_X = 10;
export const GLYPH_SIZE = 24;
export const GLYPH_GAP = 8;
export const HEADER_HEIGHT = 30;
export const BADGE_PAD = 6;

const NARROW = new Set('iIjltf.,:;|!\'`()[]{}/\\ -_'.split(''));
const WIDE = new Set('mwMW@%&'.split(''));

/** Estimated advance width of one character, in em. */
function charEm(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x2e80) return 1; // CJK, emoji and other full-width forms
  if (NARROW.has(ch)) return ch === ' ' ? 0.3 : 0.32;
  if (WIDE.has(ch)) return 0.88;
  if (code >= 48 && code <= 57) return 0.58;
  if (code >= 65 && code <= 90) return 0.68;
  return 0.56;
}

export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * fontSize;
}

/** Shorten `text` with an ellipsis so its estimated width fits `maxWidth`. */
export function fitText(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const ellipsis = '…';
  const chars = Array.from(text);
  let used = estimateTextWidth(ellipsis, fontSize);
  let out = '';
  for (const ch of chars) {
    const next = estimateTextWidth(ch, fontSize);
    if (used + next > maxWidth) break;
    used += next;
    out += ch;
  }
  return `${out}${ellipsis}`;
}

export interface BoxSize {
  width: number;
  height: number;
}

/** A leaf node: glyph, label, sub-label and an optional badge. */
export function measureLeaf(label: string, subLabel: string, badge?: string | null): BoxSize {
  const text = Math.max(estimateTextWidth(label, LABEL_FONT_SIZE), estimateTextWidth(subLabel, SUB_FONT_SIZE));
  const badgeWidth = badge ? estimateTextWidth(badge, SUB_FONT_SIZE) + BADGE_PAD * 2 : 0;
  const raw = NODE_PAD_X + GLYPH_SIZE + GLYPH_GAP + text + NODE_PAD_X + badgeWidth;
  return { width: Math.round(Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, raw))), height: NODE_HEIGHT };
}

/** The title strip of a container: glyph, title, kind and an optional badge. */
export function measureContainerTitle(label: string, subLabel: string, badge?: string | null): number {
  const text = estimateTextWidth(label, LABEL_FONT_SIZE) + 12 + estimateTextWidth(subLabel, SUB_FONT_SIZE);
  const badgeWidth = badge ? estimateTextWidth(badge, SUB_FONT_SIZE) + BADGE_PAD * 2 + 8 : 0;
  return Math.round(NODE_PAD_X + GLYPH_SIZE + GLYPH_GAP + text + NODE_PAD_X + badgeWidth);
}
