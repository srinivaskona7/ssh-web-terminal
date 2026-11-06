/**
 * What the workspace editor remembers between visits. LightIde writes these
 * keys; the Welcome dashboard only reads them, so they live in a module small
 * enough to import without loading the editor.
 */
export const IDE_STORE_KEY = 'webssh.ide.v1';

export interface IdeRecents {
  /** Folders the editor opened, oldest first (as the editor stores them). */
  projects: string[];
  /** Files the editor opened, newest first. */
  recentFiles: string[];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** Never throws: unreadable or malformed storage reads as "nothing remembered". */
export function readIdeRecents(storage: Pick<Storage, 'getItem'> | null = safeLocalStorage()): IdeRecents {
  if (!storage) return { projects: [], recentFiles: [] };
  try {
    const raw = storage.getItem(IDE_STORE_KEY);
    if (!raw) return { projects: [], recentFiles: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { projects: [], recentFiles: [] };
    const record = parsed as Record<string, unknown>;
    return { projects: stringList(record.projects), recentFiles: stringList(record.recentFiles) };
  } catch {
    return { projects: [], recentFiles: [] };
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
