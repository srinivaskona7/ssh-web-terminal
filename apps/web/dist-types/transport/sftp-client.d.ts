/**
 * SFTP v3 client (RFC draft-ietf-secsh-filexfer-02) over an already-opened
 * SSH `subsystem sftp` channel.
 *
 * Binary-safe, bounded-memory, and free of shell interpolation: every
 * operation is an SFTP protocol packet, never a command string. This is the
 * real implementation that replaces the earlier `ls`/`cat`/`write-file`
 * shell prototypes in relay mode.
 */
export declare const SFTP_DEFAULT_VERSION = 3;
export declare const SFTP_MAX_READ_CHUNK: number;
export declare const SFTP_MAX_WRITE_CHUNK: number;
export declare const enum SftpPacketType {
    INIT = 1,
    VERSION = 2,
    OPEN = 3,
    CLOSE = 4,
    READ = 5,
    WRITE = 6,
    LSTAT = 7,
    FSTAT = 8,
    SETSTAT = 9,
    FSETSTAT = 10,
    OPENDIR = 11,
    READDIR = 12,
    REMOVE = 13,
    MKDIR = 14,
    RMDIR = 15,
    REALPATH = 16,
    STAT = 17,
    RENAME = 18,
    READLINK = 19,
    SYMLINK = 20,
    STATUS = 101,
    HANDLE = 102,
    DATA = 103,
    NAME = 104,
    ATTRS = 105,
    EXTENDED = 200,
    EXTENDED_REPLY = 201
}
export declare enum SftpStatus {
    OK = 0,
    EOF = 1,
    NO_SUCH_FILE = 2,
    PERMISSION_DENIED = 3,
    FAILURE = 4,
    BAD_MESSAGE = 5,
    NO_CONNECTION = 6,
    CONNECTION_LOST = 7,
    OP_UNSUPPORTED = 8
}
export declare const SftpOpenFlag: {
    readonly READ: 1;
    readonly WRITE: 2;
    readonly APPEND: 4;
    readonly CREAT: 8;
    readonly TRUNC: 16;
    readonly EXCL: 32;
};
export interface SftpAttributes {
    size?: number;
    uid?: number;
    gid?: number;
    /** Numeric permission bits, e.g. 0o644. */
    permissions?: number;
    /** UNIX epoch seconds. */
    atime?: number;
    /** UNIX epoch seconds. */
    mtime?: number;
}
export interface SftpEntry {
    name: string;
    path: string;
    isDir: boolean;
    isSymlink: boolean;
    size: number;
    mode: string;
    uid: number;
    gid: number;
    modTime: number;
    longname: string;
}
export declare class SftpError extends Error {
    readonly code: SftpStatus;
    constructor(code: SftpStatus, message: string);
    get isNotFound(): boolean;
}
/** Minimal channel contract the SFTP client needs from the SSH session. */
export interface SftpChannel {
    send(data: Uint8Array): void;
}
export declare function modeToOctalString(mode: number): string;
export declare function octalStringToMode(mode: string): number;
/** Join remote POSIX paths without touching the shell. */
export declare function joinRemotePath(base: string, name: string): string;
export declare function basenameRemotePath(path: string): string;
export declare function dirnameRemotePath(path: string): string;
export declare function normalizeRemotePath(path: string): string;
export interface ReadFileOptions {
    maxBytes?: number;
    signal?: AbortSignal;
}
export interface WriteFileOptions {
    /**
     * Write to a sibling temporary file and rename it into place. On by default:
     * a reader never observes a truncated file, and a failed upload leaves the
     * original untouched.
     */
    atomic?: boolean;
    permissions?: number;
    signal?: AbortSignal;
}
export declare const SFTP_MAX_READ_FILE_BYTES: number;
export interface SftpUploadSession {
    readonly path: string;
    readonly partPath: string;
    readonly offset: number;
    write(chunk: Uint8Array): Promise<number>;
    commit(): Promise<number>;
    abort(): Promise<void>;
}
export declare class SftpClient {
    private readonly channel;
    private readonly timeoutMs;
    private version;
    private requestId;
    private readonly pending;
    private buffer;
    private initWaiter;
    private closed;
    constructor(channel: SftpChannel, timeoutMs?: number);
    get negotiatedVersion(): number;
    /** Send SSH_FXP_INIT and wait for SSH_FXP_VERSION. */
    init(): Promise<void>;
    /** Feed raw channel data received from the SSH session. */
    handleData(data: Uint8Array): void;
    /** Reject every in-flight request (channel closed / session lost). */
    failAll(err: Error): void;
    close(): void;
    private dispatch;
    private request;
    private throwStatus;
    /** Realpath + STAT. Returns attributes. */
    stat(path: string): Promise<SftpAttributes>;
    lstat(path: string): Promise<SftpAttributes>;
    private parseAttrsResponse;
    realpath(path: string): Promise<string>;
    list(path: string): Promise<SftpEntry[]>;
    mkdir(path: string, permissions?: number): Promise<void>;
    remove(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(fromPath: string, toPath: string): Promise<void>;
    /** Recursive delete. Callers must confirm destructive intent in the UI. */
    removeRecursive(path: string, depth?: number): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    /** Read a whole file with a hard byte budget. */
    readFile(path: string, options?: ReadFileOptions): Promise<Uint8Array>;
    /**
     * Write a whole file. By default writes a sibling temp file and renames it
     * into place, so a failed write never truncates the target.
     */
    writeFile(path: string, data: Uint8Array, options?: WriteFileOptions): Promise<number>;
    /**
     * Start (or resume) a resumable upload. Bytes go to a deterministic sibling
     * `.webssh-part` file; `commit()` renames it into place, so the target is
     * never left half-written.
     */
    startUpload(path: string, options?: {
        permissions?: number;
    }): Promise<SftpUploadSession>;
    private openDirectory;
    private openFile;
    private parseHandle;
    private closeHandle;
    private expectOk;
}
//# sourceMappingURL=sftp-client.d.ts.map