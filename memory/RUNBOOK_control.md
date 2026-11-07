# Runbook — Control Centre (`control/server-control.ts`)

Sole source of live metrics. Used by OverviewPanel.

## Probes (all via `WorkspaceRemoteSession.exec`, 15s timeout)

- CPU: `cat /proc/stat` twice 200ms apart → delta %
- Mem: `/proc/meminfo`
- Disk: `df -P / -` + `df -P /data` if exists
- Net: `/proc/net/dev` twice → RX/TX deltas
- Services: `systemctl list-units --type=service --no-legend`
- Processes: `ps -eo pid,ppid,comm,%cpu,%mem --sort=-%cpu | head -50`

Missing file/command → field `null` → UI "not reported". Never estimate.

## Actions (sudo)

- `sudo -n systemctl restart <unit>` / `stop` / `start`
- `sudo -n reboot` / `sudo -n poweroff`
- Requires passwordless sudo. Inline confirm; power needs typed hostname.

## Tests

`server-control.test.ts` — deltas, blank-on-missing, injection rejection, `sudo -n` behaviour.
