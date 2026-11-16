/**
 * What the workspace editor remembers between visits. LightIde writes these
 * keys; the Welcome dashboard only reads them, so they live in a module small
 * enough to import without loading the editor.
 *
 * Storage is scoped per connected host (`user@host:port`) when a host key is
 * supplied, so two servers no longer share one recent-files list. An empty
 * host key falls back to the legacy global key for backward compatibility.
 */
export const IDE_STORE_KEY = 'webssh.ide.v1';

export function ideStoreKey(hostKey?: string): string {
  return hostKey && hostKey.trim().length > 0 ? `${IDE_STORE_KEY}:${hostKey.trim()}` : IDE_STORE_KEY;
}

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

function readFrom(storage: Pick<Storage, 'getItem'>, key: string): IdeRecents {
  try {
    const raw = storage.getItem(key);
    if (!raw) return { projects: [], recentFiles: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { projects: [], recentFiles: [] };
    const record = parsed as Record<string, unknown>;
    return { projects: stringList(record.projects), recentFiles: stringList(record.recentFiles) };
  } catch {
    return { projects: [], recentFiles: [] };
  }
}

/** Never throws: unreadable or malformed storage reads as "nothing remembered". */
export function readIdeRecents(
  hostKey?: string,
  storage: Pick<Storage, 'getItem'> | null = safeLocalStorage()
): IdeRecents {
  if (!storage) return { projects: [], recentFiles: [] };
  const scoped = readFrom(storage, ideStoreKey(hostKey));
  if (hostKey && scoped.projects.length === 0 && scoped.recentFiles.length === 0) {
    // Fall back to the legacy global key so upgrades keep their history.
    return readFrom(storage, IDE_STORE_KEY);
  }
  return scoped;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}