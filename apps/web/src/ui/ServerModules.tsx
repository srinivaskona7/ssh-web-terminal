/**
 * Workspace module screens: server overview, software catalog, containers,
 * Kubernetes, automations and durable job activity.
 *
 * Every panel reads real data through the shared `RemoteSession` contract. No
 * metrics are invented: when a probe fails the panel says so and explains what
 * must be installed or granted.
 */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Badge, Button, EmptyState, Icon } from '@webssh/ui-kit';
import {
  discoverServer,
  type ServerCapabilities,
  type ToolCapability
} from '../discovery/capabilities.js';
import {
  buildPlan,
  evaluateRecipe,
  redactValues,
  validateValues,
  withDefaults
} from '../recipes/engine.js';
import { listRecipes, searchRecipes } from '../recipes/catalog.js';
import type { Recipe, RecipeField, RecipeFieldValueMap, RecipePlan } from '../recipes/types.js';
import { jobStore } from '../jobs/job-store.js';
import {
  cancelAndConfirm,
  monitorJob,
  startCommandJob,
  startRecipeJob,
  verifyJob,
  type CommandJobStep
} from '../jobs/job-manager.js';
import type { JobSession } from '../jobs/remote-job-runner.js';
import { isActiveJobState, isTerminalJobState, isValidJobId, type JobRecord, type JobState } from '../jobs/types.js';
import { DockerClient, type ContainerSummary } from '../containers/docker-client.js';
import { KubernetesClient, type PodSummary } from '../kubernetes/kubectl-client.js';
import { PythonAutomation, type CronEntry, type PythonEnvironment } from '../automation/python-automation.js';
import { GitClient, type GitLogEntry, type GitStatus } from '../git/git-client.js';
import {
  buildDeploymentPlan,
  detectProject,
  type DeploymentPlan,
  type DetectedProject
} from '../projects/projects.js';
import {
  controlService,
  listProcesses,
  listServices,
  powerAction,
  sampleMetrics,
  serviceLogs,
  type RemoteProcess,
  type RemoteService,
  type ServerMetrics,
  type ServiceAction
} from '../control/server-control.js';
import type { WorkspaceRemoteSession } from '../session/adapters.js';

export interface ModuleContext {
  session: WorkspaceRemoteSession | null;
  capabilities: ServerCapabilities | null;
  onDiscover: () => Promise<ServerCapabilities | null>;
  discoveryBusy: boolean;
  discoveryError: string | null;
  onNavigate?: (screen: string) => void;
}

type Async<T> =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; value: T }
  | { state: 'error'; error: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Adapt the workspace session to the detached-job runner contract. */
function jobSessionFor(session: WorkspaceRemoteSession, executeAsRoot = false): JobSession {
  return {
    execCommand: (command, timeoutMs) => session.exec(command, { timeoutMs }),
    writeFile: session.writeFile ? (path, content) => session.writeFile!(path, content) : undefined,
    executeAsRoot,
    isAttached: () => session.isConnected()
  };
}

function useAsync<T>(load: (() => Promise<T>) | null, deps: unknown[]): Async<T> {
  const [result, setResult] = useState<Async<T>>({ state: load ? 'loading' : 'idle' });
  useEffect(() => {
    if (!load) {
      setResult({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setResult({ state: 'loading' });
    load()
      .then((value) => {
        if (!cancelled) setResult({ state: 'ready', value });
      })
      .catch((err) => {
        if (!cancelled) setResult({ state: 'error', error: errorText(err) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return result;
}

function RequiresSession({ what }: { what: string }): JSX.Element {
  return (
    <EmptyState
      title="Connect to a server first"
      description={`${what} become available once an SSH session is connected.`}
    />
  );
}

function Loading({ label }: { label: string }): JSX.Element {
  return <p className="ws-mod-muted">{label}…</p>;
}

function ErrorNote({ message }: { message: string }): JSX.Element {
  return (
    <p className="ws-mod-error" role="alert">
      {message}
    </p>
  );
}

function toneForTool(tool: ToolCapability): 'success' | 'warning' | 'neutral' | 'danger' {
  if (tool.state === 'installed') return 'success';
  if (tool.state === 'outdated') return 'warning';
  if (tool.state === 'unsupported') return 'neutral';
  return 'danger';
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function CapabilityGrid({ caps }: { caps: ServerCapabilities }): JSX.Element {
  const rows: Array<[string, string]> = [
    ['Host', caps.hostname || 'unknown'],
    ['Operating system', `${caps.os.distro} ${caps.os.version}`.trim() || caps.os.family],
    ['Kernel', caps.os.kernel || 'unknown'],
    ['Architecture', caps.os.arch || 'unknown'],
    ['CPU', `${caps.cpu.cores || '?'} cores${caps.cpu.model ? ` · ${caps.cpu.model}` : ''}`],
    [
      'Memory',
      caps.memory.totalMiB > 0
        ? `${caps.memory.totalMiB} MiB total · ${caps.memory.availableMiB} MiB available`
        : 'not reported'
    ],
    ['Swap', caps.memory.totalMiB > 0 ? `${caps.memory.swapMiB} MiB` : 'not reported'],
    ['User', `${caps.user.name} (uid ${caps.user.uid})`],
    ['Home', caps.user.home || 'unknown'],
    ['Shell', caps.user.shell || 'unknown'],
    [
      'Privilege',
      caps.privilege.isRoot
        ? 'root'
        : caps.privilege.sudoNopasswd
          ? 'sudo without password'
          : caps.privilege.sudoAvailable
            ? 'sudo requires a password (not stored)'
            : 'no sudo'
    ],
    ['Package manager', caps.packages.manager ?? 'none detected'],
    ['Init system', caps.init.manager ?? 'unknown'],
    ['Firewall', caps.firewall.tool ? `${caps.firewall.tool} · ${caps.firewall.active === null ? 'state unknown' : caps.firewall.active ? 'active' : 'inactive'}` : 'none detected'],
    ['Time sync', caps.time.synchronized === null ? 'unknown' : caps.time.synchronized ? 'synchronized' : 'not synchronized']
  ];
  return (
    <dl className="ws-mod-grid">
      {rows.map(([label, value]) => (
        <div key={label} className="ws-mod-grid-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function OverviewPanel({ ctx }: { ctx: ModuleContext }): JSX.Element {
  const caps = ctx.capabilities;
  return (
    <section className="ws-mod" data-testid="screen-overview">
      <header className="ws-mod-head">
        <div>
          <h2>Server Health</h2>
          <p className="ws-mod-muted">
            Read-only inspection. Discovery installs nothing, edits no configuration and reads no
            secret files.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => void ctx.onDiscover()}
          disabled={!ctx.session || ctx.discoveryBusy}
          testId="overview-rediscover"
        >
          {ctx.discoveryBusy ? 'Inspecting…' : caps ? 'Re-inspect' : 'Inspect server'}
        </Button>
      </header>

      {!ctx.session ? <RequiresSession what="Server details" /> : null}
      {ctx.session && ctx.discoveryError ? <ErrorNote message={ctx.discoveryError} /> : null}
      {ctx.session && !caps && !ctx.discoveryBusy && !ctx.discoveryError ? (
        <EmptyState
          title="No capability data yet"
          description="Run the read-only inspection to learn the OS, package manager, privileges and installed tools."
        />
      ) : null}
      {caps ? (
        <>
          <p className="ws-mod-muted">Inspected {Math.max(0, Math.floor((Date.now() - caps.collectedAt) / 1000))}s ago {ctx.session && !ctx.session.isConnected() ? '(stale — disconnected)' : ''}</p>
          {caps.warnings.length > 0 ? (
            <ul className="ws-mod-warnings">
              {caps.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <CapabilityGrid caps={caps} />

          <h3>Installed tools</h3>
          <div className="ws-mod-chips">
            {Object.values(caps.tools)
              .filter((tool) => tool.state === 'installed')
              .map((tool) => (
                <Badge key={tool.id} tone={toneForTool(tool)}>
                  {tool.name}
                  {tool.version ? ` ${tool.version}` : ''}
                </Badge>
              ))}
          </div>

          <h3>Disks</h3>
          <table className="ws-mod-table">
            <thead>
              <tr>
                <th>Mount</th>
                <th>Filesystem</th>
                <th>Total</th>
                <th>Used</th>
                <th>Available</th>
              </tr>
            </thead>
            <tbody>
              {caps.disks.map((disk) => (
                <tr key={`${disk.mount}-${disk.filesystem}`}>
                  <td>{disk.mount}</td>
                  <td>{disk.filesystem}</td>
                  <td>{disk.totalMiB} MiB</td>
                  <td>
                    {disk.usedMiB} MiB ({disk.usePercent}%)
                  </td>
                  <td>{disk.availableMiB} MiB</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Listening ports</h3>
          {caps.listeners.length === 0 ? (
            <p className="ws-mod-muted">No listening TCP ports reported (or `ss`/`netstat` unavailable).</p>
          ) : (
            <table className="ws-mod-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Port</th>
                  <th>Protocol</th>
                </tr>
              </thead>
              <tbody>
                {caps.listeners.map((listener) => (
                  <tr key={`${listener.address}:${listener.port}`}>
                    <td>{listener.address}</td>
                    <td>{listener.port}</td>
                    <td>{listener.protocol}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}

      <div className="ws-mod-actions" style={{ flexWrap: 'wrap' }}>
        <Button variant="default" onClick={() => ctx.onNavigate?.('containers')} testId="health-open-containers">Containers</Button>
        <Button variant="default" onClick={() => ctx.onNavigate?.('kubernetes')} testId="health-open-kubernetes">Kubernetes</Button>
        <Button variant="default" onClick={() => ctx.onNavigate?.('automations')} testId="health-open-automations">Automations</Button>
        <Button variant="default" onClick={() => ctx.onNavigate?.('deployments')} testId="health-open-deployments">Deployments</Button>
        <Button variant="default" onClick={() => ctx.onNavigate?.('tunnels')} testId="health-open-tunnels">Tunnels</Button>
      </div>
      {ctx.session ? <LiveControl session={ctx.session} /> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Live control centre                                                 */
/* ------------------------------------------------------------------ */

function formatUptime(seconds: number | null): string {
  if (seconds === null) return 'not reported';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function formatKiB(value: number): string {
  if (value < 1024) return `${value} KiB`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} GiB`;
}

function LiveControl({ session }: { session: WorkspaceRemoteSession }): JSX.Element {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [processes, setProcesses] = useState<RemoteProcess[]>([]);
  const [services, setServices] = useState<RemoteService[]>([]);
  const [filter, setFilter] = useState('');
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ name: string; action: ServiceAction } | null>(null);
  const [powerConfirm, setPowerConfirm] = useState<'reboot' | 'poweroff' | null>(null);
  const [powerTyped, setPowerTyped] = useState('');

  const loadMetrics = async (): Promise<void> => {
    try {
      const next = await sampleMetrics(session);
      if (mounted.current) {
        setMetrics(next);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    }
  };

  const loadProcesses = async (): Promise<void> => {
    try {
      const next = await listProcesses(session, 30);
      if (mounted.current) setProcesses(next);
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    }
  };

  const loadServices = async (): Promise<void> => {
    try {
      const next = await listServices(session);
      if (mounted.current) setServices(next);
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    }
  };

  const refreshAll = async (): Promise<void> => {
    setBusy(true);
    await Promise.all([loadMetrics(), loadProcesses(), loadServices()]);
    setBusy(false);
  };

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => {
      void loadMetrics();
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  const runServiceAction = async (name: string, action: ServiceAction): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await controlService(session, name, action, true);
      await loadServices();
      setPending(null);
    } catch (err) {
      setError(errorText(err));
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  const showLogs = async (name: string): Promise<void> => {
    try {
      setLogs({ name, text: await serviceLogs(session, name, 120) });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const filteredProcesses = processes.filter((proc) =>
    filter.trim() ? proc.command.toLowerCase().includes(filter.trim().toLowerCase()) : true
  );

  return (
    <div className="ws-mod-detail" data-testid="live-control">
      <header className="ws-mod-detail-head">
        <div>
          <h3>Live control</h3>
          <p className="ws-mod-muted">
            Sampled from <code>/proc</code>, <code>ps</code> and <code>systemctl</code>. Fields the
            server does not report stay blank; nothing here is estimated.
          </p>
        </div>
        <div className="ws-mod-actions">
          <label className="ws-mod-check">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto((e.target as HTMLInputElement).checked)}
            />
            Auto-refresh 5s
          </label>
          <Button variant="default" onClick={() => void refreshAll()} disabled={busy} testId="control-refresh">
            {busy ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {error ? <ErrorNote message={error} /> : null}

      {metrics ? (
        <>
          <dl className="ws-mod-grid ws-mod-grid--compact">
            <div className="ws-mod-grid-row">
              <dt>CPU busy</dt>
              <dd>{metrics.cpuPercent === null ? 'not reported' : `${metrics.cpuPercent}%`}</dd>
            </div>
            <div className="ws-mod-grid-row">
              <dt>Load average</dt>
              <dd>{metrics.loadAverage ? metrics.loadAverage.join(' / ') : 'not reported'}</dd>
            </div>
            <div className="ws-mod-grid-row">
              <dt>Memory</dt>
              <dd>
                {metrics.memory
                  ? `${metrics.memory.usedMiB} / ${metrics.memory.totalMiB} MiB used`
                  : 'not reported'}
              </dd>
            </div>
            <div className="ws-mod-grid-row">
              <dt>Network</dt>
              <dd>
                {metrics.network
                  ? `↓ ${formatKiB(metrics.network.rxKiBps)}/s · ↑ ${formatKiB(metrics.network.txKiBps)}/s`
                  : 'not reported'}
              </dd>
            </div>
            <div className="ws-mod-grid-row">
              <dt>Uptime</dt>
              <dd>{formatUptime(metrics.uptimeSeconds)}</dd>
            </div>
            <div className="ws-mod-grid-row">
              <dt>Reboot required</dt>
              <dd>
                {metrics.rebootRequired === null
                  ? 'not reported'
                  : metrics.rebootRequired
                    ? 'yes — kernel or libraries updated'
                    : 'no'}
              </dd>
            </div>
          </dl>

          <h3>Disks</h3>
          <table className="ws-mod-table">
            <thead>
              <tr>
                <th>Mount</th>
                <th>Used</th>
                <th>Available</th>
                <th>Usage</th>
              </tr>
            </thead>
            <tbody>
              {metrics.disks.map((disk) => (
                <tr key={disk.mount}>
                  <td>{disk.mount}</td>
                  <td>{formatKiB(disk.usedKiB)}</td>
                  <td>{formatKiB(disk.availableKiB)}</td>
                  <td>{disk.usedPercent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      <h3>Processes</h3>
      <input
        className="ui-input"
        type="search"
        placeholder="Filter by command"
        aria-label="Filter processes"
        value={filter}
        onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
      />
      <table className="ws-mod-table">
        <thead>
          <tr>
            <th>PID</th>
            <th>User</th>
            <th>CPU</th>
            <th>MEM</th>
            <th>Elapsed</th>
            <th>Command</th>
          </tr>
        </thead>
        <tbody>
          {filteredProcesses.slice(0, 20).map((proc) => (
            <tr key={proc.pid}>
              <td>{proc.pid}</td>
              <td>{proc.user}</td>
              <td>{proc.cpuPercent}%</td>
              <td>{proc.memoryPercent}%</td>
              <td>{proc.elapsed}</td>
              <td>{proc.command}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Services</h3>
      <p className="ws-mod-muted">
        Actions use <code>sudo -n</code>. Without passwordless sudo they fail immediately and report
        the privilege requirement instead of waiting for a password the browser cannot supply.
      </p>
      <table className="ws-mod-table">
        <thead>
          <tr>
            <th>Unit</th>
            <th>State</th>
            <th>Description</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {services.slice(0, 40).map((service) => (
            <tr key={service.name}>
              <td>{service.name}</td>
              <td>
                <Badge tone={service.active === 'active' ? 'success' : service.active === 'failed' ? 'danger' : 'neutral'}>
                  {service.active}/{service.sub}
                </Badge>
              </td>
              <td>{service.description}</td>
              <td className="ws-mod-row-actions">
                <Button variant="ghost" onClick={() => void showLogs(service.name)}>
                  Logs
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setPending({ name: service.name, action: 'restart' })}
                >
                  Restart
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setPending({ name: service.name, action: 'stop' })}
                >
                  Stop
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {pending ? (
        <div className="ws-mod-plan" role="alertdialog" aria-label="Confirm service action">
          <strong>
            {pending.action === 'restart' ? 'Restart' : 'Stop'} {pending.name}?
          </strong>
          <p className="ws-mod-muted">
            {pending.action === 'restart'
              ? 'The service will be interrupted briefly; dependent connections may drop.'
              : 'The service stays stopped until something starts it again.'}
          </p>
          <div className="ws-mod-actions">
            <Button
              variant="primary"
              onClick={() => void runServiceAction(pending.name, pending.action)}
              testId="control-confirm-service"
            >
              Confirm {pending.action}
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {logs ? (
        <div className="ws-mod-detail">
          <header className="ws-mod-detail-head">
            <strong>journalctl · {logs.name}</strong>
            <Button variant="ghost" onClick={() => setLogs(null)}>
              Close
            </Button>
          </header>
          <pre className="ws-mod-log" aria-label={`Logs for ${logs.name}`}>
            {logs.text || 'No log lines were returned.'}
          </pre>
        </div>
      ) : null}

      <h3>Power</h3>
      <p className="ws-mod-muted">
        These actions disconnect every session on the host. They are never triggered automatically.
      </p>
      <div className="ws-mod-actions">
        <Button variant="danger" onClick={() => { setPowerConfirm('reboot'); setPowerTyped(''); }}>
          Reboot server
        </Button>
        <Button variant="danger" onClick={() => { setPowerConfirm('poweroff'); setPowerTyped(''); }}>
          Power off server
        </Button>
      </div>
      {powerConfirm ? (
        <div className="ws-mod-plan" role="alertdialog" aria-label="Confirm power action">
          <strong>
            Type the hostname ({session.host}) to confirm {powerConfirm === 'reboot' ? 'reboot' : 'power off'}
          </strong>
          <input
            className="ui-input"
            aria-label="Confirm hostname"
            value={powerTyped}
            onInput={(e) => setPowerTyped((e.target as HTMLInputElement).value)}
          />
          <div className="ws-mod-actions">
            <Button
              variant="danger"
              disabled={powerTyped.trim() !== session.host}
              onClick={() => {
                setBusy(true);
                powerAction(session, powerConfirm, true)
                  .then(() => setError(null))
                  .catch((err) => setError(errorText(err)))
                  .finally(() => {
                    setPowerConfirm(null);
                    setBusy(false);
                  });
              }}
            >
              Confirm {powerConfirm === 'reboot' ? 'reboot' : 'power off'}
            </Button>
            <Button variant="ghost" onClick={() => setPowerConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Software catalog                                                    */
/* ------------------------------------------------------------------ */

function fieldInputId(recipeId: string, fieldId: string): string {
  return `recipe-${recipeId}-${fieldId}`;
}

function RecipeFieldControl({
  recipe,
  field,
  value,
  onChange
}: {
  recipe: Recipe;
  field: RecipeField;
  value: string | number | boolean | string[] | undefined;
  onChange: (value: string | number | boolean | string[]) => void;
}): JSX.Element {
  const id = fieldInputId(recipe.id, field.id);
  if (field.type === 'boolean') {
    return (
      <label className="ws-mod-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange((event.target as HTMLInputElement).checked)}
        />
        {field.label}
      </label>
    );
  }
  if (field.type === 'enum') {
    return (
      <>
        <label htmlFor={id}>{field.label}</label>
        <select
          id={id}
          value={String(value ?? '')}
          onChange={(event) => onChange((event.target as HTMLSelectElement).value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </>
    );
  }
  if (field.type === 'multiline' || field.type === 'list' || field.type === 'keyvalue') {
    return (
      <>
        <label htmlFor={id}>{field.label}</label>
        <textarea
          id={id}
          rows={4}
          value={String(value ?? '')}
          placeholder={field.placeholder ?? ''}
          onChange={(event) => onChange((event.target as HTMLTextAreaElement).value)}
        />
      </>
    );
  }
  const inputType =
    field.type === 'number' || field.type === 'port'
      ? 'number'
      : field.type === 'secret'
        ? 'password'
        : 'text';
  return (
    <>
      <label htmlFor={id}>{field.label}</label>
      <input
        id={id}
        type={inputType}
        value={String(value ?? '')}
        placeholder={field.placeholder ?? ''}
        min={field.min}
        max={field.max}
        autocomplete={field.sensitive ? 'new-password' : 'off'}
        onChange={(event) => onChange((event.target as HTMLInputElement).value)}
      />
    </>
  );
}

function RecipeDetail({
  recipe,
  caps,
  session,
  onJob
}: {
  recipe: Recipe;
  caps: ServerCapabilities;
  session: WorkspaceRemoteSession;
  onJob: (job: JobRecord) => void;
}): JSX.Element {
  const [values, setValues] = useState<RecipeFieldValueMap>(() => withDefaults(recipe));
  const [plan, setPlan] = useState<RecipePlan | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastJob, setLastJob] = useState<JobRecord | null>(null);

  useEffect(() => {
    setValues(withDefaults(recipe));
    setPlan(null);
    setMessage(null);
    setError(null);
    // The previous job belongs to the previous recipe; verifying it with this
    // recipe's steps would record the wrong outcome.
    setLastJob(null);
  }, [recipe.id]);

  const evaluation = evaluateRecipe(recipe, caps);
  const errors = validateValues(recipe, values);
  const basicFields = recipe.fields.filter((f) => !f.advanced);
  const advancedFields = recipe.fields.filter((f) => f.advanced);

  const preview = () => {
    try {
      setError(null);
      setMessage(null);
      setPlan(buildPlan(recipe, values, caps));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const install = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const job = await startRecipeJob({
        recipe,
        plan,
        variables: redactValues(recipe, values),
        server: {
          host: session.host,
          user: session.user,
          port: session.port,
          transport: session.transport
        },
        session: {
          execCommand: (command, timeoutMs) => session.exec(command, { timeoutMs }),
          executeAsRoot: recipe.privileges === 'sudo',
          isAttached: () => session.isConnected()
        }
      });
      onJob(job);
      setLastJob(job);
      setMessage(
        job.state === 'failed'
          ? `Job could not start: ${job.error ?? 'unknown error'}`
          : `Job ${job.id} started. Track it under Activity.`
      );
      void monitorJob(job, jobSessionFor(session, recipe.privileges === 'sudo'), {
        onUpdate: (updated) => {
          onJob(updated);
          setLastJob(updated);
        }
      }).catch(() => undefined);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Verification runs the recipe's `verify` steps as the logged-in user and
   * records the outcome on the job. It is a separate, explicit action so a
   * passing install never implies a passing check.
   */
  const runVerification = async () => {
    if (!lastJob) return;
    if (!session.execStream) {
      setError('This transport cannot stream exec output, so verification steps cannot run.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const verified = await verifyJob(lastJob, recipe, {
        capabilities: caps,
        execStream: (command, options) => session.execStream!(command, options),
        ...(session.writeFile ? { writeFile: session.writeFile } : {})
      });
      setLastJob(verified);
      onJob(verified);
      setMessage(
        verified.verification?.ok
          ? `Verification passed: ${verified.verification.detail ?? ''}`.trim()
          : `Verification failed: ${verified.verification?.detail ?? 'no detail'}`
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ws-mod-detail">
      <header className="ws-mod-detail-head">
        <div>
          <h3>{recipe.name}</h3>
          <p className="ws-mod-muted">{recipe.description}</p>
        </div>
        <Badge tone={evaluation.state === 'available' ? 'success' : evaluation.state === 'installed' ? 'neutral' : 'warning'}>
          {evaluation.state.replaceAll('_', ' ')}
        </Badge>
      </header>

      {evaluation.reason ? <p className="ws-mod-muted">{evaluation.reason}</p> : null}

      <dl className="ws-mod-grid ws-mod-grid--compact">
        <div className="ws-mod-grid-row">
          <dt>Recipe version</dt>
          <dd>{recipe.version}</dd>
        </div>
        <div className="ws-mod-grid-row">
          <dt>Installs</dt>
          <dd>{recipe.versionInstalled}</dd>
        </div>
        <div className="ws-mod-grid-row">
          <dt>Privileges</dt>
          <dd>{recipe.privileges === 'sudo' ? 'sudo required' : 'current user'}</dd>
        </div>
        <div className="ws-mod-grid-row">
          <dt>Rollback</dt>
          <dd>{recipe.rollback}</dd>
        </div>
        <div className="ws-mod-grid-row">
          <dt>License</dt>
          <dd>{recipe.license}</dd>
        </div>
      </dl>

      {recipe.provides?.services?.length || recipe.provides?.ports?.length ? (
        <p className="ws-mod-muted">
          {recipe.provides?.services?.length
            ? `Services: ${recipe.provides.services.join(', ')}. `
            : ''}
          {recipe.provides?.ports?.length ? `Ports: ${recipe.provides.ports.join(', ')}.` : ''}
        </p>
      ) : null}

      <h4>Variables</h4>
      {basicFields.length === 0 && advancedFields.length === 0 ? (
        <p className="ws-mod-muted">This recipe needs no variables.</p>
      ) : null}
      <div className="ws-mod-form">
        {basicFields.map((field) => (
          <RecipeFieldControl
            key={field.id}
            recipe={recipe}
            field={field}
            value={values[field.id]}
            onChange={(value) => setValues((prev) => ({ ...prev, [field.id]: value }))}
          />
        ))}
        {advancedFields.length > 0 ? (
          <Button variant="ghost" onClick={() => setShowAdvanced((prev) => !prev)}>
            {showAdvanced ? 'Hide advanced variables' : `Advanced variables (${advancedFields.length})`}
          </Button>
        ) : null}
        {showAdvanced
          ? advancedFields.map((field) => (
              <RecipeFieldControl
                key={field.id}
                recipe={recipe}
                field={field}
                value={values[field.id]}
                onChange={(value) => setValues((prev) => ({ ...prev, [field.id]: value }))}
              />
            ))
          : null}
      </div>

      {errors.length > 0 ? (
        <ul className="ws-mod-error-list">
          {errors.map((err) => (
            <li key={err.field}>{err.message}</li>
          ))}
        </ul>
      ) : null}

      <div className="ws-mod-actions">
        <Button onClick={preview} disabled={busy} testId="recipe-preview">
          Preview plan
        </Button>
        <Button
          variant="primary"
          onClick={() => void install()}
          disabled={busy || !plan?.canExecute}
          testId="recipe-install"
        >
          {busy ? 'Starting…' : 'Install'}
        </Button>
        {lastJob && isTerminalJobState(lastJob.state) ? (
          <Button
            onClick={() => void runVerification()}
            disabled={busy || !lastJob || session.execStream === undefined}
            testId="recipe-verify"
          >
            Run verification
          </Button>
        ) : null}
      </div>

      {message ? <p className="ws-mod-success">{message}</p> : null}
      {error ? <ErrorNote message={error} /> : null}

      {plan ? (
        <div className="ws-mod-plan">
          <h4>Plan</h4>
          <ul className="ws-mod-issues">
            {plan.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className={`ws-mod-issue ws-mod-issue--${issue.level}`}>
                <Badge tone={issue.level === 'blocking' ? 'danger' : 'warning'}>{issue.level}</Badge>{' '}
                {issue.message}
              </li>
            ))}
            {plan.issues.length === 0 ? <li className="ws-mod-muted">No issues found.</li> : null}
          </ul>
          <table className="ws-mod-table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Command</th>
              </tr>
            </thead>
            <tbody>
              {plan.steps.map((step) => (
                <tr key={step.id}>
                  <td>{step.title}</td>
                  <td>
                    <code>
                      {step.kind === 'exec'
                        ? (step.resolvedArgv ?? step.argv).join(' ')
                        : `write ${step.path}`}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.steps.some((step) => step.kind === 'exec' && step.asRoot) ? (
            <p className="ws-mod-muted">
              Steps marked as root run through `sudo -n`. If sudo needs a password the plan is
              blocked rather than storing your password.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SoftwarePanel({ ctx }: { ctx: ModuleContext }): JSX.Element {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const recipes = useMemo(() => {
    const all = query.trim() ? searchRecipes(query) : listRecipes();
    return category === 'all' ? all : all.filter((r) => r.category === category);
  }, [query, category]);
  const selected = selectedId ? recipes.find((r) => r.id === selectedId) ?? null : null;
  const categories = useMemo(
    () => ['all', ...Array.from(new Set(listRecipes().map((r) => r.category)))],
    []
  );

  return (
    <section className="ws-mod" data-testid="screen-software">
      <header className="ws-mod-head">
        <div>
          <h2>Software</h2>
          <p className="ws-mod-muted">
            Versioned recipes with preflight checks, a plan preview and a durable job. Nothing is
            installed until you review the plan.
          </p>
        </div>
      </header>

      {!ctx.session ? <RequiresSession what="Installable software" /> : null}
      {ctx.session && !ctx.capabilities ? (
        <EmptyState
          title="Inspect the server first"
          description="Compatibility, existing versions, disk and privilege checks need discovery data."
          action={
            <Button variant="primary" onClick={() => void ctx.onDiscover()} disabled={ctx.discoveryBusy}>
              {ctx.discoveryBusy ? 'Inspecting…' : 'Inspect server'}
            </Button>
          }
        />
      ) : null}

      {ctx.session && ctx.capabilities ? (
        <div className="ws-mod-split">
          <div className="ws-mod-list">
            <div className="ws-mod-filters">
              <input
                type="search"
                placeholder="Search software"
                value={query}
                onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
                aria-label="Search software"
              />
              <select
                aria-label="Category"
                value={category}
                onChange={(event) => setCategory((event.target as HTMLSelectElement).value)}
              >
                {categories.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry === 'all' ? 'All categories' : entry}
                  </option>
                ))}
              </select>
            </div>
            <ul className="ws-mod-recipes">
              {recipes.map((recipe) => {
                const evaluation = evaluateRecipe(recipe, ctx.capabilities!);
                return (
                  <li key={recipe.id}>
                    <button
                      type="button"
                      className={`ws-mod-recipe ${selectedId === recipe.id ? 'ws-mod-recipe--active' : ''}`}
                      onClick={() => setSelectedId(recipe.id)}
                      data-testid={`recipe-${recipe.id}`}
                    >
                      <span className="ws-mod-recipe-name">
                        <Icon name="file" /> {recipe.name}
                      </span>
                      <span className="ws-mod-muted">
                        {evaluation.state === 'installed' ? 'Installed' : recipe.description}
                      </span>
                      <Badge
                        tone={
                          evaluation.state === 'available'
                            ? 'success'
                            : evaluation.state === 'installed'
                              ? 'neutral'
                              : 'warning'
                        }
                      >
                        {evaluation.state.replaceAll('_', ' ')}
                      </Badge>
                    </button>
                  </li>
                );
              })}
              {recipes.length === 0 ? <li className="ws-mod-muted">No recipes match.</li> : null}
            </ul>
          </div>

          <div className="ws-mod-content">
            {selected ? (
              <RecipeDetail
                recipe={selected}
                caps={ctx.capabilities}
                session={ctx.session}
                onJob={() => undefined}
              />
            ) : (
              <EmptyState title="Select software" description="Pick a recipe to review compatibility and variables." />
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Containers                                                          */
/* ------------------------------------------------------------------ */

const CONTAINER_STATES: Record<string, 'success' | 'warning' | 'neutral'> = {
  running: 'success',
  exited: 'neutral',
  paused: 'warning',
  created: 'warning'
};

export function ContainersPanel({ ctx }: { ctx: ModuleContext }): JSX.Element {
  const session = ctx.session;
  const [refreshToken, setRefreshToken] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const docker = useMemo(() => (session ? new DockerClient(session) : null), [session, session?.host]);
  const availability = useAsync(() => (docker ? docker.available() : Promise.reject(new Error('no session'))), [docker]);
  const containers = useAsync<ContainerSummary[]>(
    () =>
      availability.state === 'ready' && availability.value.ok && docker
        ? docker.listContainers(true)
        : Promise.resolve([]),
    [docker, availability.state, refreshToken]
  );
  const [logs, setLogs] = useState<{ id: string; text: string } | null>(null);

  const run = async (id: string, action: 'start' | 'stop' | 'restart' | 'logs') => {
    if (!docker) return;
    setActionError(null);
    try {
      if (action === 'logs') {
        const text = await docker.logs(id, 200);
        setLogs({ id, text });
        return;
      }
      await docker[action](id);
      setRefreshToken((n) => n + 1);
    } catch (err) {
      setActionError(errorText(err));
    }
  };

  if (!session) {
    return (
      <section className="ws-mod" data-testid="screen-containers">
        <RequiresSession what="Container controls" />
      </section>
    );
  }

  return (
    <section className="ws-mod" data-testid="screen-containers">
      <header className="ws-mod-head">
        <div>
          <h2>Containers</h2>
          <p className="ws-mod-muted">
            Uses the remote Docker CLI. The daemon socket is never exposed; every action runs through
            your SSH session and its permissions.
          </p>
        </div>
        <Button onClick={() => setRefreshToken((n) => n + 1)}>Refresh</Button>
      </header>

      {availability.state === 'loading' ? <Loading label="Checking Docker" /> : null}
      {availability.state === 'ready' && !availability.value.ok ? (
        <EmptyState
          title="Docker is not available"
          description={availability.value.detail}
          action={
            <Button variant="primary" onClick={() => void ctx.onDiscover()}>
              Check software catalog
            </Button>
          }
        />
      ) : null}
      {availability.state === 'error' ? <ErrorNote message={availability.error} /> : null}
      {actionError ? <ErrorNote message={actionError} /> : null}

      {availability.state === 'ready' && availability.value.ok ? (
        <>
          {containers.state === 'loading' ? <Loading label="Listing containers" /> : null}
          {containers.state === 'error' ? <ErrorNote message={containers.error} /> : null}
          {containers.state === 'ready' ? (
            containers.value.length === 0 ? (
              <EmptyState title="No containers" description="Docker is reachable but runs no containers." />
            ) : (
              <table className="ws-mod-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Image</th>
                    <th>State</th>
                    <th>Status</th>
                    <th>Ports</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {containers.value.map((container) => (
                    <tr key={container.id}>
                      <td>{container.name}</td>
                      <td>{container.image}</td>
                      <td>
                        <Badge tone={CONTAINER_STATES[container.state] ?? 'neutral'}>{container.state}</Badge>
                      </td>
                      <td>{container.status}</td>
                      <td>{container.ports}</td>
                      <td className="ws-mod-row-actions">
                        <Button variant="ghost" onClick={() => void run(container.id, 'start')}>
                          Start
                        </Button>
                        <Button variant="ghost" onClick={() => void run(container.id, 'stop')}>
                          Stop
                        </Button>
                        <Button variant="ghost" onClick={() => void run(container.id, 'restart')}>
                          Restart
                        </Button>
                        <Button variant="ghost" onClick={() => void run(container.id, 'logs')}>
                          Logs
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}
          {logs ? (
            <pre className="ws-mod-log" aria-label={`Logs for ${logs.id}`}>
              {logs.text || '(no log output)'}
            </pre>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Kubernetes                                                          */
/* ------------------------------------------------------------------ */

export function KubernetesPanel({ ctx }: { ctx: ModuleContext }): JSX.Element {
  const session = ctx.session;
  const [context, setContext] = useState('');
  const [namespace, setNamespace] = useState('default');
  const [logs, setLogs] = useState<{ pod: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = useMemo(
    () => (session ? new KubernetesClient(session, context.trim() || undefined, namespace.trim() || 'default') : null),
    [session, context, namespace]
  );
  const availability = useAsync(() => (client ? client.available() : Promise.reject(new Error('no session'))), [client]);
  const pods = useAsync<PodSummary[]>(
    () =>
      availability.state === 'ready' && availability.value.ok && client
        ? client.pods()
        : Promise.resolve([]),
    [client, availability.state]
  );

  if (!session) {
    return (
      <section className="ws-mod" data-testid="screen-kubernetes">
        <RequiresSession what="Cluster controls" />
      </section>
    );
  }

  const readLogs = async (pod: string) => {
    if (!client) return;
    setError(null);
    try {
      setLogs({ pod, text: await client.podLogs(pod, 200) });
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="ws-mod" data-testid="screen-kubernetes">
      <header className="ws-mod-head">
        <div>
          <h2>Kubernetes</h2>
          <p className="ws-mod-muted">
            Uses the kubeconfig and context that already exist on the server. Permissions are the
            server user's own; the workspace never assumes cluster-admin and never reads Secret
            values.
          </p>
        </div>
      </header>

      <div className="ws-mod-filters">
        <label>
          Context
          <input
            value={context}
            placeholder="current context"
            onInput={(event) => setContext((event.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Namespace
          <input
            value={namespace}
            onInput={(event) => setNamespace((event.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      {availability.state === 'loading' ? <Loading label="Checking kubectl" /> : null}
      {availability.state === 'ready' && !availability.value.ok ? (
        <EmptyState
          title="Kubernetes is not usable from this server"
          description={availability.value.detail}
          action={
            <Button variant="primary" onClick={() => void ctx.onDiscover()}>
              Inspect server
            </Button>
          }
        />
      ) : null}
      {availability.state === 'error' ? <ErrorNote message={availability.error} /> : null}
      {error ? <ErrorNote message={error} /> : null}

      {availability.state === 'ready' && availability.value.ok ? (
        <>
          {pods.state === 'loading' ? <Loading label="Listing pods" /> : null}
          {pods.state === 'error' ? <ErrorNote message={pods.error} /> : null}
          {pods.state === 'ready' ? (
            pods.value.length === 0 ? (
              <EmptyState title="No pods" description="The namespace has no pods, or you lack permission to list them." />
            ) : (
              <table className="ws-mod-table">
                <thead>
                  <tr>
                    <th>Pod</th>
                    <th>Phase</th>
                    <th>Ready</th>
                    <th>Restarts</th>
                    <th>Node</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pods.value.map((pod) => (
                    <tr key={pod.name}>
                      <td>{pod.name}</td>
                      <td>{pod.phase}</td>
                      <td>{pod.ready}</td>
                      <td>{pod.restarts}</td>
                      <td>{pod.node ?? '—'}</td>
                      <td>
                        <Button variant="ghost" onClick={() => void readLogs(pod.name)}>
                          Logs
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}
          {logs ? (
            <pre className="ws-mod-log" aria-label={`Logs for ${logs.pod}`}>
              {logs.text || '(no log output)'}
            </pre>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Automations                                                         */
/* ------------------------------------------------------------------ */

export function AutomationsPanel({ ctx }: { ctx: ModuleContext }): JSX.Element {
  const session = ctx.session;
  const [environment, setEnvironment] = useState<PythonEnvironment | null>(null);
  const [entries, setEntries] = useState<CronEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session || !session.isConnected()) {
      setEnvironment(null);
      setEntries([]);
      return;
    }
    const automation = new PythonAutomation(session);
    let cancelled = false;
    setBusy(true);
    setError(null);
    Promise.all([automation.detect(), automation.readCrontab()])
      .then(([detected, crontab]) => {
        if (cancelled) return;
        setEnvironment(detected);
        setEntries(crontab);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!session) {
    return (
      <section className="ws-mod" data-testid="screen-automations">
        <RequiresSession what="Scheduled automation" />
      </section>
    );
  }

  return (
    <section className="ws-mod" data-testid="screen-automations">
      <header className="ws-mod-head">
        <div>
          <h2>Automations</h2>
          <p className="ws-mod-muted">
            Python environments and the server's own crontab. Only entries created by this workspace
            are managed; existing crontab lines are left untouched.
          </p>
        </div>
      </header>

      {busy ? <Loading label="Reading Python and crontab" /> : null}
      {error ? <ErrorNote message={error} /> : null}

      <h3>Python</h3>
      {environment ? (
        <p>
          <code>{environment.path}</code> reports {environment.version}
          {environment.venvAvailable ? ' · venv module available' : ' · venv module missing'}
          {environment.pipAvailable ? ' · pip available' : ' · pip missing'}
        </p>
      ) : session && !session.isConnected() ? (
        <p className="ws-mod-muted">Python check not reported — not connected to a server.</p>
      ) : (
        !busy && <p className="ws-mod-muted">Python 3 was not found on this server.</p>
      )}

      <h3>Scheduled entries</h3>
      {entries.length === 0 ? (
        <p className="ws-mod-muted">No workspace-managed crontab entries.</p>
      ) : (
        <table className="ws-mod-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Schedule</th>
              <th>Command</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.id}</td>
                <td>
                  <code>{entry.schedule}</code>
                </td>
                <td>
                  <code>{entry.command}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Activity                                                            */
/* ------------------------------------------------------------------ */

const JOB_TONES: Record<JobState, 'success' | 'warning' | 'danger' | 'neutral'> = {
  queued: 'neutral',
  running: 'warning',
  detached: 'warning',
  succeeded: 'success',
  failed: 'danger',
  cancel_requested: 'warning',
  cancelled: 'neutral',
  verification_failed: 'danger',
  lost: 'danger'
};

export function ActivityPanel({ ctx }: { ctx: ModuleContext }): JSX.Element {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = jobs.find((job) => job.id === selectedId) ?? null;

  const reload = () => {
    jobStore
      .list()
      .then((records) => setJobs(records))
      .catch((err) => setError(errorText(err)));
  };

  useEffect(reload, []);

  const update = (updated: JobRecord) => {
    setJobs((prev) => prev.map((job) => (job.id === updated.id ? updated : job)));
  };

  const reattach = async (job: JobRecord) => {
    if (!ctx.session) return;
    setError(null);
    try {
      const final = await monitorJob(job, jobSessionFor(ctx.session), {
        onUpdate: update,
        timeoutMs: 300_000
      });
      update(final);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const cancel = async (job: JobRecord) => {
    if (!ctx.session) return;
    setError(null);
    try {
      update(await cancelAndConfirm(job, jobSessionFor(ctx.session)));
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="ws-mod" data-testid="screen-activity">
      <header className="ws-mod-head">
        <div>
          <h2>Activity</h2>
          <p className="ws-mod-muted">
            Durable job history. Closing the browser does not mark a running job as finished;
            reconnect and reattach to keep observing it.
          </p>
        </div>
        <Button onClick={reload}>Refresh</Button>
      </header>

      {error ? <ErrorNote message={error} /> : null}
      {jobs.length === 0 ? (
        <EmptyState title="No jobs yet" description="Installations, builds and deployments appear here." />
      ) : (
        <div className="ws-mod-split">
          <ul className="ws-mod-list">
            {jobs.map((job) => (
              <li key={job.id}>
                <button
                  type="button"
                  className={`ws-mod-recipe ${selectedId === job.id ? 'ws-mod-recipe--active' : ''}`}
                  onClick={() => setSelectedId(job.id)}
                >
                  <span className="ws-mod-recipe-name">{job.title}</span>
                  <span className="ws-mod-muted">{new Date(job.createdAt).toLocaleString()}</span>
                  <Badge tone={JOB_TONES[job.state]}>{job.state.replaceAll('_', ' ')}</Badge>
                </button>
              </li>
            ))}
          </ul>
          <div className="ws-mod-content">
            {selected ? (
              <div className="ws-mod-detail">
                <h3>{selected.title}</h3>
                <dl className="ws-mod-grid ws-mod-grid--compact">
                  <div className="ws-mod-grid-row">
                    <dt>Job id</dt>
                    <dd>
                      <code>{selected.id}</code>
                    </dd>
                  </div>
                  <div className="ws-mod-grid-row">
                    <dt>Server</dt>
                    <dd>
                      {selected.server.user}@{selected.server.host}:{selected.server.port}
                    </dd>
                  </div>
                  <div className="ws-mod-grid-row">
                    <dt>Recipe</dt>
                    <dd>
                      {selected.recipeId ?? '—'} {selected.recipeVersion ?? ''}
                    </dd>
                  </div>
                  <div className="ws-mod-grid-row">
                    <dt>State</dt>
                    <dd>
                      <Badge tone={JOB_TONES[selected.state]}>{selected.state.replaceAll('_', ' ')}</Badge>
                    </dd>
                  </div>
                </dl>
                {selected.error ? <ErrorNote message={selected.error} /> : null}
                <ol className="ws-mod-steps">
                  {selected.steps.map((step) => (
                    <li key={step.id}>
                      <Badge
                        tone={
                          step.status === 'succeeded'
                            ? 'success'
                            : step.status === 'failed'
                              ? 'danger'
                              : 'neutral'
                        }
                      >
                        {step.status}
                      </Badge>{' '}
                      {step.title}
                      {step.exitCode !== undefined ? ` (exit ${step.exitCode})` : ''}
                    </li>
                  ))}
                </ol>
                {isActiveJobState(selected.state) && ctx.session ? (
                  <div className="ws-mod-actions">
                    <Button variant="primary" onClick={() => void reattach(selected)}>
                      Reattach and follow
                    </Button>
                    <Button variant="danger" onClick={() => void cancel(selected)}>
                      Cancel job
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <EmptyState title="Select a job" description="Choose a job to see its steps and result." />
            )}
          </div>
        </div>
      )}
    </section>
  );
}


/* ------------------------------------------------------------------ */
/* Deployments: Git review, project detection, reviewed deploy plan    */
/* ------------------------------------------------------------------ */

export function DeploymentsPanel({ ctx }: { ctx: ModuleContext }): JSX.Element {
  const session = ctx.session;
  const [directory, setDirectory] = useState('~/app');
  const [project, setProject] = useState<DetectedProject | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<{ current: string; branches: string[] } | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [diff, setDiff] = useState<string>('');
  const [commitMessage, setCommitMessage] = useState('');
  const [installDependencies, setInstallDependencies] = useState(true);
  const [buildCommand, setBuildCommand] = useState('');
  const [startCommand, setStartCommand] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [composeFile, setComposeFile] = useState('');
  const [healthUrl, setHealthUrl] = useState('');
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [jobLog, setJobLog] = useState('');
  const monitorAbort = useRef<AbortController | null>(null);
  const logSeq = useRef(0);

  if (!session) return <RequiresSession what="Deployments and Git" />;

  const gitClient = () => new GitClient(session, directory.trim());

  const refreshGit = async (dir = directory): Promise<void> => {
    const client = new GitClient(session, dir.trim());
    if (!(await client.isRepository())) {
      setGit(null);
      setBranches(null);
      setLog([]);
      setDiff('');
      return;
    }
    const [status, branchInfo, history] = await Promise.all([
      client.status(),
      client.branches(),
      client.log(20)
    ]);
    setGit(status);
    setBranches(branchInfo);
    setLog(history);
  };

  const detect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    setPlan(null);
    try {
      const detected = await detectProject(session, directory.trim());
      setProject(detected);
      setBuildCommand(detected.buildCommand ?? '');
      setStartCommand(detected.startCommand ?? '');
      setComposeFile(detected.type === 'compose' ? 'compose.yaml' : '');
      await refreshGit(directory.trim());
      setMessage(`Detected ${detected.type} project in ${detected.directory}`);
    } catch (err) {
      setProject(null);
      setGit(null);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const runGitAction = async (
    label: string,
    action: (client: GitClient) => Promise<unknown>
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action(gitClient());
      await refreshGit();
      setMessage(label);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const preview = (): void => {
    if (!project) return;
    const next = buildDeploymentPlan(project, {
      installDependencies,
      buildCommand: buildCommand.trim() || undefined,
      startCommand: startCommand.trim() || undefined,
      serviceName: serviceName.trim() || undefined,
      composeFile: composeFile.trim() || undefined,
      healthUrl: healthUrl.trim() || undefined
    });
    setPlan(next);
    setMessage(null);
    setError(null);
  };

  const deploy = async (): Promise<void> => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setJobLog('');
    try {
      const steps: CommandJobStep[] = [
        {
          id: 'revision',
          title: 'Record source revision',
          command: plan.revisionCommand,
          allowFailure: true
        },
        ...plan.steps
          .filter((step) => step.id !== 'revision')
          .map((step) => ({
            id: step.id,
            title: step.title,
            command: step.command,
            allowFailure: step.allowFailure
          })),
        ...(plan.healthCheck
          ? [
              {
                id: 'health',
                title: `Health check ${plan.healthCheck.url}`,
                command: plan.healthCheck.command
              }
            ]
          : [])
      ];
      const started = await startCommandJob({
        kind: 'deploy',
        title: `Deploy ${plan.project.type} project in ${plan.project.directory}`,
        steps,
        server: {
          host: session.host,
          user: session.user,
          port: session.port,
          transport: session.transport
        },
        session: jobSessionFor(session, serviceName.trim().length > 0)
      });
      setJob(started);
      if (started.state === 'failed') {
        setError(started.error ?? 'The deployment job could not start');
        return;
      }
      setMessage(`Deployment job ${started.id} started`);
      const controller = new AbortController();
      monitorAbort.current = controller;
      const finished = await monitorJob(
        started,
        jobSessionFor(session, serviceName.trim().length > 0),
        {
          signal: controller.signal,
          onUpdate: (current) => {
            setJob(current);
            void refreshJobLog(current);
          }
        }
      ).finally(() => {
        monitorAbort.current = null;
      });
      setJob(finished);
      await refreshJobLog(finished);
      if (finished.state === 'detached') {
        setMessage(
          `Stopped following job ${finished.id}. It keeps running on the server; reattach from Activity.`
        );
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const refreshJobLog = async (current: JobRecord): Promise<void> => {
    if (!isValidJobId(current.id)) return;
    // Polls can overlap; only the newest read may update the view.
    const seq = ++logSeq.current;
    try {
      const result = await session.exec(
        `tail -n 200 "$HOME/.webssh/jobs/${current.id}/stdout.log" 2>/dev/null || true`
      );
      if (seq === logSeq.current) setJobLog(result.stdout);
    } catch {
      // Log tail is best-effort; the job state remains authoritative.
    }
  };

  return (
    <section className="ws-mod" data-testid="screen-deployments">
      <header className="ws-mod-head">
        <div>
          <h1>Deployments</h1>
          <p className="ws-mod-muted">
            Inspect a project, review Git changes, then run a reviewed build and deploy plan on
            the connected server. Deployment runs as a durable job in the background.
          </p>
        </div>
      </header>

      {busy ? <Loading label="Working" /> : null}
      {error ? <ErrorNote message={error} /> : null}
      {message ? <p className="ws-mod-success">{message}</p> : null}

      <div className="ws-mod-filters">
        <input
          className="ui-input"
          aria-label="Project directory"
          placeholder="~/app"
          value={directory}
          onInput={(e) => setDirectory((e.target as HTMLInputElement).value)}
          style={{ flex: 1, minWidth: '220px' }}
        />
        <Button variant="primary" onClick={() => void detect()} testId="deploy-detect">
          Detect project
        </Button>
      </div>

      {project ? (
        <div className="ws-mod-detail">
          <header className="ws-mod-detail-head">
            <strong>{project.type}</strong>
            <Badge tone={project.type === 'unknown' ? 'warning' : 'success'}>
              {project.manifests.length} manifest{project.manifests.length === 1 ? '' : 's'}
            </Badge>
          </header>
          <p className="ws-mod-muted">{project.directory}</p>
          {project.manifests.length > 0 ? (
            <div className="ws-mod-chips">
              {project.manifests.map((m) => (
                <Badge key={m} tone="neutral">
                  {m}
                </Badge>
              ))}
            </div>
          ) : null}
          {project.notes.length > 0 ? (
            <ul className="ws-mod-warnings">
              {project.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {git ? (
        <div className="ws-mod-detail">
          <header className="ws-mod-detail-head">
            <strong>Git · {git.branch}</strong>
            <Badge tone={git.clean ? 'success' : 'warning'}>
              {git.clean ? 'clean' : `${git.files.length} changed`}
            </Badge>
          </header>
          <p className="ws-mod-muted">
            {git.upstream ? `upstream ${git.upstream} · ` : ''}
            {git.ahead} ahead · {git.behind} behind
            {branches ? ` · branches: ${branches.branches.join(', ')}` : ''}
          </p>
          {git.files.length > 0 ? (
            <table className="ws-mod-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Path</th>
                </tr>
              </thead>
              <tbody>
                {git.files.map((file) => (
                  <tr key={file.path}>
                    <td>{file.code}</td>
                    <td>{file.path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <div className="ws-mod-actions">
            <Button
              variant="default"
              onClick={() => void runGitAction('Staged all changes', (c) => c.stage([]))}
              testId="git-stage-all"
            >
              Stage all
            </Button>
            <Button
              variant="default"
              onClick={() =>
                void runGitAction('Loaded diff', async (c) => setDiff(await c.diff())).then(() => undefined)
              }
              testId="git-diff"
            >
              Show diff
            </Button>
            <input
              className="ui-input"
              aria-label="Commit message"
              placeholder="Commit message"
              value={commitMessage}
              onInput={(e) => setCommitMessage((e.target as HTMLInputElement).value)}
            />
            <Button
              variant="primary"
              onClick={() =>
                void runGitAction('Commit created', (c) => c.commit(commitMessage.trim()))
              }
              testId="git-commit"
            >
              Commit
            </Button>
          </div>
          {diff ? (
            <pre className="ws-mod-log" aria-label="Git diff">
              {diff}
            </pre>
          ) : null}
          {log.length > 0 ? (
            <table className="ws-mod-table">
              <thead>
                <tr>
                  <th>Commit</th>
                  <th>Author</th>
                  <th>Date</th>
                  <th>Subject</th>
                </tr>
              </thead>
              <tbody>
                {log.map((entry) => (
                  <tr key={entry.hash}>
                    <td>{entry.shortHash}</td>
                    <td>{entry.author}</td>
                    <td>{entry.date}</td>
                    <td>{entry.subject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      <div className="ws-mod-detail">
        <header className="ws-mod-detail-head">
          <strong>Deployment options</strong>
        </header>
        <div className="ws-mod-form">
          <label className="ws-mod-check">
            <input
              type="checkbox"
              checked={installDependencies}
              onChange={(e) => setInstallDependencies((e.target as HTMLInputElement).checked)}
            />
            Install dependencies before building
          </label>
          <input
            className="ui-input"
            aria-label="Build command"
            placeholder="Build command (leave empty to skip)"
            value={buildCommand}
            onInput={(e) => setBuildCommand((e.target as HTMLInputElement).value)}
          />
          <input
            className="ui-input"
            aria-label="Start command"
            placeholder="Start command (optional)"
            value={startCommand}
            onInput={(e) => setStartCommand((e.target as HTMLInputElement).value)}
          />
          <input
            className="ui-input"
            aria-label="Systemd service name"
            placeholder="Restart systemd service (requires sudo -n)"
            value={serviceName}
            onInput={(e) => setServiceName((e.target as HTMLInputElement).value)}
          />
          <input
            className="ui-input"
            aria-label="Compose file"
            placeholder="Compose file (e.g. compose.yaml)"
            value={composeFile}
            onInput={(e) => setComposeFile((e.target as HTMLInputElement).value)}
          />
          <input
            className="ui-input"
            aria-label="Health check URL"
            placeholder="Health check URL (optional)"
            value={healthUrl}
            onInput={(e) => setHealthUrl((e.target as HTMLInputElement).value)}
          />
          <div className="ws-mod-actions">
            <Button variant="default" onClick={preview} testId="deploy-preview">
              Preview plan
            </Button>
            <Button
              variant="primary"
              onClick={() => void deploy()}
              disabled={!plan || busy}
              testId="deploy-run"
            >
              Run deployment
            </Button>
          </div>
        </div>
      </div>

      {plan ? (
        <div className="ws-mod-plan">
          <strong>Plan</strong>
          <p className="ws-mod-muted">
            Rollback: {plan.rollback === 'supported' ? 'supported' : plan.rollback === 'limited' ? 'limited — external state may not reverse' : 'not available'}
          </p>
          <table className="ws-mod-table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Command</th>
                <th>Impact</th>
              </tr>
            </thead>
            <tbody>
              {plan.steps.map((step) => (
                <tr key={step.id}>
                  <td>{step.title}</td>
                  <td>
                    <code>{step.command}</code>
                  </td>
                  <td>{step.impact}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.notes.length > 0 ? (
            <ul className="ws-mod-warnings">
              {plan.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {job ? (
        <div className="ws-mod-detail">
          <header className="ws-mod-detail-head">
            <strong>Job {job.id}</strong>
            <Badge
              tone={
                job.state === 'succeeded'
                  ? 'success'
                  : job.state === 'failed'
                    ? 'danger'
                    : job.state === 'detached'
                      ? 'warning'
                      : 'neutral'
              }
            >
              {job.state}
            </Badge>
          </header>
          {monitorAbort.current ? (
            <Button onClick={() => monitorAbort.current?.abort()} testId="deploy-stop-following">
              Stop following
            </Button>
          ) : null}
          <ul className="ws-mod-steps">
            {job.steps.map((step) => (
              <li key={step.id}>
                {step.status} · {step.title}
              </li>
            ))}
          </ul>
          {job.error ? <ErrorNote message={job.error} /> : null}
          {jobLog ? (
            <pre className="ws-mod-log" aria-label="Deployment log">
              {jobLog}
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Discovery helper used by App                                        */
/* ------------------------------------------------------------------ */

export async function runDiscovery(session: WorkspaceRemoteSession): Promise<ServerCapabilities> {
  return discoverServer({
    execCommand: (command, timeoutMs) => session.exec(command, { timeoutMs }),
    getSftpClient: async () => {
      if (!session.probeSftp || !(await session.probeSftp())) {
        throw new Error('SFTP subsystem unavailable');
      }
      return {};
    }
  });
}
