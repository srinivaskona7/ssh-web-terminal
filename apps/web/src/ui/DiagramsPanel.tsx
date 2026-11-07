import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Badge, Button, EmptyState } from '@webssh/ui-kit';
import type { ModuleContext } from './ServerModules';

interface ProbeReport { source: string; ok: boolean; detail: string; count: number }

const PROBES: { id: string; cmd: string; parser: (out: string) => number }[] = [
  { id: 'host', cmd: 'hostname && uname -srm', parser: (o) => o.trim() ? 1 : 0 },
  { id: 'kubernetes', cmd: 'kubectl get nodes --no-headers 2>&1 | head -50', parser: (o) => o.trim().split('\n').filter(Boolean).length },
  { id: 'docker', cmd: 'docker ps --format "{{.Names}}" 2>&1 | head -50', parser: (o) => o.trim().split('\n').filter(Boolean).length },
  { id: 'systemd', cmd: 'systemctl list-units --type=service --no-legend 2>&1 | head -50', parser: (o) => o.trim().split('\n').filter(Boolean).length },
  { id: 'sockets', cmd: 'ss -tlnp 2>&1 | head -50', parser: (o) => o.trim().split('\n').filter(Boolean).length },
];

export function DiagramsPanel({ ctx }: { ctx: ModuleContext }): JSX.Element {
  const [reports, setReports] = useState<ProbeReport[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = async () => {
    if (!ctx.session?.isConnected()) { setError('Disconnected — reconnect before scanning.'); return; }
    setBusy(true); setError(null);
    const out: ProbeReport[] = [];
    for (const p of PROBES) {
      try {
        const r = await ctx.session!.exec(p.cmd, { timeoutMs: 15000 });
        const count = r.exitCode === 0 ? p.parser(r.stdout) : 0;
        out.push({ source: p.id, ok: r.exitCode === 0, detail: (r.stdout || r.stderr).trim().slice(0, 2000), count });
      } catch (e) { out.push({ source: p.id, ok: false, detail: e instanceof Error ? e.message : String(e), count: 0 }); }
    }
    setReports(out); setBusy(false);
  };

  if (!ctx.session?.isConnected()) return <EmptyState title="Diagrams" description="Connect to a host to scan topology. Nothing is faked — disconnected means no scan." />;

  return (
    <div data-testid="screen-diagrams" className="ws-mod-panel">
      <h2>Diagrams</h2>
      <p>Live scan of what the host reports — Kubernetes, Docker, systemd, sockets, SSH path. Read-only probes; missing tools report as unavailable.</p>
      <Button variant="primary" onClick={() => void scan()} disabled={busy} testId="diagram-scan-btn">{busy ? 'Scanning…' : 'Scan host'}</Button>
      {error ? <p role="alert">{error}</p> : null}
      {reports ? (
        <>
          <svg data-testid="diagram-canvas" width="640" height="200" role="img" aria-label="Topology canvas" style={{ border: '1px solid var(--color-border-subtle)' }}>
            <circle cx="80" cy="100" r="40" fill="var(--color-bg-elevated)" stroke="var(--color-accent-primary)" data-testid="diagram-node-host" />
            <text x="80" y="105" textAnchor="middle" fill="var(--color-fg-primary)" fontSize="12">host</text>
            {reports.filter((r) => r.source !== 'host').map((r, i) => {
              const x = 220 + i * 100; const y = r.ok ? 60 : 140;
              return (
                <g key={r.source}>
                  <line x1="120" y1="100" x2={x - 30} y2={y} stroke="var(--color-border-strong)" />
                  <circle cx={x} cy={y} r="28" fill="var(--color-bg-elevated)" stroke={r.ok ? 'var(--color-status-success)' : 'var(--color-status-danger)'} data-testid={`diagram-node-${r.source}`} />
                  <text x={x} y={y + 4} textAnchor="middle" fill="var(--color-fg-primary)" fontSize="10">{r.source.slice(0, 7)}</text>
                </g>
              );
            })}
          </svg>
          <ul data-testid="diagram-status">
            {reports.map((r) => (
              <li key={r.source} data-testid={`diagram-source-${r.source}`}>
                <Badge tone={r.ok ? 'success' : 'danger'}>{r.ok ? 'ok' : 'unavailable'}</Badge> <strong>{r.source}</strong> ({r.count} objects)
                <pre style={{ whiteSpace: 'pre-wrap' }}>{r.detail || 'not reported'}</pre>
              </li>
            ))}
          </ul>
        </>
      ) : <p>Not scanned yet.</p>}
    </div>
  );
}
