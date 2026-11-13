// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../App';
import { statusDotClassFor } from './status-dot';

describe('statusDotClassFor', () => {
  it.each<[ConnectionState, string]>([
    ['connected', ''],
    ['resumed', ''],
    ['connecting', 'webssh-status-dot--reconnecting'],
    ['reconnecting', 'webssh-status-dot--reconnecting'],
    ['offline', 'webssh-status-dot--offline'],
    ['disconnected', 'webssh-status-dot--disconnected'],
    ['failed', 'webssh-status-dot--disconnected']
  ])('maps %s to "%s"', (state, expected) => {
    expect(statusDotClassFor(state)).toBe(expected);
  });

  // The rail host dot was a literal green class and stayed green after Disconnect.
  it('is not bypassed by a component that hardcodes the green dot', () => {
    const srcDir = fileURLToPath(new URL('../..', import.meta.url));
    const offenders = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.tsx'))
      .filter((file) => /className="[^"]*webssh-status-dot--connected/.test(readFileSync(join(srcDir, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
