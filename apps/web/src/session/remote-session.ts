/**
 * Common surface every transport offers to the workspace modules.
 *
 * The Go gateway and the Cloudflare relay differ internally, but discovery,
 * recipes, jobs, Git, containers and Kubernetes only need this contract.
 */
export interface RemoteExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RemoteExecOptions {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Keep output for the resolved result (default true); set false for long log follows. */
  retainOutput?: boolean;
}

export interface RemoteSession {
  readonly transport: 'cloudflare-relay' | 'go-gateway';
  readonly host: string;
  readonly user: string;
  readonly port: number;
  isConnected(): boolean;
  exec(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult>;
}

/** Validate a working directory before it is embedded in a command. */
export function validateRemoteDirectory(dir: string): string {
  const cleaned = dir.trim();
  if (!cleaned) throw new Error('A working directory is required');
  if (/[\u0000-\u001f]/.test(cleaned)) throw new Error('Working directory contains control characters');
  if (cleaned.length > 1024) throw new Error('Working directory is too long');
  return cleaned;
}

/** Validate a ref/branch/tag name so it can be passed as a single argument. */
export function validateGitRef(ref: string): string {
  const cleaned = ref.trim();
  if (!cleaned) throw new Error('A Git reference is required');
  if (/[\s~^:?*[\\\u0000-\u001f]/.test(cleaned) || cleaned.startsWith('-')) {
    throw new Error(`Invalid Git reference "${ref}"`);
  }
  return cleaned;
}
