/**
 * Helpers every DevOps tool uses to run commands and shape results.
 *
 * Inputs become shell text only through `posixQuote`, after a validator has
 * accepted them. Raw command output is kept as evidence, cut to a fixed size so
 * a chatty probe cannot fill memory.
 */
import { posixQuote } from '../recipes/engine.js';
import type { WorkspaceRemoteSession } from '../session/adapters.js';
import type { CommandEvidence, Finding, ResultTable, ToolResult, ToolStatus } from './types.js';

export { posixQuote };

/** Characters of stdout/stderr kept per command as evidence. */
export const EVIDENCE_LIMIT = 64 * 1024;

/** Default per-command timeout for read-only probes. */
export const PROBE_TIMEOUT_MS = 30_000;

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= EVIDENCE_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, EVIDENCE_LIMIT), truncated: true };
}

/**
 * Run one command and keep its answer. Transport failures (disconnects,
 * timeouts) propagate as exceptions; a non-zero exit is data, not an error.
 * The full stdout is returned separately for parsing; only the evidence copy
 * is clipped.
 */
export async function runEvidence(
  session: WorkspaceRemoteSession,
  command: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<{ evidence: CommandEvidence; stdout: string; stderr: string; exitCode: number }> {
  const started = Date.now();
  const result = await session.exec(command, { timeoutMs });
  const out = clip(result.stdout);
  const err = clip(result.stderr);
  return {
    evidence: {
      command,
      exitCode: result.exitCode,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
      durationMs: Date.now() - started
    },
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode
  };
}

/**
 * Exit 127 (every POSIX shell) or "command not found" means the binary is not
 * installed. A missing *file* argument is a different answer and is not matched.
 */
export function isCommandMissing(exitCode: number, stderr: string): boolean {
  return exitCode === 127 || /command not found/i.test(stderr);
}

/** The probe ran but the account lacks the privilege to see everything. */
export function isPermissionDenied(stderr: string): boolean {
  return /permission denied|operation not permitted|must be root|are you root|requires root|a password is required|access denied/i.test(
    stderr
  );
}

export function makeResult(
  status: ToolStatus,
  summary: string,
  parts: {
    findings?: Finding[];
    tables?: ResultTable[];
    notes?: string[];
    evidence?: CommandEvidence[];
  } = {}
): ToolResult {
  return {
    status,
    summary,
    findings: parts.findings ?? [],
    tables: parts.tables ?? [],
    notes: parts.notes ?? [],
    evidence: parts.evidence ?? [],
    collectedAt: Date.now()
  };
}

// ---------------------------------------------------------------------------
// Input validators. Each returns an error message, or null when acceptable.
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validateHost(value: string): string | null {
  const v = value.trim();
  if (!v) return 'A host is required';
  if (v.length > 253) return 'Host is too long';
  // DNS names, IPv4, and bracket-free IPv6 literals.
  if (!/^[A-Za-z0-9.-]+$/.test(v) && !/^[0-9A-Fa-f:.]+$/.test(v)) return 'Host may contain letters, digits, dots, hyphens or an IP address';
  if (v.startsWith('-')) return 'Host must not start with a hyphen';
  return null;
}

export function validatePort(value: string): string | null {
  const v = value.trim();
  if (!/^\d{1,5}$/.test(v)) return 'Port must be a number';
  const n = Number(v);
  if (n < 1 || n > 65535) return 'Port must be between 1 and 65535';
  return null;
}

export function validateRemotePath(value: string): string | null {
  const v = value.trim();
  if (!v) return 'A path is required';
  if (CONTROL_CHARS.test(v)) return 'Path contains control characters';
  if (v.length > 1024) return 'Path is too long';
  if (v.startsWith('-')) return 'Path must not start with a hyphen';
  return null;
}

export function validateHttpUrl(value: string): string | null {
  const v = value.trim();
  if (!v) return 'A URL is required';
  if (CONTROL_CHARS.test(v) || /\s/.test(v)) return 'URL must not contain spaces or control characters';
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return 'Not a valid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Only http and https URLs can be probed';
  return null;
}

/** systemd unit, container, pod, namespace and similar object names. */
export function validateObjectName(value: string): string | null {
  const v = value.trim();
  if (!v) return 'A name is required';
  if (v.length > 253) return 'Name is too long';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@:\/-]*$/.test(v)) return 'Name may contain letters, digits and . _ - @ : /';
  return null;
}

export function validateIntInRange(value: string, min: number, max: number): string | null {
  const v = value.trim();
  if (!/^\d+$/.test(v)) return 'Must be a whole number';
  const n = Number(v);
  if (n < min || n > max) return `Must be between ${min} and ${max}`;
  return null;
}
