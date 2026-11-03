import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "preact/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Badge, Button, EmptyState, Icon } from '@webssh/ui-kit';
import { discoverServer } from '../discovery/capabilities.js';
import { buildPlan, evaluateRecipe, redactValues, validateValues, withDefaults } from '../recipes/engine.js';
import { listRecipes, searchRecipes } from '../recipes/catalog.js';
import { jobStore } from '../jobs/job-store.js';
import { cancelAndConfirm, monitorJob, startCommandJob, startRecipeJob, verifyJob } from '../jobs/job-manager.js';
import { isActiveJobState, isValidJobId } from '../jobs/types.js';
import { DockerClient } from '../containers/docker-client.js';
import { KubernetesClient } from '../kubernetes/kubectl-client.js';
import { PythonAutomation } from '../automation/python-automation.js';
import { GitClient } from '../git/git-client.js';
import { buildDeploymentPlan, detectProject } from '../projects/projects.js';
import { controlService, listProcesses, listServices, powerAction, sampleMetrics, serviceLogs } from '../control/server-control.js';
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
/** Adapt the workspace session to the detached-job runner contract. */
function jobSessionFor(session, executeAsRoot = false) {
    return {
        execCommand: (command, timeoutMs) => session.exec(command, { timeoutMs }),
        executeAsRoot,
        isAttached: () => session.isConnected()
    };
}
function useAsync(load, deps) {
    const [result, setResult] = useState({ state: load ? 'loading' : 'idle' });
    useEffect(() => {
        if (!load) {
            setResult({ state: 'idle' });
            return;
        }
        let cancelled = false;
        setResult({ state: 'loading' });
        load()
            .then((value) => {
            if (!cancelled)
                setResult({ state: 'ready', value });
        })
            .catch((err) => {
            if (!cancelled)
                setResult({ state: 'error', error: errorText(err) });
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return result;
}
function RequiresSession({ what }) {
    return (_jsx(EmptyState, { title: "Connect to a server first", description: `${what} become available once an SSH session is connected.` }));
}
function Loading({ label }) {
    return _jsxs("p", { className: "ws-mod-muted", children: [label, "\u2026"] });
}
function ErrorNote({ message }) {
    return (_jsx("p", { className: "ws-mod-error", role: "alert", children: message }));
}
function toneForTool(tool) {
    if (tool.state === 'installed')
        return 'success';
    if (tool.state === 'outdated')
        return 'warning';
    if (tool.state === 'unsupported')
        return 'neutral';
    return 'danger';
}
/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */
function CapabilityGrid({ caps }) {
    const rows = [
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
    return (_jsx("dl", { className: "ws-mod-grid", children: rows.map(([label, value]) => (_jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: label }), _jsx("dd", { children: value })] }, label))) }));
}
export function OverviewPanel({ ctx }) {
    const caps = ctx.capabilities;
    return (_jsxs("section", { className: "ws-mod", "data-testid": "screen-overview", children: [_jsxs("header", { className: "ws-mod-head", children: [_jsxs("div", { children: [_jsx("h2", { children: "Server overview" }), _jsx("p", { className: "ws-mod-muted", children: "Read-only inspection. Discovery installs nothing, edits no configuration and reads no secret files." })] }), _jsx(Button, { variant: "primary", onClick: () => void ctx.onDiscover(), disabled: !ctx.session || ctx.discoveryBusy, testId: "overview-rediscover", children: ctx.discoveryBusy ? 'Inspecting…' : caps ? 'Re-inspect' : 'Inspect server' })] }), !ctx.session ? _jsx(RequiresSession, { what: "Server details" }) : null, ctx.session && ctx.discoveryError ? _jsx(ErrorNote, { message: ctx.discoveryError }) : null, ctx.session && !caps && !ctx.discoveryBusy && !ctx.discoveryError ? (_jsx(EmptyState, { title: "No capability data yet", description: "Run the read-only inspection to learn the OS, package manager, privileges and installed tools." })) : null, caps ? (_jsxs(_Fragment, { children: [caps.warnings.length > 0 ? (_jsx("ul", { className: "ws-mod-warnings", children: caps.warnings.map((warning) => (_jsx("li", { children: warning }, warning))) })) : null, _jsx(CapabilityGrid, { caps: caps }), _jsx("h3", { children: "Installed tools" }), _jsx("div", { className: "ws-mod-chips", children: Object.values(caps.tools)
                            .filter((tool) => tool.state === 'installed')
                            .map((tool) => (_jsxs(Badge, { tone: toneForTool(tool), children: [tool.name, tool.version ? ` ${tool.version}` : ''] }, tool.id))) }), _jsx("h3", { children: "Disks" }), _jsxs("table", { className: "ws-mod-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Mount" }), _jsx("th", { children: "Filesystem" }), _jsx("th", { children: "Total" }), _jsx("th", { children: "Used" }), _jsx("th", { children: "Available" })] }) }), _jsx("tbody", { children: caps.disks.map((disk) => (_jsxs("tr", { children: [_jsx("td", { children: disk.mount }), _jsx("td", { children: disk.filesystem }), _jsxs("td", { children: [disk.totalMiB, " MiB"] }), _jsxs("td", { children: [disk.usedMiB, " MiB (", disk.usePercent, "%)"] }), _jsxs("td", { children: [disk.availableMiB, " MiB"] })] }, `${disk.mount}-${disk.filesystem}`))) })] }), _jsx("h3", { children: "Listening ports" }), caps.listeners.length === 0 ? (_jsx("p", { className: "ws-mod-muted", children: "No listening TCP ports reported (or `ss`/`netstat` unavailable)." })) : (_jsxs("table", { className: "ws-mod-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Address" }), _jsx("th", { children: "Port" }), _jsx("th", { children: "Protocol" })] }) }), _jsx("tbody", { children: caps.listeners.map((listener) => (_jsxs("tr", { children: [_jsx("td", { children: listener.address }), _jsx("td", { children: listener.port }), _jsx("td", { children: listener.protocol })] }, `${listener.address}:${listener.port}`))) })] }))] })) : null, ctx.session ? _jsx(LiveControl, { session: ctx.session }) : null] }));
}
/* ------------------------------------------------------------------ */
/* Live control centre                                                 */
/* ------------------------------------------------------------------ */
function formatUptime(seconds) {
    if (seconds === null)
        return 'not reported';
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
}
function formatKiB(value) {
    if (value < 1024)
        return `${value} KiB`;
    if (value < 1024 * 1024)
        return `${(value / 1024).toFixed(1)} MiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} GiB`;
}
function LiveControl({ session }) {
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const [metrics, setMetrics] = useState(null);
    const [processes, setProcesses] = useState([]);
    const [services, setServices] = useState([]);
    const [filter, setFilter] = useState('');
    const [logs, setLogs] = useState(null);
    const [auto, setAuto] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [pending, setPending] = useState(null);
    const [powerConfirm, setPowerConfirm] = useState(null);
    const [powerTyped, setPowerTyped] = useState('');
    const loadMetrics = async () => {
        try {
            const next = await sampleMetrics(session);
            if (mounted.current) {
                setMetrics(next);
                setError(null);
            }
        }
        catch (err) {
            if (mounted.current)
                setError(errorText(err));
        }
    };
    const loadProcesses = async () => {
        try {
            const next = await listProcesses(session, 30);
            if (mounted.current)
                setProcesses(next);
        }
        catch (err) {
            if (mounted.current)
                setError(errorText(err));
        }
    };
    const loadServices = async () => {
        try {
            const next = await listServices(session);
            if (mounted.current)
                setServices(next);
        }
        catch (err) {
            if (mounted.current)
                setError(errorText(err));
        }
    };
    const refreshAll = async () => {
        setBusy(true);
        await Promise.all([loadMetrics(), loadProcesses(), loadServices()]);
        setBusy(false);
    };
    useEffect(() => {
        void refreshAll();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        if (!auto)
            return;
        const timer = setInterval(() => {
            void loadMetrics();
        }, 5000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [auto]);
    const runServiceAction = async (name, action) => {
        setBusy(true);
        setError(null);
        try {
            await controlService(session, name, action, true);
            await loadServices();
            setPending(null);
        }
        catch (err) {
            setError(errorText(err));
            setPending(null);
        }
        finally {
            setBusy(false);
        }
    };
    const showLogs = async (name) => {
        try {
            setLogs({ name, text: await serviceLogs(session, name, 120) });
        }
        catch (err) {
            setError(errorText(err));
        }
    };
    const filteredProcesses = processes.filter((proc) => filter.trim() ? proc.command.toLowerCase().includes(filter.trim().toLowerCase()) : true);
    return (_jsxs("div", { className: "ws-mod-detail", "data-testid": "live-control", children: [_jsxs("header", { className: "ws-mod-detail-head", children: [_jsxs("div", { children: [_jsx("h3", { children: "Live control" }), _jsxs("p", { className: "ws-mod-muted", children: ["Sampled from ", _jsx("code", { children: "/proc" }), ", ", _jsx("code", { children: "ps" }), " and ", _jsx("code", { children: "systemctl" }), ". Fields the server does not report stay blank; nothing here is estimated."] })] }), _jsxs("div", { className: "ws-mod-actions", children: [_jsxs("label", { className: "ws-mod-check", children: [_jsx("input", { type: "checkbox", checked: auto, onChange: (e) => setAuto(e.target.checked) }), "Auto-refresh 5s"] }), _jsx(Button, { variant: "default", onClick: () => void refreshAll(), disabled: busy, testId: "control-refresh", children: busy ? 'Refreshing…' : 'Refresh' })] })] }), error ? _jsx(ErrorNote, { message: error }) : null, metrics ? (_jsxs(_Fragment, { children: [_jsxs("dl", { className: "ws-mod-grid ws-mod-grid--compact", children: [_jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "CPU busy" }), _jsx("dd", { children: metrics.cpuPercent === null ? 'not reported' : `${metrics.cpuPercent}%` })] }), _jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "Load average" }), _jsx("dd", { children: metrics.loadAverage ? metrics.loadAverage.join(' / ') : 'not reported' })] }), _jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "Memory" }), _jsx("dd", { children: metrics.memory
                                            ? `${metrics.memory.usedMiB} / ${metrics.memory.totalMiB} MiB used`
                                            : 'not reported' })] }), _jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "Network" }), _jsx("dd", { children: metrics.network
                                            ? `↓ ${formatKiB(metrics.network.rxKiBps)}/s · ↑ ${formatKiB(metrics.network.txKiBps)}/s`
                                            : 'not reported' })] }), _jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "Uptime" }), _jsx("dd", { children: formatUptime(metrics.uptimeSeconds) })] }), _jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "Reboot required" }), _jsx("dd", { children: metrics.rebootRequired === null
                                            ? 'not reported'
                                            : metrics.rebootRequired
                                                ? 'yes — kernel or libraries updated'
                                                : 'no' })] })] }), _jsx("h3", { children: "Disks" }), _jsxs("table", { className: "ws-mod-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Mount" }), _jsx("th", { children: "Used" }), _jsx("th", { children: "Available" }), _jsx("th", { children: "Usage" })] }) }), _jsx("tbody", { children: metrics.disks.map((disk) => (_jsxs("tr", { children: [_jsx("td", { children: disk.mount }), _jsx("td", { children: formatKiB(disk.usedKiB) }), _jsx("td", { children: formatKiB(disk.availableKiB) }), _jsxs("td", { children: [disk.usedPercent, "%"] })] }, disk.mount))) })] })] })) : null, _jsx("h3", { children: "Processes" }), _jsx("input", { className: "ui-input", type: "search", placeholder: "Filter by command", "aria-label": "Filter processes", value: filter, onInput: (e) => setFilter(e.target.value) }), _jsxs("table", { className: "ws-mod-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "PID" }), _jsx("th", { children: "User" }), _jsx("th", { children: "CPU" }), _jsx("th", { children: "MEM" }), _jsx("th", { children: "Elapsed" }), _jsx("th", { children: "Command" })] }) }), _jsx("tbody", { children: filteredProcesses.slice(0, 20).map((proc) => (_jsxs("tr", { children: [_jsx("td", { children: proc.pid }), _jsx("td", { children: proc.user }), _jsxs("td", { children: [proc.cpuPercent, "%"] }), _jsxs("td", { children: [proc.memoryPercent, "%"] }), _jsx("td", { children: proc.elapsed }), _jsx("td", { children: proc.command })] }, proc.pid))) })] }), _jsx("h3", { children: "Services" }), _jsxs("p", { className: "ws-mod-muted", children: ["Actions use ", _jsx("code", { children: "sudo -n" }), ". Without passwordless sudo they fail immediately and report the privilege requirement instead of waiting for a password the browser cannot supply."] }), _jsxs("table", { className: "ws-mod-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Unit" }), _jsx("th", { children: "State" }), _jsx("th", { children: "Description" }), _jsx("th", { children: "Actions" })] }) }), _jsx("tbody", { children: services.slice(0, 40).map((service) => (_jsxs("tr", { children: [_jsx("td", { children: service.name }), _jsx("td", { children: _jsxs(Badge, { tone: service.active === 'active' ? 'success' : service.active === 'failed' ? 'danger' : 'neutral', children: [service.active, "/", service.sub] }) }), _jsx("td", { children: service.description }), _jsxs("td", { className: "ws-mod-row-actions", children: [_jsx(Button, { variant: "ghost", onClick: () => void showLogs(service.name), children: "Logs" }), _jsx(Button, { variant: "ghost", onClick: () => setPending({ name: service.name, action: 'restart' }), children: "Restart" }), _jsx(Button, { variant: "ghost", onClick: () => setPending({ name: service.name, action: 'stop' }), children: "Stop" })] })] }, service.name))) })] }), pending ? (_jsxs("div", { className: "ws-mod-plan", role: "alertdialog", "aria-label": "Confirm service action", children: [_jsxs("strong", { children: [pending.action === 'restart' ? 'Restart' : 'Stop', " ", pending.name, "?"] }), _jsx("p", { className: "ws-mod-muted", children: pending.action === 'restart'
                            ? 'The service will be interrupted briefly; dependent connections may drop.'
                            : 'The service stays stopped until something starts it again.' }), _jsxs("div", { className: "ws-mod-actions", children: [_jsxs(Button, { variant: "primary", onClick: () => void runServiceAction(pending.name, pending.action), testId: "control-confirm-service", children: ["Confirm ", pending.action] }), _jsx(Button, { variant: "ghost", onClick: () => setPending(null), children: "Cancel" })] })] })) : null, logs ? (_jsxs("div", { className: "ws-mod-detail", children: [_jsxs("header", { className: "ws-mod-detail-head", children: [_jsxs("strong", { children: ["journalctl \u00B7 ", logs.name] }), _jsx(Button, { variant: "ghost", onClick: () => setLogs(null), children: "Close" })] }), _jsx("pre", { className: "ws-mod-log", "aria-label": `Logs for ${logs.name}`, children: logs.text || 'No log lines were returned.' })] })) : null, _jsx("h3", { children: "Power" }), _jsx("p", { className: "ws-mod-muted", children: "These actions disconnect every session on the host. They are never triggered automatically." }), _jsxs("div", { className: "ws-mod-actions", children: [_jsx(Button, { variant: "danger", onClick: () => { setPowerConfirm('reboot'); setPowerTyped(''); }, children: "Reboot server" }), _jsx(Button, { variant: "danger", onClick: () => { setPowerConfirm('poweroff'); setPowerTyped(''); }, children: "Power off server" })] }), powerConfirm ? (_jsxs("div", { className: "ws-mod-plan", role: "alertdialog", "aria-label": "Confirm power action", children: [_jsxs("strong", { children: ["Type the hostname (", session.host, ") to confirm ", powerConfirm === 'reboot' ? 'reboot' : 'power off'] }), _jsx("input", { className: "ui-input", "aria-label": "Confirm hostname", value: powerTyped, onInput: (e) => setPowerTyped(e.target.value) }), _jsxs("div", { className: "ws-mod-actions", children: [_jsxs(Button, { variant: "danger", disabled: powerTyped.trim() !== session.host, onClick: () => {
                                    setBusy(true);
                                    powerAction(session, powerConfirm, true)
                                        .then(() => setError(null))
                                        .catch((err) => setError(errorText(err)))
                                        .finally(() => {
                                        setPowerConfirm(null);
                                        setBusy(false);
                                    });
                                }, children: ["Confirm ", powerConfirm === 'reboot' ? 'reboot' : 'power off'] }), _jsx(Button, { variant: "ghost", onClick: () => setPowerConfirm(null), children: "Cancel" })] })] })) : null] }));
}
/* ------------------------------------------------------------------ */
/* Software catalog                                                    */
/* ------------------------------------------------------------------ */
function fieldInputId(recipeId, fieldId) {
    return `recipe-${recipeId}-${fieldId}`;
}
function RecipeFieldControl({ recipe, field, value, onChange }) {
    const id = fieldInputId(recipe.id, field.id);
    if (field.type === 'boolean') {
        return (_jsxs("label", { className: "ws-mod-check", htmlFor: id, children: [_jsx("input", { id: id, type: "checkbox", checked: value === true, onChange: (event) => onChange(event.target.checked) }), field.label] }));
    }
    if (field.type === 'enum') {
        return (_jsxs(_Fragment, { children: [_jsx("label", { htmlFor: id, children: field.label }), _jsx("select", { id: id, value: String(value ?? ''), onChange: (event) => onChange(event.target.value), children: (field.options ?? []).map((option) => (_jsx("option", { value: option.value, children: option.label }, option.value))) })] }));
    }
    if (field.type === 'multiline' || field.type === 'list' || field.type === 'keyvalue') {
        return (_jsxs(_Fragment, { children: [_jsx("label", { htmlFor: id, children: field.label }), _jsx("textarea", { id: id, rows: 4, value: String(value ?? ''), placeholder: field.placeholder ?? '', onChange: (event) => onChange(event.target.value) })] }));
    }
    const inputType = field.type === 'number' || field.type === 'port'
        ? 'number'
        : field.type === 'secret'
            ? 'password'
            : 'text';
    return (_jsxs(_Fragment, { children: [_jsx("label", { htmlFor: id, children: field.label }), _jsx("input", { id: id, type: inputType, value: String(value ?? ''), placeholder: field.placeholder ?? '', min: field.min, max: field.max, autocomplete: field.sensitive ? 'new-password' : 'off', onChange: (event) => onChange(event.target.value) })] }));
}
function RecipeDetail({ recipe, caps, session, onJob }) {
    const [values, setValues] = useState(() => withDefaults(recipe));
    const [plan, setPlan] = useState(null);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);
    const [error, setError] = useState(null);
    const [lastJob, setLastJob] = useState(null);
    useEffect(() => {
        setValues(withDefaults(recipe));
        setPlan(null);
        setMessage(null);
        setError(null);
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
        }
        catch (err) {
            setError(errorText(err));
        }
    };
    const install = async () => {
        if (!plan)
            return;
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
            setMessage(job.state === 'failed'
                ? `Job could not start: ${job.error ?? 'unknown error'}`
                : `Job ${job.id} started. Track it under Activity.`);
            void monitorJob(job, jobSessionFor(session, recipe.privileges === 'sudo'), {
                onUpdate: (updated) => {
                    onJob(updated);
                    setLastJob(updated);
                }
            }).catch(() => undefined);
        }
        catch (err) {
            setError(errorText(err));
        }
        finally {
            setBusy(false);
        }
    };
    /**
     * Verification runs the recipe's `verify` steps as the logged-in user and
     * records the outcome on the job. It is a separate, explicit action so a
     * passing install never implies a passing check.
     */
    const runVerification = async () => {
        if (!lastJob)
            return;
        if (!session.execStream) {
            setError('This transport cannot stream exec output, so verification steps cannot run.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const verified = await verifyJob(lastJob, recipe, {
                capabilities: caps,
                execStream: (command, options) => session.execStream(command, options),
                ...(session.writeFile ? { writeFile: session.writeFile } : {})
            });
            setLastJob(verified);
            onJob(verified);
            setMessage(verified.verification?.ok
                ? `Verification passed: ${verified.verification.detail ?? ''}`.trim()
                : `Verification failed: ${verified.verification?.detail ?? 'no detail'}`);
        }
        catch (err) {
            setError(errorText(err));
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs("div", { className: "ws-mod-detail", children: [_jsxs("header", { className: "ws-mod-detail-head", children: [_jsxs("div", { children: [_jsx("h3", { children: recipe.name }), _jsx("p", { className: "ws-mod-muted", children: recipe.description })] }), _jsx(Badge, { tone: evaluation.state === 'available' ? 'success' : evaluation.state === 'installed' ? 'neutral' : 'warning', children: evaluation.state.replaceAll('_', ' ') })] }), evaluation.reason ? _jsx("p", { className: "ws-mod-muted", children: evaluation.reason }) : null, _jsxs("dl", { className: "ws-mod-grid ws-mod-grid--compact", children: [_jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "Recipe version" }), _jsx("dd", { children: recipe.version })] }), _jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "Installs" }), _jsx("dd", { children: recipe.versionInstalled })] }), _jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "Privileges" }), _jsx("dd", { children: recipe.privileges === 'sudo' ? 'sudo required' : 'current user' })] }), _jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "Rollback" }), _jsx("dd", { children: recipe.rollback })] }), _jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "License" }), _jsx("dd", { children: recipe.license })] })] }), recipe.provides?.services?.length || recipe.provides?.ports?.length ? (_jsxs("p", { className: "ws-mod-muted", children: [recipe.provides?.services?.length
                        ? `Services: ${recipe.provides.services.join(', ')}. `
                        : '', recipe.provides?.ports?.length ? `Ports: ${recipe.provides.ports.join(', ')}.` : ''] })) : null, _jsx("h4", { children: "Variables" }), basicFields.length === 0 && advancedFields.length === 0 ? (_jsx("p", { className: "ws-mod-muted", children: "This recipe needs no variables." })) : null, _jsxs("div", { className: "ws-mod-form", children: [basicFields.map((field) => (_jsx(RecipeFieldControl, { recipe: recipe, field: field, value: values[field.id], onChange: (value) => setValues((prev) => ({ ...prev, [field.id]: value })) }, field.id))), advancedFields.length > 0 ? (_jsx(Button, { variant: "ghost", onClick: () => setShowAdvanced((prev) => !prev), children: showAdvanced ? 'Hide advanced variables' : `Advanced variables (${advancedFields.length})` })) : null, showAdvanced
                        ? advancedFields.map((field) => (_jsx(RecipeFieldControl, { recipe: recipe, field: field, value: values[field.id], onChange: (value) => setValues((prev) => ({ ...prev, [field.id]: value })) }, field.id)))
                        : null] }), errors.length > 0 ? (_jsx("ul", { className: "ws-mod-error-list", children: errors.map((err) => (_jsx("li", { children: err.message }, err.field))) })) : null, _jsxs("div", { className: "ws-mod-actions", children: [_jsx(Button, { onClick: preview, disabled: busy, testId: "recipe-preview", children: "Preview plan" }), _jsx(Button, { variant: "primary", onClick: () => void install(), disabled: busy || !plan?.canExecute, testId: "recipe-install", children: busy ? 'Starting…' : 'Install' }), lastJob ? (_jsx(Button, { onClick: () => void runVerification(), disabled: busy || !lastJob || session.execStream === undefined, testId: "recipe-verify", children: "Run verification" })) : null] }), message ? _jsx("p", { className: "ws-mod-success", children: message }) : null, error ? _jsx(ErrorNote, { message: error }) : null, plan ? (_jsxs("div", { className: "ws-mod-plan", children: [_jsx("h4", { children: "Plan" }), _jsxs("ul", { className: "ws-mod-issues", children: [plan.issues.map((issue, index) => (_jsxs("li", { className: `ws-mod-issue ws-mod-issue--${issue.level}`, children: [_jsx(Badge, { tone: issue.level === 'blocking' ? 'danger' : 'warning', children: issue.level }), ' ', issue.message] }, `${issue.code}-${index}`))), plan.issues.length === 0 ? _jsx("li", { className: "ws-mod-muted", children: "No issues found." }) : null] }), _jsxs("table", { className: "ws-mod-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Step" }), _jsx("th", { children: "Command" })] }) }), _jsx("tbody", { children: plan.steps.map((step) => (_jsxs("tr", { children: [_jsx("td", { children: step.title }), _jsx("td", { children: _jsx("code", { children: step.kind === 'exec'
                                                    ? (step.resolvedArgv ?? step.argv).join(' ')
                                                    : `write ${step.path}` }) })] }, step.id))) })] }), plan.steps.some((step) => step.kind === 'exec' && step.asRoot) ? (_jsx("p", { className: "ws-mod-muted", children: "Steps marked as root run through `sudo -n`. If sudo needs a password the plan is blocked rather than storing your password." })) : null] })) : null] }));
}
export function SoftwarePanel({ ctx }) {
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState('all');
    const [selectedId, setSelectedId] = useState(null);
    const recipes = useMemo(() => {
        const all = query.trim() ? searchRecipes(query) : listRecipes();
        return category === 'all' ? all : all.filter((r) => r.category === category);
    }, [query, category]);
    const selected = selectedId ? recipes.find((r) => r.id === selectedId) ?? null : null;
    const categories = useMemo(() => ['all', ...Array.from(new Set(listRecipes().map((r) => r.category)))], []);
    return (_jsxs("section", { className: "ws-mod", "data-testid": "screen-software", children: [_jsx("header", { className: "ws-mod-head", children: _jsxs("div", { children: [_jsx("h2", { children: "Software" }), _jsx("p", { className: "ws-mod-muted", children: "Versioned recipes with preflight checks, a plan preview and a durable job. Nothing is installed until you review the plan." })] }) }), !ctx.session ? _jsx(RequiresSession, { what: "Installable software" }) : null, ctx.session && !ctx.capabilities ? (_jsx(EmptyState, { title: "Inspect the server first", description: "Compatibility, existing versions, disk and privilege checks need discovery data.", action: _jsx(Button, { variant: "primary", onClick: () => void ctx.onDiscover(), disabled: ctx.discoveryBusy, children: ctx.discoveryBusy ? 'Inspecting…' : 'Inspect server' }) })) : null, ctx.session && ctx.capabilities ? (_jsxs("div", { className: "ws-mod-split", children: [_jsxs("div", { className: "ws-mod-list", children: [_jsxs("div", { className: "ws-mod-filters", children: [_jsx("input", { type: "search", placeholder: "Search software", value: query, onInput: (event) => setQuery(event.target.value), "aria-label": "Search software" }), _jsx("select", { "aria-label": "Category", value: category, onChange: (event) => setCategory(event.target.value), children: categories.map((entry) => (_jsx("option", { value: entry, children: entry === 'all' ? 'All categories' : entry }, entry))) })] }), _jsxs("ul", { className: "ws-mod-recipes", children: [recipes.map((recipe) => {
                                        const evaluation = evaluateRecipe(recipe, ctx.capabilities);
                                        return (_jsx("li", { children: _jsxs("button", { type: "button", className: `ws-mod-recipe ${selectedId === recipe.id ? 'ws-mod-recipe--active' : ''}`, onClick: () => setSelectedId(recipe.id), "data-testid": `recipe-${recipe.id}`, children: [_jsxs("span", { className: "ws-mod-recipe-name", children: [_jsx(Icon, { name: "file" }), " ", recipe.name] }), _jsx("span", { className: "ws-mod-muted", children: evaluation.state === 'installed' ? 'Installed' : recipe.description }), _jsx(Badge, { tone: evaluation.state === 'available'
                                                            ? 'success'
                                                            : evaluation.state === 'installed'
                                                                ? 'neutral'
                                                                : 'warning', children: evaluation.state.replaceAll('_', ' ') })] }) }, recipe.id));
                                    }), recipes.length === 0 ? _jsx("li", { className: "ws-mod-muted", children: "No recipes match." }) : null] })] }), _jsx("div", { className: "ws-mod-content", children: selected ? (_jsx(RecipeDetail, { recipe: selected, caps: ctx.capabilities, session: ctx.session, onJob: () => undefined })) : (_jsx(EmptyState, { title: "Select software", description: "Pick a recipe to review compatibility and variables." })) })] })) : null] }));
}
/* ------------------------------------------------------------------ */
/* Containers                                                          */
/* ------------------------------------------------------------------ */
const CONTAINER_STATES = {
    running: 'success',
    exited: 'neutral',
    paused: 'warning',
    created: 'warning'
};
export function ContainersPanel({ ctx }) {
    const session = ctx.session;
    const [refreshToken, setRefreshToken] = useState(0);
    const [actionError, setActionError] = useState(null);
    const docker = useMemo(() => (session ? new DockerClient(session) : null), [session, session?.host]);
    const availability = useAsync(() => (docker ? docker.available() : Promise.reject(new Error('no session'))), [docker]);
    const containers = useAsync(() => availability.state === 'ready' && availability.value.ok && docker
        ? docker.listContainers(true)
        : Promise.resolve([]), [docker, availability.state, refreshToken]);
    const [logs, setLogs] = useState(null);
    const run = async (id, action) => {
        if (!docker)
            return;
        setActionError(null);
        try {
            if (action === 'logs') {
                const text = await docker.logs(id, 200);
                setLogs({ id, text });
                return;
            }
            await docker[action](id);
            setRefreshToken((n) => n + 1);
        }
        catch (err) {
            setActionError(errorText(err));
        }
    };
    if (!session) {
        return (_jsx("section", { className: "ws-mod", "data-testid": "screen-containers", children: _jsx(RequiresSession, { what: "Container controls" }) }));
    }
    return (_jsxs("section", { className: "ws-mod", "data-testid": "screen-containers", children: [_jsxs("header", { className: "ws-mod-head", children: [_jsxs("div", { children: [_jsx("h2", { children: "Containers" }), _jsx("p", { className: "ws-mod-muted", children: "Uses the remote Docker CLI. The daemon socket is never exposed; every action runs through your SSH session and its permissions." })] }), _jsx(Button, { onClick: () => setRefreshToken((n) => n + 1), children: "Refresh" })] }), availability.state === 'loading' ? _jsx(Loading, { label: "Checking Docker" }) : null, availability.state === 'ready' && !availability.value.ok ? (_jsx(EmptyState, { title: "Docker is not available", description: availability.value.detail, action: _jsx(Button, { variant: "primary", onClick: () => void ctx.onDiscover(), children: "Check software catalog" }) })) : null, availability.state === 'error' ? _jsx(ErrorNote, { message: availability.error }) : null, actionError ? _jsx(ErrorNote, { message: actionError }) : null, availability.state === 'ready' && availability.value.ok ? (_jsxs(_Fragment, { children: [containers.state === 'loading' ? _jsx(Loading, { label: "Listing containers" }) : null, containers.state === 'error' ? _jsx(ErrorNote, { message: containers.error }) : null, containers.state === 'ready' ? (containers.value.length === 0 ? (_jsx(EmptyState, { title: "No containers", description: "Docker is reachable but runs no containers." })) : (_jsxs("table", { className: "ws-mod-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Name" }), _jsx("th", { children: "Image" }), _jsx("th", { children: "State" }), _jsx("th", { children: "Status" }), _jsx("th", { children: "Ports" }), _jsx("th", { children: "Actions" })] }) }), _jsx("tbody", { children: containers.value.map((container) => (_jsxs("tr", { children: [_jsx("td", { children: container.name }), _jsx("td", { children: container.image }), _jsx("td", { children: _jsx(Badge, { tone: CONTAINER_STATES[container.state] ?? 'neutral', children: container.state }) }), _jsx("td", { children: container.status }), _jsx("td", { children: container.ports }), _jsxs("td", { className: "ws-mod-row-actions", children: [_jsx(Button, { variant: "ghost", onClick: () => void run(container.id, 'start'), children: "Start" }), _jsx(Button, { variant: "ghost", onClick: () => void run(container.id, 'stop'), children: "Stop" }), _jsx(Button, { variant: "ghost", onClick: () => void run(container.id, 'restart'), children: "Restart" }), _jsx(Button, { variant: "ghost", onClick: () => void run(container.id, 'logs'), children: "Logs" })] })] }, container.id))) })] }))) : null, logs ? (_jsx("pre", { className: "ws-mod-log", "aria-label": `Logs for ${logs.id}`, children: logs.text || '(no log output)' })) : null] })) : null] }));
}
/* ------------------------------------------------------------------ */
/* Kubernetes                                                          */
/* ------------------------------------------------------------------ */
export function KubernetesPanel({ ctx }) {
    const session = ctx.session;
    const [context, setContext] = useState('');
    const [namespace, setNamespace] = useState('default');
    const [logs, setLogs] = useState(null);
    const [error, setError] = useState(null);
    const client = useMemo(() => (session ? new KubernetesClient(session, context.trim() || undefined, namespace.trim() || 'default') : null), [session, context, namespace]);
    const availability = useAsync(() => (client ? client.available() : Promise.reject(new Error('no session'))), [client]);
    const pods = useAsync(() => availability.state === 'ready' && availability.value.ok && client
        ? client.pods()
        : Promise.resolve([]), [client, availability.state]);
    if (!session) {
        return (_jsx("section", { className: "ws-mod", "data-testid": "screen-kubernetes", children: _jsx(RequiresSession, { what: "Cluster controls" }) }));
    }
    const readLogs = async (pod) => {
        if (!client)
            return;
        setError(null);
        try {
            setLogs({ pod, text: await client.podLogs(pod, 200) });
        }
        catch (err) {
            setError(errorText(err));
        }
    };
    return (_jsxs("section", { className: "ws-mod", "data-testid": "screen-kubernetes", children: [_jsx("header", { className: "ws-mod-head", children: _jsxs("div", { children: [_jsx("h2", { children: "Kubernetes" }), _jsx("p", { className: "ws-mod-muted", children: "Uses the kubeconfig and context that already exist on the server. Permissions are the server user's own; the workspace never assumes cluster-admin and never reads Secret values." })] }) }), _jsxs("div", { className: "ws-mod-filters", children: [_jsxs("label", { children: ["Context", _jsx("input", { value: context, placeholder: "current context", onInput: (event) => setContext(event.target.value) })] }), _jsxs("label", { children: ["Namespace", _jsx("input", { value: namespace, onInput: (event) => setNamespace(event.target.value) })] })] }), availability.state === 'loading' ? _jsx(Loading, { label: "Checking kubectl" }) : null, availability.state === 'ready' && !availability.value.ok ? (_jsx(EmptyState, { title: "Kubernetes is not usable from this server", description: availability.value.detail, action: _jsx(Button, { variant: "primary", onClick: () => void ctx.onDiscover(), children: "Inspect server" }) })) : null, availability.state === 'error' ? _jsx(ErrorNote, { message: availability.error }) : null, error ? _jsx(ErrorNote, { message: error }) : null, availability.state === 'ready' && availability.value.ok ? (_jsxs(_Fragment, { children: [pods.state === 'loading' ? _jsx(Loading, { label: "Listing pods" }) : null, pods.state === 'error' ? _jsx(ErrorNote, { message: pods.error }) : null, pods.state === 'ready' ? (pods.value.length === 0 ? (_jsx(EmptyState, { title: "No pods", description: "The namespace has no pods, or you lack permission to list them." })) : (_jsxs("table", { className: "ws-mod-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Pod" }), _jsx("th", { children: "Phase" }), _jsx("th", { children: "Ready" }), _jsx("th", { children: "Restarts" }), _jsx("th", { children: "Node" }), _jsx("th", { children: "Actions" })] }) }), _jsx("tbody", { children: pods.value.map((pod) => (_jsxs("tr", { children: [_jsx("td", { children: pod.name }), _jsx("td", { children: pod.phase }), _jsx("td", { children: pod.ready }), _jsx("td", { children: pod.restarts }), _jsx("td", { children: pod.node ?? '—' }), _jsx("td", { children: _jsx(Button, { variant: "ghost", onClick: () => void readLogs(pod.name), children: "Logs" }) })] }, pod.name))) })] }))) : null, logs ? (_jsx("pre", { className: "ws-mod-log", "aria-label": `Logs for ${logs.pod}`, children: logs.text || '(no log output)' })) : null] })) : null] }));
}
/* ------------------------------------------------------------------ */
/* Automations                                                         */
/* ------------------------------------------------------------------ */
export function AutomationsPanel({ ctx }) {
    const session = ctx.session;
    const [environment, setEnvironment] = useState(null);
    const [entries, setEntries] = useState([]);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!session) {
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
            if (cancelled)
                return;
            setEnvironment(detected);
            setEntries(crontab);
        })
            .catch((err) => {
            if (!cancelled)
                setError(errorText(err));
        })
            .finally(() => {
            if (!cancelled)
                setBusy(false);
        });
        return () => {
            cancelled = true;
        };
    }, [session]);
    if (!session) {
        return (_jsx("section", { className: "ws-mod", "data-testid": "screen-automations", children: _jsx(RequiresSession, { what: "Scheduled automation" }) }));
    }
    return (_jsxs("section", { className: "ws-mod", "data-testid": "screen-automations", children: [_jsx("header", { className: "ws-mod-head", children: _jsxs("div", { children: [_jsx("h2", { children: "Automations" }), _jsx("p", { className: "ws-mod-muted", children: "Python environments and the server's own crontab. Only entries created by this workspace are managed; existing crontab lines are left untouched." })] }) }), busy ? _jsx(Loading, { label: "Reading Python and crontab" }) : null, error ? _jsx(ErrorNote, { message: error }) : null, _jsx("h3", { children: "Python" }), environment ? (_jsxs("p", { children: [_jsx("code", { children: environment.path }), " reports ", environment.version, environment.venvAvailable ? ' · venv module available' : ' · venv module missing', environment.pipAvailable ? ' · pip available' : ' · pip missing'] })) : (!busy && _jsx("p", { className: "ws-mod-muted", children: "Python 3 was not found on this server." })), _jsx("h3", { children: "Scheduled entries" }), entries.length === 0 ? (_jsx("p", { className: "ws-mod-muted", children: "No workspace-managed crontab entries." })) : (_jsxs("table", { className: "ws-mod-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Id" }), _jsx("th", { children: "Schedule" }), _jsx("th", { children: "Command" })] }) }), _jsx("tbody", { children: entries.map((entry) => (_jsxs("tr", { children: [_jsx("td", { children: entry.id }), _jsx("td", { children: _jsx("code", { children: entry.schedule }) }), _jsx("td", { children: _jsx("code", { children: entry.command }) })] }, entry.id))) })] }))] }));
}
/* ------------------------------------------------------------------ */
/* Activity                                                            */
/* ------------------------------------------------------------------ */
const JOB_TONES = {
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
export function ActivityPanel({ ctx }) {
    const [jobs, setJobs] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [error, setError] = useState(null);
    const selected = jobs.find((job) => job.id === selectedId) ?? null;
    const reload = () => {
        jobStore
            .list()
            .then((records) => setJobs(records))
            .catch((err) => setError(errorText(err)));
    };
    useEffect(reload, []);
    const update = (updated) => {
        setJobs((prev) => prev.map((job) => (job.id === updated.id ? updated : job)));
    };
    const reattach = async (job) => {
        if (!ctx.session)
            return;
        setError(null);
        try {
            const final = await monitorJob(job, jobSessionFor(ctx.session), {
                onUpdate: update,
                timeoutMs: 300_000
            });
            update(final);
        }
        catch (err) {
            setError(errorText(err));
        }
    };
    const cancel = async (job) => {
        if (!ctx.session)
            return;
        setError(null);
        try {
            update(await cancelAndConfirm(job, jobSessionFor(ctx.session)));
        }
        catch (err) {
            setError(errorText(err));
        }
    };
    return (_jsxs("section", { className: "ws-mod", "data-testid": "screen-activity", children: [_jsxs("header", { className: "ws-mod-head", children: [_jsxs("div", { children: [_jsx("h2", { children: "Activity" }), _jsx("p", { className: "ws-mod-muted", children: "Durable job history. Closing the browser does not mark a running job as finished; reconnect and reattach to keep observing it." })] }), _jsx(Button, { onClick: reload, children: "Refresh" })] }), error ? _jsx(ErrorNote, { message: error }) : null, jobs.length === 0 ? (_jsx(EmptyState, { title: "No jobs yet", description: "Installations, builds and deployments appear here." })) : (_jsxs("div", { className: "ws-mod-split", children: [_jsx("ul", { className: "ws-mod-list", children: jobs.map((job) => (_jsx("li", { children: _jsxs("button", { type: "button", className: `ws-mod-recipe ${selectedId === job.id ? 'ws-mod-recipe--active' : ''}`, onClick: () => setSelectedId(job.id), children: [_jsx("span", { className: "ws-mod-recipe-name", children: job.title }), _jsx("span", { className: "ws-mod-muted", children: new Date(job.createdAt).toLocaleString() }), _jsx(Badge, { tone: JOB_TONES[job.state], children: job.state.replaceAll('_', ' ') })] }) }, job.id))) }), _jsx("div", { className: "ws-mod-content", children: selected ? (_jsxs("div", { className: "ws-mod-detail", children: [_jsx("h3", { children: selected.title }), _jsxs("dl", { className: "ws-mod-grid ws-mod-grid--compact", children: [_jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "Job id" }), _jsx("dd", { children: _jsx("code", { children: selected.id }) })] }), _jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "Server" }), _jsxs("dd", { children: [selected.server.user, "@", selected.server.host, ":", selected.server.port] })] }), _jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "Recipe" }), _jsxs("dd", { children: [selected.recipeId ?? '—', " ", selected.recipeVersion ?? ''] })] }), _jsxs("div", { className: "ws-mod-grid-row", children: [_jsx("dt", { children: "State" }), _jsx("dd", { children: _jsx(Badge, { tone: JOB_TONES[selected.state], children: selected.state.replaceAll('_', ' ') }) })] })] }), selected.error ? _jsx(ErrorNote, { message: selected.error }) : null, _jsx("ol", { className: "ws-mod-steps", children: selected.steps.map((step) => (_jsxs("li", { children: [_jsx(Badge, { tone: step.status === 'succeeded'
                                                    ? 'success'
                                                    : step.status === 'failed'
                                                        ? 'danger'
                                                        : 'neutral', children: step.status }), ' ', step.title, step.exitCode !== undefined ? ` (exit ${step.exitCode})` : ''] }, step.id))) }), isActiveJobState(selected.state) && ctx.session ? (_jsxs("div", { className: "ws-mod-actions", children: [_jsx(Button, { variant: "primary", onClick: () => void reattach(selected), children: "Reattach and follow" }), _jsx(Button, { variant: "danger", onClick: () => void cancel(selected), children: "Cancel job" })] })) : null] })) : (_jsx(EmptyState, { title: "Select a job", description: "Choose a job to see its steps and result." })) })] }))] }));
}
/* ------------------------------------------------------------------ */
/* Deployments: Git review, project detection, reviewed deploy plan    */
/* ------------------------------------------------------------------ */
export function DeploymentsPanel({ ctx }) {
    const session = ctx.session;
    const [directory, setDirectory] = useState('~/app');
    const [project, setProject] = useState(null);
    const [git, setGit] = useState(null);
    const [branches, setBranches] = useState(null);
    const [log, setLog] = useState([]);
    const [diff, setDiff] = useState('');
    const [commitMessage, setCommitMessage] = useState('');
    const [installDependencies, setInstallDependencies] = useState(true);
    const [buildCommand, setBuildCommand] = useState('');
    const [startCommand, setStartCommand] = useState('');
    const [serviceName, setServiceName] = useState('');
    const [composeFile, setComposeFile] = useState('');
    const [healthUrl, setHealthUrl] = useState('');
    const [plan, setPlan] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [message, setMessage] = useState(null);
    const [job, setJob] = useState(null);
    const [jobLog, setJobLog] = useState('');
    const monitorAbort = useRef(null);
    const logSeq = useRef(0);
    if (!session)
        return _jsx(RequiresSession, { what: "Deployments and Git" });
    const gitClient = () => new GitClient(session, directory.trim());
    const refreshGit = async (dir = directory) => {
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
    const detect = async () => {
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
        }
        catch (err) {
            setProject(null);
            setGit(null);
            setError(errorText(err));
        }
        finally {
            setBusy(false);
        }
    };
    const runGitAction = async (label, action) => {
        setBusy(true);
        setError(null);
        setMessage(null);
        try {
            await action(gitClient());
            await refreshGit();
            setMessage(label);
        }
        catch (err) {
            setError(errorText(err));
        }
        finally {
            setBusy(false);
        }
    };
    const preview = () => {
        if (!project)
            return;
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
    const deploy = async () => {
        if (!plan)
            return;
        setBusy(true);
        setError(null);
        setMessage(null);
        setJobLog('');
        try {
            const steps = [
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
            const finished = await monitorJob(started, jobSessionFor(session, serviceName.trim().length > 0), {
                signal: controller.signal,
                onUpdate: (current) => {
                    setJob(current);
                    void refreshJobLog(current);
                }
            }).finally(() => {
                monitorAbort.current = null;
            });
            setJob(finished);
            await refreshJobLog(finished);
            if (finished.state === 'detached') {
                setMessage(`Stopped following job ${finished.id}. It keeps running on the server; reattach from Activity.`);
            }
        }
        catch (err) {
            setError(errorText(err));
        }
        finally {
            setBusy(false);
        }
    };
    const refreshJobLog = async (current) => {
        if (!isValidJobId(current.id))
            return;
        // Polls can overlap; only the newest read may update the view.
        const seq = ++logSeq.current;
        try {
            const result = await session.exec(`tail -n 200 "$HOME/.webssh/jobs/${current.id}/stdout.log" 2>/dev/null || true`);
            if (seq === logSeq.current)
                setJobLog(result.stdout);
        }
        catch {
            // Log tail is best-effort; the job state remains authoritative.
        }
    };
    return (_jsxs("section", { className: "ws-mod", "data-testid": "screen-deployments", children: [_jsx("header", { className: "ws-mod-head", children: _jsxs("div", { children: [_jsx("h1", { children: "Deployments" }), _jsx("p", { className: "ws-mod-muted", children: "Inspect a project, review Git changes, then run a reviewed build and deploy plan on the connected server. Deployment runs as a durable job in the background." })] }) }), busy ? _jsx(Loading, { label: "Working" }) : null, error ? _jsx(ErrorNote, { message: error }) : null, message ? _jsx("p", { className: "ws-mod-success", children: message }) : null, _jsxs("div", { className: "ws-mod-filters", children: [_jsx("input", { className: "ui-input", "aria-label": "Project directory", placeholder: "~/app", value: directory, onInput: (e) => setDirectory(e.target.value), style: { flex: 1, minWidth: '220px' } }), _jsx(Button, { variant: "primary", onClick: () => void detect(), testId: "deploy-detect", children: "Detect project" })] }), project ? (_jsxs("div", { className: "ws-mod-detail", children: [_jsxs("header", { className: "ws-mod-detail-head", children: [_jsx("strong", { children: project.type }), _jsxs(Badge, { tone: project.type === 'unknown' ? 'warning' : 'success', children: [project.manifests.length, " manifest", project.manifests.length === 1 ? '' : 's'] })] }), _jsx("p", { className: "ws-mod-muted", children: project.directory }), project.manifests.length > 0 ? (_jsx("div", { className: "ws-mod-chips", children: project.manifests.map((m) => (_jsx(Badge, { tone: "neutral", children: m }, m))) })) : null, project.notes.length > 0 ? (_jsx("ul", { className: "ws-mod-warnings", children: project.notes.map((note) => (_jsx("li", { children: note }, note))) })) : null] })) : null, git ? (_jsxs("div", { className: "ws-mod-detail", children: [_jsxs("header", { className: "ws-mod-detail-head", children: [_jsxs("strong", { children: ["Git \u00B7 ", git.branch] }), _jsx(Badge, { tone: git.clean ? 'success' : 'warning', children: git.clean ? 'clean' : `${git.files.length} changed` })] }), _jsxs("p", { className: "ws-mod-muted", children: [git.upstream ? `upstream ${git.upstream} · ` : '', git.ahead, " ahead \u00B7 ", git.behind, " behind", branches ? ` · branches: ${branches.branches.join(', ')}` : ''] }), git.files.length > 0 ? (_jsxs("table", { className: "ws-mod-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Code" }), _jsx("th", { children: "Path" })] }) }), _jsx("tbody", { children: git.files.map((file) => (_jsxs("tr", { children: [_jsx("td", { children: file.code }), _jsx("td", { children: file.path })] }, file.path))) })] })) : null, _jsxs("div", { className: "ws-mod-actions", children: [_jsx(Button, { variant: "default", onClick: () => void runGitAction('Staged all changes', (c) => c.stage([])), testId: "git-stage-all", children: "Stage all" }), _jsx(Button, { variant: "default", onClick: () => void runGitAction('Loaded diff', async (c) => setDiff(await c.diff())).then(() => undefined), testId: "git-diff", children: "Show diff" }), _jsx("input", { className: "ui-input", "aria-label": "Commit message", placeholder: "Commit message", value: commitMessage, onInput: (e) => setCommitMessage(e.target.value) }), _jsx(Button, { variant: "primary", onClick: () => void runGitAction('Commit created', (c) => c.commit(commitMessage.trim())), testId: "git-commit", children: "Commit" })] }), diff ? (_jsx("pre", { className: "ws-mod-log", "aria-label": "Git diff", children: diff })) : null, log.length > 0 ? (_jsxs("table", { className: "ws-mod-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Commit" }), _jsx("th", { children: "Author" }), _jsx("th", { children: "Date" }), _jsx("th", { children: "Subject" })] }) }), _jsx("tbody", { children: log.map((entry) => (_jsxs("tr", { children: [_jsx("td", { children: entry.shortHash }), _jsx("td", { children: entry.author }), _jsx("td", { children: entry.date }), _jsx("td", { children: entry.subject })] }, entry.hash))) })] })) : null] })) : null, _jsxs("div", { className: "ws-mod-detail", children: [_jsx("header", { className: "ws-mod-detail-head", children: _jsx("strong", { children: "Deployment options" }) }), _jsxs("div", { className: "ws-mod-form", children: [_jsxs("label", { className: "ws-mod-check", children: [_jsx("input", { type: "checkbox", checked: installDependencies, onChange: (e) => setInstallDependencies(e.target.checked) }), "Install dependencies before building"] }), _jsx("input", { className: "ui-input", "aria-label": "Build command", placeholder: "Build command (leave empty to skip)", value: buildCommand, onInput: (e) => setBuildCommand(e.target.value) }), _jsx("input", { className: "ui-input", "aria-label": "Start command", placeholder: "Start command (optional)", value: startCommand, onInput: (e) => setStartCommand(e.target.value) }), _jsx("input", { className: "ui-input", "aria-label": "Systemd service name", placeholder: "Restart systemd service (requires sudo -n)", value: serviceName, onInput: (e) => setServiceName(e.target.value) }), _jsx("input", { className: "ui-input", "aria-label": "Compose file", placeholder: "Compose file (e.g. compose.yaml)", value: composeFile, onInput: (e) => setComposeFile(e.target.value) }), _jsx("input", { className: "ui-input", "aria-label": "Health check URL", placeholder: "Health check URL (optional)", value: healthUrl, onInput: (e) => setHealthUrl(e.target.value) }), _jsxs("div", { className: "ws-mod-actions", children: [_jsx(Button, { variant: "default", onClick: preview, testId: "deploy-preview", children: "Preview plan" }), _jsx(Button, { variant: "primary", onClick: () => void deploy(), disabled: !plan || busy, testId: "deploy-run", children: "Run deployment" })] })] })] }), plan ? (_jsxs("div", { className: "ws-mod-plan", children: [_jsx("strong", { children: "Plan" }), _jsxs("p", { className: "ws-mod-muted", children: ["Rollback: ", plan.rollback === 'supported' ? 'supported' : plan.rollback === 'limited' ? 'limited — external state may not reverse' : 'not available'] }), _jsxs("table", { className: "ws-mod-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Step" }), _jsx("th", { children: "Command" }), _jsx("th", { children: "Impact" })] }) }), _jsx("tbody", { children: plan.steps.map((step) => (_jsxs("tr", { children: [_jsx("td", { children: step.title }), _jsx("td", { children: _jsx("code", { children: step.command }) }), _jsx("td", { children: step.impact })] }, step.id))) })] }), plan.notes.length > 0 ? (_jsx("ul", { className: "ws-mod-warnings", children: plan.notes.map((note) => (_jsx("li", { children: note }, note))) })) : null] })) : null, job ? (_jsxs("div", { className: "ws-mod-detail", children: [_jsxs("header", { className: "ws-mod-detail-head", children: [_jsxs("strong", { children: ["Job ", job.id] }), _jsx(Badge, { tone: job.state === 'succeeded'
                                    ? 'success'
                                    : job.state === 'failed'
                                        ? 'danger'
                                        : job.state === 'detached'
                                            ? 'warning'
                                            : 'neutral', children: job.state })] }), monitorAbort.current ? (_jsx(Button, { onClick: () => monitorAbort.current?.abort(), testId: "deploy-stop-following", children: "Stop following" })) : null, _jsx("ul", { className: "ws-mod-steps", children: job.steps.map((step) => (_jsxs("li", { children: [step.status, " \u00B7 ", step.title] }, step.id))) }), job.error ? _jsx(ErrorNote, { message: job.error }) : null, jobLog ? (_jsx("pre", { className: "ws-mod-log", "aria-label": "Deployment log", children: jobLog })) : null] })) : null] }));
}
/* ------------------------------------------------------------------ */
/* Discovery helper used by App                                        */
/* ------------------------------------------------------------------ */
export async function runDiscovery(session) {
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
//# sourceMappingURL=ServerModules.js.map