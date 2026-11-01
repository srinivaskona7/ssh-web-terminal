import type { ControlMessage, SftpDirEntry } from '@webssh/protocol';
import { IncrementalSha256 } from './sha256';
import { buildStreamingZipArchive, type ZipEntryInput } from './zip-stream';

export const DEFAULT_CHUNK_BYTES = 256 * 1024; // 256 KiB
export const HARD_MAX_CHUNK_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_IN_FLIGHT_BUFFER_BYTES = 32 * 1024 * 1024; // 32 MiB
export const HARD_MAX_IN_FLIGHT_BUFFER_BYTES = 128 * 1024 * 1024; // 128 MiB
export const DEFAULT_CONCURRENT_TRANSFERS = 3;
export const HARD_MAX_CONCURRENT_TRANSFERS = 6;
export const DEFAULT_LOCAL_STORAGE_CAP_BYTES = 256 * 1024 * 1024; // 256 MiB
export const DEFAULT_BLOB_DOWNLOAD_CAP_BYTES = 256 * 1024 * 1024; // 256 MiB
export const WARN_BLOB_DOWNLOAD_BYTES = 128 * 1024 * 1024; // 128 MiB
export const HARD_MAX_BLOB_DOWNLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB

export interface StorageQuotaSnapshot {
  usedBytes: number;
  capBytes: number;
  inFlightBytes: number;
  inFlightCapBytes: number;
  percentUsed: number;
}

export class StorageGuard {
  private usedBytes = 0;
  private inFlightBytes = 0;
  private capBytes: number;
  private inFlightCapBytes: number;

  constructor(
    capBytes: number = DEFAULT_LOCAL_STORAGE_CAP_BYTES,
    inFlightCapBytes: number = DEFAULT_IN_FLIGHT_BUFFER_BYTES
  ) {
    this.capBytes = Math.min(Math.max(1024 * 1024, capBytes), HARD_MAX_BLOB_DOWNLOAD_BYTES);
    this.inFlightCapBytes = Math.min(Math.max(DEFAULT_CHUNK_BYTES, inFlightCapBytes), HARD_MAX_IN_FLIGHT_BUFFER_BYTES);
  }

  async syncWithBrowserQuota(): Promise<StorageQuotaSnapshot> {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
      try {
        const est = await navigator.storage.estimate();
        if (typeof est.usage === 'number') {
          this.usedBytes = est.usage;
        }
        if (typeof est.quota === 'number' && est.quota > 0) {
          const halfQuota = Math.floor(est.quota * 0.5);
          this.capBytes = Math.min(this.capBytes, halfQuota);
        }
      } catch {
        // Ignore storage estimate failure in restricted environments
      }
    }
    return this.snapshot();
  }

  canAllocateStorage(bytes: number): boolean {
    return bytes >= 0 && this.usedBytes + bytes <= this.capBytes;
  }

  allocateStorage(bytes: number): void {
    if (!this.canAllocateStorage(bytes)) {
      throw new Error(`Storage quota exceeded: requesting ${bytes} bytes with ${this.usedBytes}/${this.capBytes} used`);
    }
    this.usedBytes += bytes;
  }

  releaseStorage(bytes: number): void {
    this.usedBytes = Math.max(0, this.usedBytes - Math.max(0, bytes));
  }

  canReserveInFlight(bytes: number): boolean {
    return bytes >= 0 && this.inFlightBytes + bytes <= this.inFlightCapBytes;
  }

  reserveInFlight(bytes: number): void {
    if (!this.canReserveInFlight(bytes)) {
      throw new Error(`In-flight transfer memory cap exceeded: requesting ${bytes} bytes`);
    }
    this.inFlightBytes += bytes;
  }

  releaseInFlight(bytes: number): void {
    this.inFlightBytes = Math.max(0, this.inFlightBytes - Math.max(0, bytes));
  }

  snapshot(): StorageQuotaSnapshot {
    return {
      usedBytes: this.usedBytes,
      capBytes: this.capBytes,
      inFlightBytes: this.inFlightBytes,
      inFlightCapBytes: this.inFlightCapBytes,
      percentUsed: this.capBytes > 0 ? Math.min(100, Math.round((this.usedBytes / this.capBytes) * 100)) : 100
    };
  }
}

export type TransferStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface TransferItem {
  id: string;
  direction: 'upload' | 'download';
  name: string;
  remotePath: string;
  totalBytes: number;
  transferredBytes: number;
  status: TransferStatus;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  sha256?: string;
  warning?: string;
  error?: string;
}

export type SftpRpcSender = (
  msg: Extract<ControlMessage, { type: 'sftp_op' }>
) => Promise<Extract<ControlMessage, { type: 'sftp_result' }>>;

export interface UploadSource {
  name: string;
  remotePath: string;
  size: number;
  sliceChunk: (offset: number, length: number) => Promise<Uint8Array>;
}

export interface FolderEntrySource extends UploadSource {
  relativePath: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export class TransferQueue {
  private readonly items = new Map<string, TransferItem>();
  private readonly sources = new Map<string, UploadSource>();
  private readonly guard: StorageGuard;
  private readonly rpc: SftpRpcSender;
  private readonly chunkSize: number;
  private maxConcurrency: number;
  private activeCount = 0;

  constructor(
    rpc: SftpRpcSender,
    guard: StorageGuard = new StorageGuard(),
    chunkSize: number = DEFAULT_CHUNK_BYTES,
    maxConcurrency: number = DEFAULT_CONCURRENT_TRANSFERS
  ) {
    this.rpc = rpc;
    this.guard = guard;
    this.chunkSize = Math.min(Math.max(1024, chunkSize), HARD_MAX_CHUNK_BYTES);
    this.maxConcurrency = Math.min(Math.max(1, maxConcurrency), HARD_MAX_CONCURRENT_TRANSFERS);
  }

  setMaxConcurrency(limit: number): void {
    this.maxConcurrency = Math.min(Math.max(1, limit), HARD_MAX_CONCURRENT_TRANSFERS);
  }

  list(): TransferItem[] {
    return Array.from(this.items.values());
  }

  get(id: string): TransferItem | undefined {
    return this.items.get(id);
  }

  enqueueUpload(source: UploadSource): TransferItem {
    const id = `xfer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const item: TransferItem = {
      id,
      direction: 'upload',
      name: source.name,
      remotePath: source.remotePath,
      totalBytes: source.size,
      transferredBytes: 0,
      status: 'queued',
      speedBytesPerSec: 0,
      etaSeconds: null
    };
    this.items.set(id, item);
    this.sources.set(id, source);
    return item;
  }

  pause(id: string): void {
    const item = this.items.get(id);
    if (item && (item.status === 'running' || item.status === 'queued')) {
      item.status = 'paused';
    }
  }

  cancel(id: string): void {
    const item = this.items.get(id);
    if (item) {
      item.status = 'cancelled';
    }
  }

  async runUpload(id: string): Promise<TransferItem> {
    const item = this.items.get(id);
    const source = this.sources.get(id);
    if (!item || !source) {
      throw new Error(`Unknown transfer id ${id}`);
    }
    if (this.activeCount >= this.maxConcurrency) {
      return item;
    }

    this.activeCount++;
    item.status = 'running';
    const startTime = Date.now();

    try {
      const initRes = await this.rpc({
        type: 'sftp_op',
        opId: `${id}-init`,
        op: 'upload_init',
        path: source.remotePath
      });
      if (!initRes.ok) {
        throw new Error(initRes.error ?? 'upload_init failed');
      }

      const resumeOffset = Math.min(source.size, Math.max(0, initRes.offset ?? 0));
      const fullHasher = new IncrementalSha256();

      // If resuming from an offset > 0, hash the preceding bytes incrementally so final commit SHA-256 matches
      let preOffset = 0;
      while (preOffset < resumeOffset) {
        const take = Math.min(this.chunkSize, resumeOffset - preOffset);
        const preChunk = await source.sliceChunk(preOffset, take);
        fullHasher.update(preChunk);
        preOffset += preChunk.byteLength;
      }

      let offset = resumeOffset;
      item.transferredBytes = offset;

      while (offset < source.size) {
        if (item.status !== 'running') {
          return item;
        }
        const length = Math.min(this.chunkSize, source.size - offset);
        this.guard.reserveInFlight(length);
        try {
          const chunk = await source.sliceChunk(offset, length);
          const chunkHasher = new IncrementalSha256();
          chunkHasher.update(chunk);
          const chunkSha = chunkHasher.digestHex();
          fullHasher.update(chunk);

          const chunkRes = await this.rpc({
            type: 'sftp_op',
            opId: `${id}-chunk-${offset}`,
            op: 'upload_chunk',
            path: source.remotePath,
            offset,
            size: chunk.byteLength,
            sha256: chunkSha,
            dataBase64: bytesToBase64(chunk)
          });
          if (!chunkRes.ok) {
            throw new Error(chunkRes.error ?? 'upload_chunk failed');
          }

          offset += chunk.byteLength;
          item.transferredBytes = offset;
          const elapsedSec = Math.max(0.001, (Date.now() - startTime) / 1000);
          item.speedBytesPerSec = Math.round((offset - resumeOffset) / elapsedSec);
          const remaining = source.size - offset;
          item.etaSeconds = item.speedBytesPerSec > 0 ? Math.ceil(remaining / item.speedBytesPerSec) : null;
        } finally {
          this.guard.releaseInFlight(length);
        }
      }

      const finalSha = fullHasher.digestHex();
      const commitRes = await this.rpc({
        type: 'sftp_op',
        opId: `${id}-commit`,
        op: 'upload_commit',
        path: source.remotePath,
        sha256: finalSha
      });
      if (!commitRes.ok) {
        throw new Error(commitRes.error ?? 'upload_commit failed');
      }

      item.sha256 = finalSha;
      item.status = 'completed';
      item.etaSeconds = 0;
      return item;
    } catch (err) {
      item.status = 'failed';
      item.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
  }

  async uploadFolder(baseRemoteDir: string, entries: FolderEntrySource[]): Promise<TransferItem[]> {
    const cleanBase = baseRemoteDir.replace(/\/+$/, '') || '/';
    const dirSet = new Set<string>();
    for (const entry of entries) {
      const rel = entry.relativePath.replace(/^\/+/, '');
      const parts = rel.split('/');
      parts.pop();
      let current = cleanBase;
      for (const part of parts) {
        if (!part) continue;
        current = `${current}/${part}`;
        dirSet.add(current);
      }
    }

    const sortedDirs = Array.from(dirSet).sort((a, b) => a.length - b.length);
    for (const dir of sortedDirs) {
      const res = await this.rpc({
        type: 'sftp_op',
        opId: `mkdir-${dir}`,
        op: 'mkdir',
        path: dir
      });
      if (!res.ok) {
        throw new Error(res.error ?? `Failed to mkdir ${dir}`);
      }
    }

    const completed: TransferItem[] = [];
    for (const entry of entries) {
      const rel = entry.relativePath.replace(/^\/+/, '');
      const queued = this.enqueueUpload({
        ...entry,
        remotePath: `${cleanBase}/${rel}`
      });
      completed.push(await this.runUpload(queued.id));
    }
    return completed;
  }

  async downloadFile(
    remotePath: string,
    writable?: { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void> }
  ): Promise<{ item: TransferItem; blobBytes?: Uint8Array }> {
    const name = remotePath.split('/').pop() || 'download.bin';
    const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const item: TransferItem = {
      id,
      direction: 'download',
      name,
      remotePath,
      totalBytes: 0,
      transferredBytes: 0,
      status: 'running',
      speedBytesPerSec: 0,
      etaSeconds: null
    };
    this.items.set(id, item);

    const chunks: Uint8Array[] = [];
    let offset = 0;
    let totalSize = 0;

    do {
      const res = await this.rpc({
        type: 'sftp_op',
        opId: `${id}-read-${offset}`,
        op: 'download_read',
        path: remotePath,
        offset,
        size: this.chunkSize
      });
      if (!res.ok) {
        item.status = 'failed';
        item.error = res.error ?? 'download_read failed';
        throw new Error(item.error);
      }

      totalSize = res.size ?? 0;
      item.totalBytes = totalSize;

      if (!writable) {
        if (totalSize > HARD_MAX_BLOB_DOWNLOAD_BYTES || totalSize > DEFAULT_BLOB_DOWNLOAD_CAP_BYTES) {
          item.status = 'failed';
          item.error = `Download size ${totalSize} exceeds browser Blob fallback cap (${DEFAULT_BLOB_DOWNLOAD_CAP_BYTES} bytes)`;
          throw new Error(item.error);
        }
        if (totalSize > WARN_BLOB_DOWNLOAD_BYTES) {
          item.warning = 'Large download (>128 MiB) using memory Blob fallback';
        }
      }

      const raw = res.dataBase64 ? base64ToBytes(res.dataBase64) : new Uint8Array(0);
      if (raw.byteLength === 0) {
        break;
      }
      if (res.sha256) {
        const verify = new IncrementalSha256().update(raw).digestHex();
        if (verify.toLowerCase() !== res.sha256.toLowerCase()) {
          item.status = 'failed';
          item.error = 'Download chunk SHA-256 mismatch';
          throw new Error(item.error);
        }
      }

      if (writable) {
        await writable.write(raw);
      } else {
        this.guard.allocateStorage(raw.byteLength);
        chunks.push(raw);
      }

      offset += raw.byteLength;
      item.transferredBytes = offset;
    } while (offset < totalSize);

    if (writable) {
      await writable.close();
      item.status = 'completed';
      return { item };
    }

    const merged = new Uint8Array(offset);
    let pos = 0;
    for (const c of chunks) {
      merged.set(c, pos);
      pos += c.byteLength;
    }
    item.status = 'completed';
    return { item, blobBytes: merged };
  }

  async downloadFolderAsZip(entries: ZipEntryInput[]): Promise<Uint8Array> {
    return buildStreamingZipArchive(entries);
  }
}

export type SortField = 'name' | 'size' | 'modTime';

export function sortAndFilterEntries(
  entries: SftpDirEntry[],
  filterQuery: string,
  sortBy: SortField = 'name',
  ascending = true
): SftpDirEntry[] {
  const q = filterQuery.trim().toLowerCase();
  const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : [...entries];

  filtered.sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1; // Directories always first
    }
    let cmp = 0;
    if (sortBy === 'name') {
      cmp = a.name.localeCompare(b.name);
    } else if (sortBy === 'size') {
      cmp = a.size - b.size;
    } else {
      cmp = a.modTime - b.modTime;
    }
    return ascending ? cmp : -cmp;
  });
  return filtered;
}

export interface RemoteEditorBuffer {
  path: string;
  content: string;
  dirty: boolean;
  lastSavedAt?: number;
}

export class RemoteFileEditor {
  private readonly buffers = new Map<string, RemoteEditorBuffer>();
  private readonly rpc: SftpRpcSender;

  constructor(rpc: SftpRpcSender) {
    this.rpc = rpc;
  }

  async openFile(remotePath: string): Promise<RemoteEditorBuffer> {
    const res = await this.rpc({
      type: 'sftp_op',
      opId: `edit-open-${Date.now()}`,
      op: 'read_file',
      path: remotePath,
      offset: 0,
      size: 512 * 1024
    });
    if (!res.ok) {
      throw new Error(res.error ?? `Failed to read ${remotePath}`);
    }
    const bytes = res.dataBase64 ? base64ToBytes(res.dataBase64) : new Uint8Array(0);
    const content = new TextDecoder().decode(bytes);
    const buf: RemoteEditorBuffer = {
      path: remotePath,
      content,
      dirty: false
    };
    this.buffers.set(remotePath, buf);
    return buf;
  }

  updateContent(remotePath: string, nextContent: string): RemoteEditorBuffer {
    const existing = this.buffers.get(remotePath);
    const updated: RemoteEditorBuffer = {
      path: remotePath,
      content: nextContent,
      dirty: true,
      lastSavedAt: existing?.lastSavedAt
    };
    this.buffers.set(remotePath, updated);
    return updated;
  }

  async saveToHost(remotePath: string): Promise<RemoteEditorBuffer> {
    const buf = this.buffers.get(remotePath);
    if (!buf) {
      throw new Error(`No open editor buffer for ${remotePath}`);
    }
    const raw = new TextEncoder().encode(buf.content);
    const res = await this.rpc({
      type: 'sftp_op',
      opId: `edit-save-${Date.now()}`,
      op: 'write_file',
      path: remotePath,
      dataBase64: bytesToBase64(raw)
    });
    if (!res.ok) {
      throw new Error(res.error ?? `Failed to save ${remotePath}`);
    }
    buf.dirty = false;
    buf.lastSavedAt = Date.now();
    return buf;
  }

  listOpenBuffers(): RemoteEditorBuffer[] {
    return Array.from(this.buffers.values());
  }
}
