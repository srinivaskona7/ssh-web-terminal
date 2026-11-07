// Local-only transport diagnostics: ring buffer of error codes and timings.
// No network — stays in memory so it cannot leak to third parties.
export interface DiagnosticEvent {
  at: number;
  code: string;
  message: string;
  host?: string;
  port?: number;
}

const MAX = 200;
const events: DiagnosticEvent[] = [];

export function recordDiagnostic(code: string, message: string, extra?: { host?: string; port?: number }): void {
  events.push({ at: Date.now(), code, message: message.slice(0, 500), host: extra?.host, port: extra?.port });
  while (events.length > MAX) events.shift();
}

export function listDiagnostics(): DiagnosticEvent[] {
  return [...events];
}

export function clearDiagnostics(): void {
  events.length = 0;
}

export function diagnosticsSummary(): { total: number; byCode: Record<string, number> } {
  const byCode: Record<string, number> = {};
  for (const e of events) byCode[e.code] = (byCode[e.code] ?? 0) + 1;
  return { total: events.length, byCode };
}
