import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Badge, Button, EmptyState } from '@webssh/ui-kit';
import type { ModuleContext } from './ServerModules';
import { listeningPortsTool } from '../devops/tools/network/ports.js';
import { netConfigTool } from '../devops/tools/network/net-config.js';
import { reachabilityTool } from '../devops/tools/network/reachability.js';
import { tlsExpiryTool } from '../devops/tools/network/tls-expiry.js';
import { imageInventoryTool } from '../devops/tools/delivery/image-inventory.js';
import { dockerfileLintTool } from '../devops/tools/delivery/dockerfile-lint.js';
import { k8sPostureTool } from '../devops/tools/delivery/k8s-posture.js';
import { pendingUpdatesTool } from '../devops/tools/delivery/pending-updates.js';
import type { ToolResult } from '../devops/types.js';
import { listDiagnostics, diagnosticsSummary, clearDiagnostics } from '../transport/diagnostics.js';

const TOOLS = [listeningPortsTool, netConfigTool, reachabilityTool, tlsExpiryTool, imageInventoryTool, dockerfileLintTool, k8sPostureTool, pendingUpdatesTool];

export function DevOpsPanel({ ctx }: { ctx: ModuleContext }): JSX.Element {
  const [results, setResults] = useState<Record<string, ToolResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (toolId: string) => {
    const tool = TOOLS.find((t) => t.id === toolId)!;
    if (!ctx.session?.isConnected()) { setError('Disconnected — reconnect before running tools.'); return; }
    setBusy(toolId); setError(null);
    try {
      const r = await tool.run(ctx.session!, {});
      setResults((prev) => ({ ...prev, [toolId]: r }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };

  if (!ctx.session?.isConnected()) return <EmptyState title="DevOps" description="Connect to a host to run DevOps tools. No data is invented." />;

  return (
    <div data-testid="screen-devops" className="ws-mod-panel">
      <h2>DevOps</h2>
      <p>Read-only tools run via <code>WorkspaceRemoteSession.exec</code>. Missing probes render "not reported", never a guess.</p>
      {TOOLS.map((t) => (
        <div key={t.id} data-testid={`devops-tool-${t.id}`} style={{ border: '1px solid var(--color-border-subtle)', padding: 'var(--space-3)', margin: 'var(--space-2) 0' }}>
          <strong>{t.title}</strong> <span>{t.description}</span>
          <ul>{t.requires.map((r) => <li key={r}>requires {r}</li>)}</ul>
          <Button variant="primary" onClick={() => void run(t.id)} disabled={busy === t.id} testId={`devops-run-${t.id}`}>
            {busy === t.id ? 'Running…' : 'Run'}
          </Button>
          {results[t.id] ? (
            <div data-testid={`devops-result-${t.id}`}>
              <Badge tone={results[t.id]!.status === 'ok' ? 'success' : 'danger'}>{results[t.id]!.status}</Badge>
              <p>{results[t.id]!.summary}</p>
              <ul>{results[t.id]!.findings.map((f, i) => <li key={i}>[{f.severity}] {f.title}{f.detail ? ` — ${f.detail}` : ''}</li>)}</ul>
              {results[t.id]!.tables.map((tab, i) => (
                <table key={i} data-testid={`devops-table-${t.id}-${i}`}>
                  <thead><tr>{tab.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                  <tbody>{tab.rows.map((row, j) => <tr key={j}>{tab.columns.map((c) => <td key={c.key}>{row[c.key] === null ? 'not reported' : String(row[c.key])}</td>)}</tr>)}</tbody>
                </table>
              ))}
              {results[t.id]!.evidence.map((e, i) => <details key={i}><summary>{e.command} (exit {e.exitCode}, {e.durationMs}ms)</summary><pre>{(e.stdout + '\n' + e.stderr).slice(0, 4000)}</pre></details>)}
            </div>
          ) : null}
        </div>
      ))}
      {error ? <p role="alert">{error}</p> : null}
      <section data-testid="devops-diagnostics" aria-label="Connection diagnostics">
        <h3>Connection diagnostics (local only)</h3>
        <p>{diagnosticsSummary().total} event(s) — {Object.entries(diagnosticsSummary().byCode).map(([c, n]) => `${c}: ${n}`).join(', ') || 'no errors recorded'}</p>
        <ul>{listDiagnostics().slice(-20).map((e, i) => <li key={i}>{new Date(e.at).toLocaleTimeString()} {e.code} {e.message}</li>)}</ul>
        <Button variant="ghost" onClick={() => clearDiagnostics()} testId="devops-diagnostics-clear">Clear</Button>
      </section>
    </div>
  );
}
