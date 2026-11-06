/**
 * Commands the live log streamer can follow. Every input is validated and then
 * passed to the shell only through `posixQuote`, so a name cannot smuggle in a
 * second command or an extra flag.
 */
import { posixQuote, validateObjectName, validateRemotePath } from '../exec.js';

export type LogSourceKind = 'file' | 'unit' | 'container' | 'pod';

export interface LogSourceInput {
  kind: LogSourceKind;
  path?: string;
  unit?: string;
  container?: string;
  pod?: string;
  namespace?: string;
  /** Container inside the pod; optional. */
  podContainer?: string;
}

export type LogSourceField = 'path' | 'unit' | 'container' | 'pod' | 'namespace' | 'podContainer';

export type LogCommand =
  | { ok: true; command: string }
  | { ok: false; errors: Partial<Record<LogSourceField, string>> };

/** Lines of history each source prints before following. */
export const LOG_TAIL_LINES = 200;

export const LOG_SOURCE_LABELS: Record<LogSourceKind, string> = {
  file: 'File',
  unit: 'systemd unit',
  container: 'Docker container',
  pod: 'Kubernetes pod'
};

export function buildLogCommand(input: LogSourceInput): LogCommand {
  const errors: Partial<Record<LogSourceField, string>> = {};
  const value = (field: LogSourceField, validate: (v: string) => string | null, optional = false): string => {
    const v = (input[field] ?? '').trim();
    if (optional && v === '') return '';
    const error = validate(v);
    if (error) errors[field] = error;
    return v;
  };

  const parts: string[] = [];
  switch (input.kind) {
    case 'file':
      parts.push(value('path', validateRemotePath));
      break;
    case 'unit':
      parts.push(value('unit', validateObjectName));
      break;
    case 'container':
      parts.push(value('container', validateObjectName));
      break;
    case 'pod':
      parts.push(
        value('pod', validateObjectName),
        value('namespace', validateObjectName, true),
        value('podContainer', validateObjectName, true)
      );
      break;
  }
  // Quote only after validation: posixQuote refuses NUL, which the validators report.
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const [first = '', namespace = '', container = ''] = parts;
  switch (input.kind) {
    case 'file':
      return { ok: true, command: `tail -n ${LOG_TAIL_LINES} -F ${posixQuote(first)}` };
    case 'unit':
      return { ok: true, command: `journalctl -n ${LOG_TAIL_LINES} -f -u ${posixQuote(first)} --no-pager` };
    case 'container':
      return { ok: true, command: `docker logs -n ${LOG_TAIL_LINES} -f ${posixQuote(first)}` };
    case 'pod': {
      let command = `kubectl logs --tail=${LOG_TAIL_LINES} -f ${posixQuote(first)}`;
      if (namespace) command += ` -n ${posixQuote(namespace)}`;
      if (container) command += ` -c ${posixQuote(container)}`;
      return { ok: true, command };
    }
  }
}
