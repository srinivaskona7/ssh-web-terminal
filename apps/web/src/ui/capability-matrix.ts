/**
 * Honest capability matrix shown in the workspace.
 *
 * `verified` means a unit or integration test in this repository exercises the
 * behaviour. `implemented` means the code path exists but has not been proven
 * against a real server in this build. `conditional` needs a prerequisite the
 * UI cannot supply (the Go gateway, passwordless sudo, a package, a cluster).
 * `unsupported` is deliberate: the product does not attempt it.
 */
export type CapabilityStatus = 'verified' | 'implemented' | 'conditional' | 'unsupported';

export interface CapabilityEntry {
  id: string;
  name: string;
  category:
    | 'Connection & identity'
    | 'Terminal'
    | 'Files & editor'
    | 'Discovery & install'
    | 'Operations'
    | 'Automation & delivery';
  status: CapabilityStatus;
  detail: string;
  /** What the user must have or do for this to work. */
  requires?: string;
}

export const CAPABILITY_MATRIX: readonly CapabilityEntry[] = [
  {
    id: 'relay-ssh',
    name: 'Browser SSH over the Cloudflare relay',
    category: 'Connection & identity',
    status: 'verified',
    detail: 'RFC 4253 transport, key exchange and channels are covered by the browser SSH tests.'
  },
  {
    id: 'gateway-ssh',
    name: 'Go gateway WebSocket bridge',
    category: 'Connection & identity',
    status: 'implemented',
    detail: 'Frame multiplexing and control messages are implemented in apps/gateway.',
    requires: 'A running gateway endpoint (the relay path does not need one).'
  },
  {
    id: 'host-keys',
    name: 'Host key pinning and mismatch blocking',
    category: 'Connection & identity',
    status: 'verified',
    detail: 'Trust-on-first-use fingerprints are stored and a changed key blocks the connection.',
    requires: 'The first connection decides the pinned fingerprint.'
  },
  {
    id: 'vault',
    name: 'Non-extractable key vault',
    category: 'Connection & identity',
    status: 'verified',
    detail: 'Keys are generated with WebCrypto and stay in IndexedDB; only public data leaves the browser.',
    requires: 'A browser with WebCrypto and IndexedDB.'
  },
  {
    id: 'sftp-files',
    name: 'SFTP file browser and transfers',
    category: 'Files & editor',
    status: 'verified',
    detail: 'Binary-safe reads, atomic writes, resumable uploads and listing have unit coverage.',
    requires: 'The SSH server must enable the SFTP subsystem.'
  },
  {
    id: 'editor',
    name: 'Remote file editor with atomic save',
    category: 'Files & editor',
    status: 'implemented',
    detail: 'Writes go through SFTP to a temporary file and rename, never through the shell.',
    requires: 'SFTP subsystem.'
  },
  {
    id: 'terminal',
    name: 'Terminal, tabs and split panes',
    category: 'Terminal',
    status: 'implemented',
    detail: 'xterm.js renders the PTY; tabs and split panes share the active session.',
    requires: 'A connected PTY channel.'
  },
  {
    id: 'discovery',
    name: 'Read-only server discovery',
    category: 'Discovery & install',
    status: 'verified',
    detail: 'Capabilities are parsed from one static script; nothing is installed or modified.',
    requires: 'Shell access for the connected user.'
  },
  {
    id: 'recipes',
    name: 'Versioned install recipes with preflight',
    category: 'Discovery & install',
    status: 'verified',
    detail: 'Recipe validation, plan building and shell-escaping are unit tested.',
    requires: 'A package manager the recipe supports and enough disk/RAM.'
  },
  {
    id: 'jobs',
    name: 'Durable detached jobs',
    category: 'Discovery & install',
    status: 'verified',
    detail: 'Jobs keep running when the browser closes and can be reattached from Activity.',
    requires: '`setsid`/`nohup` on the target (standard on Linux).'
  },
  {
    id: 'docker',
    name: 'Docker containers, images and Compose',
    category: 'Operations',
    status: 'implemented',
    detail: 'Reads Docker JSON output and limits actions to reviewed start/stop/restart.',
    requires: 'The docker CLI and permission to use the daemon socket.'
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes contexts, pods and logs',
    category: 'Operations',
    status: 'implemented',
    detail: 'Uses the kubeconfig the server already has; Secrets are never read into the UI.',
    requires: 'kubectl configured for the connected user and cluster permissions.'
  },
  {
    id: 'control',
    name: 'Live metrics, processes and services',
    category: 'Operations',
    status: 'verified',
    detail: 'CPU/network deltas and process/service parsing are unit tested; missing probes stay blank.',
    requires: '`/proc`, `ps` and `systemctl` for the full picture.'
  },
  {
    id: 'service-actions',
    name: 'Service restart/stop and power actions',
    category: 'Operations',
    status: 'conditional',
    detail: 'Commands run with `sudo -n` and fail fast with the privilege error instead of prompting.',
    requires: 'Passwordless sudo for the connected user.'
  },
  {
    id: 'git',
    name: 'Git status, diff, stage and commit',
    category: 'Automation & delivery',
    status: 'implemented',
    detail: 'Commands are run with `git -C`; refs and directories are validated before use.',
    requires: 'git installed and the directory inside a work tree.'
  },
  {
    id: 'deploy',
    name: 'Reviewed project deployment',
    category: 'Automation & delivery',
    status: 'implemented',
    detail: 'A plan is shown before execution; the deployment runs as a durable job.',
    requires: 'A recognised project manifest and any runtime it needs.'
  },
  {
    id: 'python',
    name: 'Python environments and managed cron entries',
    category: 'Automation & delivery',
    status: 'implemented',
    detail: 'Only workspace-marked cron lines are touched; unrelated crontab entries are preserved.',
    requires: 'python3 and a crontab for the connected user.'
  },
  {
    id: 'no-billing',
    name: 'No payments, subscriptions or feature paywalls',
    category: 'Connection & identity',
    status: 'verified',
    detail: 'There is no billing code, pricing tier or entitlement check anywhere in the product.'
  },
  {
    id: 'anonymous-proxy',
    name: 'Anonymous public TCP proxy',
    category: 'Connection & identity',
    status: 'unsupported',
    detail: 'Every connection requires authentication, origin checks and destination validation.'
  }
];

export function capabilityCounts(entries: readonly CapabilityEntry[] = CAPABILITY_MATRIX): Record<CapabilityStatus, number> {
  const counts: Record<CapabilityStatus, number> = {
    verified: 0,
    implemented: 0,
    conditional: 0,
    unsupported: 0
  };
  for (const entry of entries) counts[entry.status] += 1;
  return counts;
}
