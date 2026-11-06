/**
 * Read a small text file from the server for a DevOps tool.
 *
 * SFTP is used when the session offers it (no shell command runs); otherwise,
 * or when the SFTP subsystem itself fails, the file is read with the `cat`
 * command the tool previews. A missing or unreadable file is reported as such,
 * never as empty content.
 */
import type { WorkspaceRemoteSession } from '../../../session/adapters.js';
import { EVIDENCE_LIMIT, isPermissionDenied, posixQuote, runEvidence } from '../../exec.js';
import type { CommandEvidence } from '../../types.js';

export type RemoteTextRead =
  | { ok: true; text: string; evidence: CommandEvidence[] }
  | { ok: false; error: string; missing: boolean; denied: boolean; evidence: CommandEvidence[] };

export function catCommand(path: string): string {
  return `cat -- ${posixQuote(path.trim())}`;
}

const MISSING = /no such file|does not exist|not found/i;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sftpEvidence(path: string, exitCode: number, stdout: string, stderr: string, started: number): CommandEvidence {
  return {
    command: `SFTP read ${path}`,
    exitCode,
    stdout: stdout.slice(0, EVIDENCE_LIMIT),
    stderr,
    truncated: stdout.length > EVIDENCE_LIMIT,
    durationMs: Date.now() - started
  };
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export async function readRemoteText(
  session: WorkspaceRemoteSession,
  rawPath: string,
  maxBytes: number
): Promise<RemoteTextRead> {
  const path = rawPath.trim();
  const evidence: CommandEvidence[] = [];
  const tooLarge = (text: string): RemoteTextRead | null =>
    utf8Bytes(text) > maxBytes
      ? {
          ok: false,
          error: `${path} is larger than ${Math.round(maxBytes / 1024)} KiB; refusing to work on a partial copy`,
          missing: false,
          denied: false,
          evidence
        }
      : null;

  if (session.readFile) {
    const started = Date.now();
    try {
      const text = await session.readFile(path);
      evidence.push(sftpEvidence(path, 0, text, '', started));
      return tooLarge(text) ?? { ok: true, text, evidence };
    } catch (err) {
      const message = errorText(err);
      evidence.push(sftpEvidence(path, 1, '', message, started));
      if (/not valid UTF-8/i.test(message)) {
        return { ok: false, error: `${path} is not a UTF-8 text file`, missing: false, denied: false, evidence };
      }
      const missing = MISSING.test(message);
      const denied = isPermissionDenied(message);
      // A real answer about the file is final; a broken SFTP channel falls back to cat.
      if (missing || denied) return { ok: false, error: message, missing, denied, evidence };
    }
  }

  const read = await runEvidence(session, catCommand(path));
  evidence.push(read.evidence);
  if (read.exitCode !== 0) {
    const message = (read.stderr || read.stdout).trim() || `cat exited with ${read.exitCode}`;
    return { ok: false, error: message, missing: MISSING.test(message), denied: isPermissionDenied(message), evidence };
  }
  // The transport decodes stdout as UTF-8; replacement characters mean the bytes were not text.
  if (read.stdout.includes('\u0000') || read.stdout.includes('\uFFFD')) {
    return { ok: false, error: `${path} is not a UTF-8 text file`, missing: false, denied: false, evidence };
  }
  return tooLarge(read.stdout) ?? { ok: true, text: read.stdout, evidence };
}
