/**
 * Shared contract for the DevOps hub tools.
 *
 * Each tool builds its commands from validated input, runs them through the
 * transport-neutral session, and returns one uniform result shape that the hub
 * renders. Nothing is invented: a probe that cannot run says why, and a value
 * the server did not report is `null`, which the hub renders as "not reported".
 */
import type { WorkspaceRemoteSession } from '../session/adapters.js';

export type DevOpsGroupId = 'network' | 'security' | 'system' | 'delivery' | 'operations';

export interface DevOpsGroup {
  id: DevOpsGroupId;
  title: string;
  description: string;
}

export const DEVOPS_GROUPS: readonly DevOpsGroup[] = [
  { id: 'network', title: 'Network', description: 'Listeners, routes, reachability and certificates.' },
  { id: 'security', title: 'Security', description: 'Keys, SSH daemon policy, firewall and accounts.' },
  { id: 'system', title: 'System', description: 'Disks, processes, failing units and schedules.' },
  { id: 'delivery', title: 'Delivery', description: 'Updates, images and workload posture.' },
  { id: 'operations', title: 'Operations', description: 'Runbooks, incidents, probes and drift.' }
];

export type FindingSeverity = 'critical' | 'warning' | 'info' | 'ok';

export interface Finding {
  severity: FindingSeverity;
  title: string;
  detail?: string;
  /** Where the evidence came from, e.g. "/etc/ssh/sshd_config:14" or "pod default/web-1". */
  subject?: string;
}

export interface ResultColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

/** `null` cells render as "not reported"; never substitute a guess. */
export type ResultCell = string | number | null;

export interface ResultTable {
  id: string;
  title: string;
  columns: ResultColumn[];
  rows: Record<string, ResultCell>[];
}

/** One command the tool actually ran, kept so the user can see the raw answer. */
export interface CommandEvidence {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when stdout or stderr was cut to `EVIDENCE_LIMIT` characters. */
  truncated: boolean;
  durationMs: number;
}

/**
 * - `ok`: every probe ran and answered.
 * - `partial`: some data is missing (usually needs root); the notes say which.
 * - `unavailable`: the required binary or subsystem is not on the server.
 * - `error`: the probe failed for another reason; the summary carries it.
 */
export type ToolStatus = 'ok' | 'partial' | 'unavailable' | 'error';

export interface ToolResult {
  status: ToolStatus;
  summary: string;
  findings: Finding[];
  tables: ResultTable[];
  notes: string[];
  evidence: CommandEvidence[];
  collectedAt: number;
}

export interface ToolInputField {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  multiline?: boolean;
  /** Return an error message, or null when the value is acceptable. */
  validate?: (value: string) => string | null;
}

export type ToolInput = Record<string, string>;

export interface DevOpsTool {
  id: string;
  group: DevOpsGroupId;
  title: string;
  description: string;
  /** Binaries the tool needs on the server, listed before it runs. */
  requires: string[];
  /** Some data needs root; without it the result is `partial`, never padded. */
  rootForFullData?: boolean;
  inputs?: ToolInputField[];
  /** The exact commands `run` will execute for this input, shown before Run. */
  preview(input: ToolInput): string[];
  run(session: WorkspaceRemoteSession, input: ToolInput): Promise<ToolResult>;
  /** `custom` tools render their own panel (runbooks, drift, log streaming). */
  panel?: 'generic' | 'custom';
}
