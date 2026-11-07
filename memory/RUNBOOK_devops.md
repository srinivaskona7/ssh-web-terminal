# Runbook — DevOps Hub (`devops/`, engine only)

## Groups

`types.ts`: `network` (listeners/routes/reachability/certs), `security` (keys/sshd/firewall/accounts), `system` (disks/processes/units/cron), `delivery` (updates/images/posture), `operations` (runbooks/incidents/probes/drift).

## Contract

- `exec.ts` — `runTool(session, tool)` → `ToolResult {status: ok|partial|unavailable|error, summary, findings[], tables[], notes[], evidence[], collectedAt}`
- `ResultCell = string | number | null` — `null` renders "not reported"
- Findings: `critical|warning|info|ok` with subject + detail
- Evidence: command + exit + stdout/stderr (truncated at `EVIDENCE_LIMIT`)

## Tools

- `tools/network/` — `ss -tlnp`, `ip route`, `curl` probes, cert expiry
- `tools/system/` — `df`, `ps`, `systemctl --failed`, `crontab -l`
- `tools/delivery/` — `apt`/`yum` updates, `docker images`, workload posture
- `logs/` — journal/syslog streaming (bounded)

## Wiring

Same as diagrams: create `DevOpsScreen.tsx` consuming `ToolResult`, rail entry, run tools via `WorkspaceRemoteSession`, show evidence per tool. No screen until probes + tests land (ADR-007).
