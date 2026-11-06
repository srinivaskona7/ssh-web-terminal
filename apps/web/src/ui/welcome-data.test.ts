import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../jobs/types';
import { IDE_STORE_KEY, readIdeRecents } from './ide-storage';
import { formatAgo, loadRecentJobs, summariseJob } from './welcome-data';

const store = (value: string | null): Pick<Storage, 'getItem'> => ({ getItem: (key) => (key === IDE_STORE_KEY ? value : null) });

describe('readIdeRecents', () => {
  it('reads projects and recent files', () => {
    expect(readIdeRecents(store(JSON.stringify({ projects: ['/a'], recentFiles: ['/a/x'] })))).toEqual({
      projects: ['/a'],
      recentFiles: ['/a/x']
    });
  });

  it('drops entries that are not non-empty strings', () => {
    const value = JSON.stringify({ projects: ['/a', 3, null, ''], recentFiles: 'nope' });
    expect(readIdeRecents(store(value))).toEqual({ projects: ['/a'], recentFiles: [] });
  });

  it('reads nothing from missing, malformed or non-object storage', () => {
    for (const value of [null, '', '{', '[]', '"text"', 'null', '42']) {
      expect(readIdeRecents(store(value))).toEqual({ projects: [], recentFiles: [] });
    }
    expect(readIdeRecents(null)).toEqual({ projects: [], recentFiles: [] });
  });

  it('reads nothing when storage throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      }
    };
    expect(readIdeRecents(throwing)).toEqual({ projects: [], recentFiles: [] });
  });
});

describe('formatAgo', () => {
  const now = 1_700_000_000_000;
  it.each([
    [0, 'just now'],
    [59_000, 'just now'],
    [60_000, '1 min ago'],
    [59 * 60_000, '59 min ago'],
    [60 * 60_000, '1 h ago'],
    [23 * 3_600_000, '23 h ago'],
    [24 * 3_600_000, '1 d ago'],
    [10 * 24 * 3_600_000, '10 d ago']
  ])('%d ms ago reads "%s"', (elapsed, expected) => {
    expect(formatAgo(now - elapsed, now)).toBe(expected);
  });

  it('reads a future or invalid time as just now', () => {
    expect(formatAgo(now + 5_000, now)).toBe('just now');
    expect(formatAgo(Number.NaN, now)).toBe('just now');
  });
});

describe('loadRecentJobs', () => {
  const record = (id: string, createdAt: number): JobRecord => ({
    id,
    kind: 'deploy',
    title: id,
    server: { host: 'h', port: 2222, user: 'u', transport: 'cloudflare-relay' },
    state: 'running',
    createdAt,
    updatedAt: createdAt,
    steps: [],
    variables: {},
    attached: false
  });

  it('keeps the store order, limits, and flattens the server', async () => {
    const jobs = await loadRecentJobs({ list: async () => [record('a', 3), record('b', 2), record('c', 1)] }, 2);
    expect(jobs.map((j) => j.id)).toEqual(['a', 'b']);
    expect(jobs[0]?.server).toBe('u@h:2222');
  });

  it('reads a failing store as no history', async () => {
    const jobs = await loadRecentJobs({
      list: async () => {
        throw new Error('IndexedDB blocked');
      }
    });
    expect(jobs).toEqual([]);
  });

  it('summarises without leaking steps or variables', () => {
    const summary = summariseJob({ ...record('x', 5), variables: { token: 'secret' } });
    expect(JSON.stringify(summary)).not.toContain('secret');
    expect(Object.keys(summary).sort()).toEqual(['createdAt', 'endedAt', 'id', 'kind', 'server', 'state', 'title']);
  });
});
