import { validateEnvVars, type EnvReport } from '@webssh/protocol';

/** Validated copy of the requested environment, or undefined when there is nothing to send. */
export function prepareSessionEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env || Object.keys(env).length === 0) return undefined;
  const errors = validateEnvVars(env);
  if (errors.length > 0) {
    throw new Error(`invalid_env: ${errors.map((error) => error.message).join('; ')}`);
  }
  return { ...env };
}

export interface EnvOutcome {
  accepted: string[];
  rejected: string[];
  /** Requested names the server gave no verdict for; never shown as accepted. */
  notReported: string[];
}

export function classifyEnvReport(
  requested: Record<string, string> | undefined,
  report: EnvReport | null | undefined
): EnvOutcome {
  const accepted = new Set(report?.envAccepted ?? []);
  const rejected = new Set(report?.envRejected ?? []);
  const outcome: EnvOutcome = { accepted: [], rejected: [], notReported: [] };
  for (const name of Object.keys(requested ?? {})) {
    if (accepted.has(name)) outcome.accepted.push(name);
    else if (rejected.has(name)) outcome.rejected.push(name);
    else outcome.notReported.push(name);
  }
  return outcome;
}
