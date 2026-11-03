/**
 * Normalise the two transports (browser SSH over the Cloudflare relay, and the
 * Go gateway) into the single `RemoteSession` contract used by the workspace
 * modules (discovery, recipes, containers, Kubernetes, automation).
 */
import type { RemoteExecOptions, RemoteExecResult, RemoteSession } from './remote-session.js';

/** The subset of the relay client this adapter needs. */
export interface RelayLikeClient {
  execStream?(
    command: string,
    options?: RemoteExecOptions
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  execCommand(
    command: string,
    timeoutMs?: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  sftpOp?(op: Record<string, unknown>): Promise<{
    ok: boolean;
    error?: string;
    dataBase64?: string;
    size?: number;
  }>;
  isConnected?: boolean;
  getSftpClient?(): Promise<unknown>;
}

export interface AdapterOptions {
  transport: 'cloudflare-relay' | 'go-gateway';
  host: string;
  user: string;
  port: number;
  isConnected?: () => boolean;
}

export interface WorkspaceRemoteSession extends RemoteSession {
  /** Write a file through SFTP; absent when the transport cannot do it. */
  writeFile?(path: string, data: Uint8Array): Promise<void>;
  /** Probe the SFTP subsystem without performing an operation. */
  probeSftp?(): Promise<boolean>;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function createRemoteSession(
  client: RelayLikeClient,
  options: AdapterOptions
): WorkspaceRemoteSession {
  const exec = async (
    command: string,
    execOptions: RemoteExecOptions = {}
  ): Promise<RemoteExecResult> => {
    if (client.execStream) {
      const result = await client.execStream(command, execOptions);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    }
    const result = await client.execCommand(command, execOptions.timeoutMs ?? 120_000);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  };

  const session: WorkspaceRemoteSession = {
    transport: options.transport,
    host: options.host,
    user: options.user,
    port: options.port,
    isConnected: () => options.isConnected?.() ?? true,
    exec
  };

  if (client.sftpOp) {
    const sftpOp = client.sftpOp.bind(client);
    session.writeFile = async (path, data) => {
      const result = await sftpOp({ op: 'write_file', path, dataBase64: toBase64(data) });
      if (!result.ok) throw new Error(result.error ?? `Could not write ${path}`);
    };
    session.probeSftp = async () => {
      try {
        const result = await sftpOp({ op: 'stat', path: '.' });
        return result.ok;
      } catch {
        return false;
      }
    };
  } else if (client.getSftpClient) {
    session.probeSftp = async () => {
      try {
        await client.getSftpClient!();
        return true;
      } catch {
        return false;
      }
    };
  }

  return session;
}
