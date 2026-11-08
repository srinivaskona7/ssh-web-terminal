/**
 * Normalise the two transports (browser SSH over the Cloudflare relay, and the
 * Go gateway) into the single `RemoteSession` contract used by the workspace
 * modules (discovery, recipes, containers, Kubernetes, automation).
 */
import type { RemoteExecOptions, RemoteExecResult, RemoteSession } from './remote-session.js';
import { readRemoteFile, REMOTE_INLINE_WRITE_BYTES } from '../files/remote-file-io.js';

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
    offset?: number;
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
  /** Read a file through SFTP as text; absent when the transport cannot do it. */
  readFile?(path: string): Promise<string>;
  /** Read a file through SFTP as raw bytes (used for image preview). */
  readFileBytes?(path: string): Promise<Uint8Array>;
  /** List a directory through SFTP; absent when the transport cannot do it. */
  listDir?(path: string): Promise<SftpEntryInfo[]>;
  /** Rename or move a path through SFTP. */
  renamePath?(from: string, to: string): Promise<void>;
  /** Delete a single file through SFTP. Never used on directories. */
  removePath?(path: string): Promise<void>;
  /** Create a directory through SFTP. */
  makeDir?(path: string): Promise<void>;
  /** Probe the SFTP subsystem without performing an operation. */
  probeSftp?(): Promise<boolean>;
  /** Streaming exec, exposed for recipe verification. Absent on plain execCommand clients. */
  execStream?(command: string, options?: RemoteExecOptions): Promise<RemoteExecResult>;
}

/** The entry fields the in-app IDE needs; extra transport fields are ignored. */
export interface SftpEntryInfo {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modTime: number;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function bytesFromBinary(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decode file bytes as UTF-8 and refuse anything that is not valid text. A
 * lossy decode would turn every invalid byte into U+FFFD, and the editor would
 * then write that corruption back on the next save.
 */
export function decodeUtf8Text(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path} is not valid UTF-8 text; refusing to open it in the editor`);
  }
}

/**
 * One canonical child path for both transports. A listing of "." returns bare
 * names from both servers; keeping them bare while other code builds "./name"
 * would open the same file in two tabs that conflict-refuse each other.
 */
function joinRemotePath(base: string, name: string): string {
  if (name.startsWith('/')) return name;
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.length === 0 ? `/${name}` : `${trimmed}/${name}`;
}


export function createRemoteSession(
  client: RelayLikeClient,
  options: AdapterOptions
): WorkspaceRemoteSession {
  const exec = async (
    command: string,
    execOptions: RemoteExecOptions = {}
  ): Promise<RemoteExecResult> => {
    // The Go gateway encodes exitCode with `omitempty`, so a successful command
    // arrives without the field. Missing means zero, not undefined.
    const exitCodeOf = (code: unknown): number => (typeof code === 'number' ? code : 0);
    // The gateway's buffered exec_command stays the default there; a stream is used when the
    // caller needs live output, cancellation or no retention. The relay only streams.
    const wantsStream =
      options.transport === 'cloudflare-relay' ||
      Boolean(execOptions.onStdout || execOptions.onStderr || execOptions.signal) ||
      execOptions.retainOutput === false;
    if (client.execStream && wantsStream) {
      const streamOptions =
        options.transport === 'cloudflare-relay'
          ? { ...execOptions, timeoutMs: execOptions.timeoutMs ?? 30 * 60_000 }
          : execOptions;
      const result = await client.execStream(command, streamOptions);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: exitCodeOf(result.exitCode)
      };
    }
    const result = await client.execCommand(command, execOptions.timeoutMs ?? 120_000);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: exitCodeOf(result.exitCode)
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

  if (client.execStream) {
    const execStream = client.execStream.bind(client);
    session.execStream = async (command, execOptions) => {
      const result = await execStream(command, execOptions);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : 0
      };
    };
  }

  if (client.sftpOp) {
    const sftpOp = client.sftpOp.bind(client);
    // A single write_file frame carries the whole base64 file. The Go gateway
    // rejects WebSocket frames over 4 MiB and closes the session, so larger
    // buffers must go through the chunked upload ops both transports expose.
    const CHUNKED_WRITE_THRESHOLD = REMOTE_INLINE_WRITE_BYTES;
    const WRITE_CHUNK_BYTES = 256 * 1024;
    const chunkedWrite = async (path: string, data: Uint8Array): Promise<void> => {
      // Drop any stale part file first; upload_init would otherwise resume from
      // its length and leave that tail in the committed file.
      await sftpOp({ op: 'remove', path: `${path}.part` }).catch(() => undefined);
      await sftpOp({ op: 'remove', path: `${path}.webssh-part` }).catch(() => undefined);
      const init = await sftpOp({ op: 'upload_init', path });
      if (!init.ok) throw new Error(init.error ?? `Could not start writing ${path}`);
      let offset = typeof init.offset === 'number' ? init.offset : 0;
      if (offset !== 0) {
        throw new Error(
          `Could not start a clean upload for ${path} (resumed at ${offset} bytes); refusing to write a corrupt file`
        );
      }
      while (offset < data.byteLength) {
        const chunk = data.subarray(offset, Math.min(offset + WRITE_CHUNK_BYTES, data.byteLength));
        const result = await sftpOp({
          op: 'upload_chunk',
          path,
          offset,
          size: chunk.byteLength,
          dataBase64: toBase64(chunk)
        });
        if (!result.ok) throw new Error(result.error ?? `Could not write ${path}`);
        offset =
          typeof result.offset === 'number' && result.offset > offset
            ? result.offset
            : offset + chunk.byteLength;
      }
      const commit = await sftpOp({ op: 'upload_commit', path });
      if (!commit.ok) throw new Error(commit.error ?? `Could not finish writing ${path}`);
    };
    session.readFileBytes = async (path) => {
      const read = await readRemoteFile(sftpOp, path);
      if ('error' in read) throw new Error(read.error);
      return read.bytes;
    };
    session.writeFile = async (path, data) => {
      if (!session.isConnected()) throw new Error('Disconnected — file write refused. Reconnect to proceed.');
      if (data.byteLength > CHUNKED_WRITE_THRESHOLD) {
        await chunkedWrite(path, data);
        return;
      }
      const result = await sftpOp({ op: 'write_file', path, dataBase64: toBase64(data) });
      if (!result.ok) throw new Error(result.error ?? `Could not write ${path}`);
    };
    session.readFile = async (path) => {
      // The relay returns the whole file in one reply, while the Go gateway
      // reads at most one chunk per call (256 KiB by default) and reports the
      // full size plus the next offset. Page until the whole file is in hand:
      // stopping early and writing the partial buffer back would truncate the
      // file on the server.
      let binary = '';
      let offset = 0;
      let total: number | null = null;
      for (let attempt = 0; attempt < 512; attempt++) {
        const result = await sftpOp({
          op: 'read_file',
          path,
          ...(offset > 0 ? { offset } : {})
        });
        if (!result.ok) throw new Error(result.error ?? `Could not read ${path}`);
        const chunk = result.dataBase64 ? atob(result.dataBase64) : '';
        if (total === null && typeof result.size === 'number') total = result.size;
        binary += chunk;
        if (total !== null && binary.length >= total) break;
        if (chunk.length === 0) break;
        const next =
          typeof result.offset === 'number' && result.offset > offset
            ? result.offset
            : offset + chunk.length;
        if (next <= offset) break;
        offset = next;
      }
      if (total !== null && binary.length < total) {
        throw new Error(
          `Read only ${binary.length} of ${total} bytes from ${path}; refusing to open a partial file`
        );
      }
      return decodeUtf8Text(bytesFromBinary(binary), path);
    };
    session.listDir = async (path) => {
      const result = (await sftpOp({ op: 'list', path })) as {
        ok: boolean;
        error?: string;
        entries?: Array<Partial<SftpEntryInfo> & { name?: string; path?: string }>;
      };
      if (!result.ok) throw new Error(result.error ?? `Could not list ${path}`);
      return (result.entries ?? [])
        .filter((entry) => typeof entry.name === 'string' && entry.name.length > 0)
        .map((entry) => ({
          name: entry.name as string,
          path: joinRemotePath(path, entry.name as string),
          isDir: Boolean(entry.isDir),
          isSymlink: Boolean(entry.isSymlink),
          size: typeof entry.size === 'number' ? entry.size : 0,
          modTime: typeof entry.modTime === 'number' ? entry.modTime : 0
        }));
    };
    session.renamePath = async (from, to) => {
      const result = await sftpOp({ op: 'rename', path: from, targetPath: to });
      if (!result.ok) throw new Error(result.error ?? `Could not rename ${from}`);
    };
    session.removePath = async (path) => {
      const result = await sftpOp({ op: 'remove', path });
      if (!result.ok) throw new Error(result.error ?? `Could not remove ${path}`);
    };
    session.makeDir = async (path) => {
      const result = await sftpOp({ op: 'mkdir', path });
      if (!result.ok) throw new Error(result.error ?? `Could not create ${path}`);
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
