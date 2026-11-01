import type { ControlMessage, SftpDirEntry } from '@webssh/protocol';
import { type ZipEntryInput } from './zip-stream';
export declare const DEFAULT_CHUNK_BYTES: number;
export declare const HARD_MAX_CHUNK_BYTES: number;
export declare const DEFAULT_IN_FLIGHT_BUFFER_BYTES: number;
export declare const HARD_MAX_IN_FLIGHT_BUFFER_BYTES: number;
export declare const DEFAULT_CONCURRENT_TRANSFERS = 3;
export declare const HARD_MAX_CONCURRENT_TRANSFERS = 6;
export declare const DEFAULT_LOCAL_STORAGE_CAP_BYTES: number;
export declare const DEFAULT_BLOB_DOWNLOAD_CAP_BYTES: number;
export declare const WARN_BLOB_DOWNLOAD_BYTES: number;
export declare const HARD_MAX_BLOB_DOWNLOAD_BYTES: number;
export interface StorageQuotaSnapshot {
    usedBytes: number;
    capBytes: number;
    inFlightBytes: number;
    inFlightCapBytes: number;
    percentUsed: number;
}
export declare class StorageGuard {
    private usedBytes;
    private inFlightBytes;
    private capBytes;
    private inFlightCapBytes;
    constructor(capBytes?: number, inFlightCapBytes?: number);
    syncWithBrowserQuota(): Promise<StorageQuotaSnapshot>;
    canAllocateStorage(bytes: number): boolean;
    allocateStorage(bytes: number): void;
    releaseStorage(bytes: number): void;
    canReserveInFlight(bytes: number): boolean;
    reserveInFlight(bytes: number): void;
    releaseInFlight(bytes: number): void;
    snapshot(): StorageQuotaSnapshot;
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
export type SftpRpcSender = (msg: Extract<ControlMessage, {
    type: 'sftp_op';
}>) => Promise<Extract<ControlMessage, {
    type: 'sftp_result';
}>>;
export interface UploadSource {
    name: string;
    remotePath: string;
    size: number;
    sliceChunk: (offset: number, length: number) => Promise<Uint8Array>;
}
export interface FolderEntrySource extends UploadSource {
    relativePath: string;
}
export declare class TransferQueue {
    private readonly items;
    private readonly sources;
    private readonly guard;
    private readonly rpc;
    private readonly chunkSize;
    private maxConcurrency;
    private activeCount;
    constructor(rpc: SftpRpcSender, guard?: StorageGuard, chunkSize?: number, maxConcurrency?: number);
    setMaxConcurrency(limit: number): void;
    list(): TransferItem[];
    get(id: string): TransferItem | undefined;
    enqueueUpload(source: UploadSource): TransferItem;
    pause(id: string): void;
    cancel(id: string): void;
    runUpload(id: string): Promise<TransferItem>;
    uploadFolder(baseRemoteDir: string, entries: FolderEntrySource[]): Promise<TransferItem[]>;
    downloadFile(remotePath: string, writable?: {
        write: (chunk: Uint8Array) => Promise<void>;
        close: () => Promise<void>;
    }): Promise<{
        item: TransferItem;
        blobBytes?: Uint8Array;
    }>;
    downloadFolderAsZip(entries: ZipEntryInput[]): Promise<Uint8Array>;
}
export type SortField = 'name' | 'size' | 'modTime';
export declare function sortAndFilterEntries(entries: SftpDirEntry[], filterQuery: string, sortBy?: SortField, ascending?: boolean): SftpDirEntry[];
export interface RemoteEditorBuffer {
    path: string;
    content: string;
    dirty: boolean;
    lastSavedAt?: number;
}
export declare class RemoteFileEditor {
    private readonly buffers;
    private readonly rpc;
    constructor(rpc: SftpRpcSender);
    openFile(remotePath: string): Promise<RemoteEditorBuffer>;
    updateContent(remotePath: string, nextContent: string): RemoteEditorBuffer;
    saveToHost(remotePath: string): Promise<RemoteEditorBuffer>;
    listOpenBuffers(): RemoteEditorBuffer[];
}
//# sourceMappingURL=transfer-engine.d.ts.map