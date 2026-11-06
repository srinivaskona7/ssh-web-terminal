/**
 * Narrowing helpers for JSON printed by kubectl, docker and journalctl. A
 * missing or mistyped field reads as absent; nothing is filled in.
 */

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Json {
  return isRecord(value) ? value : {};
}

export function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** A non-empty string, or null. */
export function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** First lines of a command's complaint, for a one-line summary. */
export function firstLines(output: string, count = 3): string {
  return output
    .trim()
    .split('\n')
    .slice(0, count)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}
