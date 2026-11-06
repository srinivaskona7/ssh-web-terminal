import { DEFAULT_BLOB_DOWNLOAD_CAP_BYTES } from './transfer-engine';
import { base64ToBytes, bytesToBase64 } from '../vault/ssh-wire';

export interface SftpReply {
  ok: boolean;
  error?: string;
  dataBase64?: string;
  size?: number;
  offset?: number;
}

export type SftpOp = (op: Record<string, unknown>) => Promise<SftpReply>;

/**
 * The Go gateway answers one `read_file` with at most this many bytes and
 * reports the file's full size, so a single call silently truncates anything
 * larger.
 */
export const REMOTE_READ_PAGE_BYTES = 256 * 1024;

/**
 * Above this, base64 plus JSON no longer fit a single 4 MiB control frame.
 * 3 MiB of raw bytes encodes to exactly 4 MiB, so leave headroom for the frame
 * envelope and the path rather than sending a payload the encoder rejects.
 */
export const REMOTE_INLINE_WRITE_BYTES = 3 * 1024 * 1024 - 4 * 1024;

/** Page size used for chunked uploads. */
export const REMOTE_WRITE_CHUNK_BYTES = 256 * 1024;

/**
 * Read a whole remote file. Returns the complete bytes or an error; it never
 * returns a short read, because a save would write that back over the file.
 */
export async function readRemoteFile(
  sftpOp: SftpOp,
  remotePath: string,
  capBytes = DEFAULT_BLOB_DOWNLOAD_CAP_BYTES
): Promise<{ bytes: Uint8Array } | { error: string }> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let total: number | null = null;
  // 4096 pages is 1 GiB; the cap check below rejects anything larger first.
  for (let attempt = 0; attempt < 4096; attempt += 1) {
    const res = await sftpOp({
      op: 'read_file',
      path: remotePath,
      ...(offset > 0 ? { offset } : {})
    });
    if (!res.ok) {
      return { error: res.error ?? `Could not read ${remotePath}` };
    }
    if (total === null && typeof res.size === 'number') {
      total = res.size;
      if (total > capBytes) {
        return {
          error: `${remotePath} is ${total} bytes, above the ${capBytes}-byte browser cap; it was not opened.`
        };
      }
    }
    const chunk = res.dataBase64 ? base64ToBytes(res.dataBase64) : new Uint8Array(0);
    if (chunk.byteLength === 0) break;
    parts.push(chunk);
    // The gateway reports the next position; a gateway that stops advancing
    // would otherwise be polled 4096 times for the same bytes.
    const nextOffset = typeof res.offset === 'number' ? res.offset : offset + chunk.byteLength;
    if (nextOffset <= offset) {
      return { error: `${remotePath} stopped advancing at byte ${offset}; nothing was loaded.` };
    }
    offset = nextOffset;
    if (total !== null && offset >= total) break;
  }
  if (total !== null && offset < total) {
    return { error: `${remotePath} returned ${offset} of ${total} bytes; nothing was loaded.` };
  }
  const merged = new Uint8Array(offset);
  let pos = 0;
  for (const part of parts) {
    merged.set(part, pos);
    pos += part.byteLength;
  }
  return { bytes: merged };
}

/**
 * Write bytes over SFTP. Small files go in one `write_file`; larger ones are
 * staged with `upload_init` / `upload_chunk` / `upload_commit` so no single
 * frame crosses the gateway's 4 MiB ceiling.
 *
 * Returns null on success, an error message otherwise.
 */
export async function writeRemoteFile(
  sftpOp: SftpOp,
  remotePath: string,
  bytes: Uint8Array
): Promise<string | null> {
  if (bytes.byteLength <= REMOTE_INLINE_WRITE_BYTES) {
    const res = await sftpOp({
      op: 'write_file',
      path: remotePath,
      dataBase64: bytesToBase64(bytes)
    });
    return res.ok ? null : (res.error ?? 'Unknown error');
  }
  await sftpOp({ op: 'remove', path: `${remotePath}.part` }).catch(() => undefined);
  await sftpOp({ op: 'remove', path: `${remotePath}.webssh-part` }).catch(() => undefined);
  const init = await sftpOp({ op: 'upload_init', path: remotePath });
  if (!init.ok) return init.error ?? 'Could not start the upload';
  let offset = typeof init.offset === 'number' ? init.offset : 0;
  if (offset !== 0) {
    return `${remotePath}.part already holds ${offset} bytes; refusing to overwrite it.`;
  }
  while (offset < bytes.byteLength) {
    const slice = bytes.subarray(
      offset,
      Math.min(offset + REMOTE_WRITE_CHUNK_BYTES, bytes.byteLength)
    );
    const chunk = await sftpOp({
      op: 'upload_chunk',
      path: remotePath,
      offset,
      size: slice.byteLength,
      dataBase64: bytesToBase64(slice)
    });
    if (!chunk.ok) return chunk.error ?? 'Chunk rejected';
    offset =
      typeof chunk.offset === 'number' && chunk.offset > offset
        ? chunk.offset
        : offset + slice.byteLength;
  }
  const commit = await sftpOp({ op: 'upload_commit', path: remotePath });
  return commit.ok ? null : (commit.error ?? 'Could not finish the upload');
}
