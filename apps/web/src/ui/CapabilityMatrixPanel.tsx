import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { Badge, Button } from '@webssh/ui-kit';
import {
  CAPABILITY_MATRIX,
  capabilityCounts,
  type CapabilityEntry,
  type CapabilityStatus
} from './capability-matrix.js';

const STATUS_LABEL: Record<CapabilityStatus, string> = {
  verified: 'Tested in this repo',
  implemented: 'Implemented · real-server test pending',
  conditional: 'Needs a prerequisite',
  unsupported: 'Deliberately unsupported'
};

const STATUS_TONE: Record<CapabilityStatus, 'success' | 'warning' | 'neutral' | 'danger'> = {
  verified: 'success',
  implemented: 'neutral',
  conditional: 'warning',
  unsupported: 'danger'
};

const CATEGORIES = [
  'All',
  'Connection & identity',
  'Terminal',
  'Files & editor',
  'Discovery & install',
  'Operations',
  'Automation & delivery'
] as const;

/**
 * Replaces the old marketing "50 features" workbench. Every row is a code path
 * that exists in this repository, with the proof level stated plainly.
 */
export function CapabilityMatrixPanel(): JSX.Element {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('All');
  const [query, setQuery] = useState('');

  const counts = useMemo(() => capabilityCounts(), []);
  const entries = useMemo(
    () =>
      CAPABILITY_MATRIX.filter((entry) => {
        if (category !== 'All' && entry.category !== category) return false;
        const q = query.trim().toLowerCase();
        if (!q) return true;
        return (
          entry.name.toLowerCase().includes(q) ||
          entry.detail.toLowerCase().includes(q) ||
          entry.category.toLowerCase().includes(q)
        );
      }),
    [category, query]
  );

  return (
    <div className="webssh-panel-content" data-testid="screen-features">
      <div className="ws-mod-head">
        <div>
          <h1>Capability matrix</h1>
          <p className="ws-mod-muted">
            What works, what is tested, and what needs something from you. Rows marked
            “real-server test pending” have code but have not been exercised against a live
            disposable host in this build.
          </p>
        </div>
      </div>

      <div className="ws-mod-chips">
        {(['verified', 'implemented', 'conditional', 'unsupported'] as const).map((status) => (
          <Badge key={status} tone={STATUS_TONE[status]}>
            {STATUS_LABEL[status]}: {counts[status]}
          </Badge>
        ))}
      </div>

      <div className="ws-mod-filters">
        {CATEGORIES.map((cat) => (
          <Button
            key={cat}
            variant={category === cat ? 'primary' : 'ghost'}
            onClick={() => setCategory(cat)}
            testId={`capability-cat-${cat.toLowerCase().replace(/[^a-z]+/g, '-')}`}
          >
            {cat}
          </Button>
        ))}
        <input
          type="search"
          className="ui-input"
          placeholder="Search capabilities…"
          aria-label="Search capabilities"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          style={{ flex: 1, minWidth: '200px' }}
        />
      </div>

      <table className="ws-mod-table" data-testid="capability-table">
        <thead>
          <tr>
            <th>Capability</th>
            <th>Category</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry: CapabilityEntry) => (
            <tr key={entry.id} data-testid={`capability-${entry.id}`}>
              <td>{entry.name}</td>
              <td>{entry.category}</td>
              <td>
                <Badge tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Badge>
              </td>
              <td>
                {entry.detail}
                {entry.requires ? <div className="ws-mod-muted">Requires: {entry.requires}</div> : null}
              </td>
            </tr>
          ))}
          {entries.length === 0 ? (
            <tr>
              <td colSpan={4} className="ws-mod-muted">
                No capability matches that filter.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
