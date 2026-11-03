/**
 * SFTP v3 client (RFC draft-ietf-secsh-filexfer-02) over an already-opened
 * SSH `subsystem sftp` channel.
 *
 * Binary-safe, bounded-memory, and free of shell interpolation: every
 * operation is an SFTP protocol packet, never a command string. This is the
 * real implementation that replaces the earlier `ls`/`cat`/`write-file`
 * shell prototypes in relay mode.
 */

export const SFTP_DEFAULT_VERSION = 3;
export const SFTP_MAX_READ_CHUNK = 64 * 1024;
export const SFTP_MAX_WRITE_CHUNK = 32 * 1024;

export const enum SftpPacketType {
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

export enum SftpStatus {
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

export const SftpOpenFlag = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020
} as const;

const ATTR_SIZE = 0x00000001;
const ATTR_UIDGID = 0x00000002;
const ATTR_PERMISSIONS = 0x00000004;
const ATTR_ACMODTIME = 0x00000008;

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

export class SftpError extends Error {
  constructor(
    public readonly code: SftpStatus,
    message: string
  ) {
    super(message);
    this.name = 'SftpError';
  }

  get isNotFound(): boolean {
    return this.code === SftpStatus.NO_SUCH_FILE;
  }
}

/** Minimal channel contract the SFTP client needs from the SSH session. */
export interface SftpChannel {
  send(data: Uint8Array): void;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

function u8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 0x100000000) >>> 0, false);
  view.setUint32(4, value >>> 0, false);
  return out;
}

function sshString(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return concatBytes(u32(bytes.byteLength), bytes);
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.byteLength - this.offset;
  }

  byte(): number {
    if (this.offset >= this.buf.byteLength) throw new Error('SFTP packet underflow');
    return this.buf[this.offset++]!;
  }

  uint32(): number {
    if (this.offset + 4 > this.buf.byteLength) throw new Error('SFTP uint32 underflow');
    const value = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.offset,
      4
    ).getUint32(0, false);
    this.offset += 4;
    return value;
  }

  uint64(): number {
    if (this.offset + 8 > this.buf.byteLength) throw new Error('SFTP uint64 underflow');
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.offset, 8);
    const hi = view.getUint32(0, false);
    const lo = view.getUint32(4, false);
    this.offset += 8;
    return hi * 0x100000000 + lo;
  }

  bytes(): Uint8Array {
    const len = this.uint32();
    if (this.offset + len > this.buf.byteLength) throw new Error('SFTP string underflow');
    const slice = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return slice;
  }

  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  attrs(): SftpAttributes {
    const flags = this.uint32();
    const attrs: SftpAttributes = {};
    if (flags & ATTR_SIZE) attrs.size = this.uint64();
    if (flags & ATTR_UIDGID) {
      attrs.uid = this.uint32();
      attrs.gid = this.uint32();
    }
    if (flags & ATTR_PERMISSIONS) attrs.permissions = this.uint32();
    if (flags & ATTR_ACMODTIME) {
      attrs.atime = this.uint32();
      attrs.mtime = this.uint32();
    }
    // Extended attributes (SSH_FX_EXTENDED_ATTRS) are skipped; v3 servers
    // rarely send them and we never depend on them.
    if (flags & 0x80000000) {
      const count = this.uint32();
      for (let i = 0; i < count; i++) {
        this.string();
        this.bytes();
      }
    }
    return attrs;
  }
}

function encodeAttrs(attrs: SftpAttributes): Uint8Array {
  let flags = 0;
  if (attrs.size !== undefined) flags |= ATTR_SIZE;
  if (attrs.uid !== undefined || attrs.gid !== undefined) flags |= ATTR_UIDGID;
  if (attrs.permissions !== undefined) flags |= ATTR_PERMISSIONS;
  if (attrs.atime !== undefined || attrs.mtime !== undefined) flags |= ATTR_ACMODTIME;

  const parts: Uint8Array[] = [u32(flags)];
  if (flags & ATTR_SIZE) parts.push(u64(attrs.size ?? 0));
  if (flags & ATTR_UIDGID) parts.push(u32(attrs.uid ?? 0), u32(attrs.gid ?? 0));
  if (flags & ATTR_PERMISSIONS) parts.push(u32(attrs.permissions ?? 0));
  if (flags & ATTR_ACMODTIME) parts.push(u32(attrs.atime ?? 0), u32(attrs.mtime ?? 0));
  return concatBytes(...parts);
}

export function modeToOctalString(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

export function octalStringToMode(mode: string): number {
  const cleaned = mode.trim().replace(/^0+/, '');
  if (!/^[0-7]{1,4}$/.test(cleaned || '0')) {
    throw new Error(`Invalid octal file mode "${mode}"`);
  }
  return Number.parseInt(cleaned || '0', 8);
}

/** Join remote POSIX paths without touching the shell. */
export function joinRemotePath(base: string, name: string): string {
  if (!base || base === '.' || base === '~') return name;
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

export function basenameRemotePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function dirnameRemotePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return idx === 0 ? '/' : '.';
  return trimmed.slice(0, idx);
}

export function normalizeRemotePath(path: string): string {
  const isAbsolute = path.startsWith('/');
  const stack: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push('..');
      }
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join('/');
  return isAbsolute ? `/${joined}` : joined || '.';
}

interface PendingRequest {
  resolve: (packet: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

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

export const SFTP_MAX_READ_FILE_BYTES = 64 * 1024 * 1024; // 64 MiB hard guard

export interface SftpUploadSession {
  readonly path: string;
  readonly partPath: string;
  readonly offset: number;
  write(chunk: Uint8Array): Promise<number>;
  commit(): Promise<number>;
  abort(): Promise<void>;
}

export class SftpClient {
  private version = 0;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer: Uint8Array = new Uint8Array(0);
  private initWaiter: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private closed = false;

  constructor(
    private readonly channel: SftpChannel,
    private readonly timeoutMs = 30_000
  ) {}

  get negotiatedVersion(): number {
    return this.version;
  }

  /** Send SSH_FXP_INIT and wait for SSH_FXP_VERSION. */
  init(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.version > 0) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.initWaiter = null;
        reject(new SftpError(SftpStatus.CONNECTION_LOST, 'SFTP init timed out'));
      }, this.timeoutMs);
      this.initWaiter = { resolve, reject, timer };
      this.channel.send(concatBytes(u32(5), u8(SftpPacketType.INIT), u32(SFTP_DEFAULT_VERSION)));
    });
  }

  /** Feed raw channel data received from the SSH session. */
  handleData(data: Uint8Array): void {
    this.buffer = concatBytes(this.buffer, data);
    while (this.buffer.byteLength >= 4) {
      const length = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        4
      ).getUint32(0, false);
      if (length < 1 || length > 16 * 1024 * 1024) {
        this.failAll(new SftpError(SftpStatus.BAD_MESSAGE, `Invalid SFTP packet length ${length}`));
        return;
      }
      if (this.buffer.byteLength < 4 + length) return;
      const packet = this.buffer.slice(4, 4 + length);
      this.buffer = this.buffer.slice(4 + length);
      this.dispatch(packet);
    }
  }

  /** Reject every in-flight request (channel closed / session lost). */
  failAll(err: Error): void {
    if (this.initWaiter) {
      clearTimeout(this.initWaiter.timer);
      this.initWaiter.reject(err);
      this.initWaiter = null;
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  close(): void {
    this.closed = true;
    this.failAll(new SftpError(SftpStatus.CONNECTION_LOST, 'SFTP channel closed'));
  }

  private dispatch(packet: Uint8Array): void {
    const type = packet[0]!;
    if (type === SftpPacketType.VERSION) {
      const reader = new Reader(packet.subarray(1));
      this.version = reader.uint32();
      if (this.version < 3) {
        this.failAll(
          new SftpError(
            SftpStatus.OP_UNSUPPORTED,
            `Server negotiated unsupported SFTP version ${this.version}`
          )
        );
        return;
      }
      if (this.initWaiter) {
        clearTimeout(this.initWaiter.timer);
        this.initWaiter.resolve();
        this.initWaiter = null;
      }
      return;
    }

    if (packet.byteLength < 5) return;
    const id = new DataView(packet.buffer, packet.byteOffset + 1, 4).getUint32(0, false);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    // Keep the packet type byte; callers dispatch on response[0].
    pending.resolve(concatBytes(u8(type), packet.subarray(5)));
  }

  private async request(type: SftpPacketType, payload: Uint8Array): Promise<Uint8Array> {
    if (this.closed) {
      throw new SftpError(SftpStatus.CONNECTION_LOST, 'SFTP channel is closed');
    }
    const id = this.requestId++;
    const packet = concatBytes(u32(4 + payload.byteLength + 1), u8(type), u32(id), payload);
    const response = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SftpError(SftpStatus.CONNECTION_LOST, `SFTP request timed out (type ${type})`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.channel.send(packet);
    return response;
  }

  private throwStatus(response: Uint8Array, action: string): never {
    const reader = new Reader(response);
    const code = reader.uint32();
    const message = reader.remaining >= 4 ? reader.string() : '';
    throw new SftpError(code, `${action}: ${message || SftpStatus[code] || `status ${code}`}`);
  }

  private homePromise: Promise<string> | null = null;

  /**
   * Expand `~` and `~/…` against the server's home directory. Shell expansion
   * never happens here, so a path typed as `~/app` would otherwise be sent
   * literally and fail.
   */
  async resolvePath(path: string): Promise<string> {
    const trimmed = path.trim();
    if (trimmed !== '~' && !trimmed.startsWith('~/')) return path;
    if (!this.homePromise) {
      this.homePromise = this.realpath('.').catch((err: unknown) => {
        this.homePromise = null;
        throw err;
      });
    }
    const home = await this.homePromise;
    return trimmed === '~' ? home : joinRemotePath(home, trimmed.slice(2));
  }

  /** Realpath + STAT. Returns attributes. */
  async stat(path: string): Promise<SftpAttributes> {
    const resolved = await this.resolvePath(path);
    const response = await this.request(SftpPacketType.STAT, sshString(resolved));
    return this.parseAttrsResponse(response, `stat ${path}`);
  }

  async lstat(path: string): Promise<SftpAttributes> {
    const resolved = await this.resolvePath(path);
    const response = await this.request(SftpPacketType.LSTAT, sshString(resolved));
    return this.parseAttrsResponse(response, `lstat ${path}`);
  }

  private parseAttrsResponse(response: Uint8Array, action: string): SftpAttributes {
    if (response[0] === SftpPacketType.ATTRS) {
      return new Reader(response.subarray(1)).attrs();
    }
    if (response[0] === SftpPacketType.STATUS) {
      const reader = new Reader(response.subarray(1));
      const code = reader.uint32();
      if (code === SftpStatus.OK) return {};
      throw new SftpError(code, `${action}: ${reader.remaining >= 4 ? reader.string() : SftpStatus[code]}`);
    }
    throw new SftpError(SftpStatus.BAD_MESSAGE, `${action}: unexpected SFTP response ${response[0]}`);
  }

  async realpath(path: string): Promise<string> {
    const response = await this.request(SftpPacketType.REALPATH, sshString(path));
    if (response[0] === SftpPacketType.NAME) {
      const reader = new Reader(response.subarray(1));
      const count = reader.uint32();
      if (count < 1) throw new SftpError(SftpStatus.FAILURE, 'realpath returned no names');
      const name = reader.string();
      reader.string(); // longname
      new Reader(reader.bytes()); // attrs (ignored)
      return name;
    }
    if (response[0] === SftpPacketType.STATUS) this.throwStatus(response.subarray(1), 'realpath');
    throw new SftpError(SftpStatus.BAD_MESSAGE, 'realpath: unexpected response');
  }

  async list(path: string): Promise<SftpEntry[]> {
    const displayBase = path === '~' || path.startsWith('~/') ? path.replace(/\/+$/, '') : null;
    const dir = path === '~' ? '.' : await this.resolvePath(path);
    const handle = await this.openDirectory(dir);
    const entries: SftpEntry[] = [];
    try {
      for (;;) {
        const response = await this.request(SftpPacketType.READDIR, sshString(handle));
        if (response[0] === SftpPacketType.STATUS) {
          const reader = new Reader(response.subarray(1));
          const code = reader.uint32();
          if (code === SftpStatus.EOF) break;
          throw new SftpError(code, `readdir ${dir}: ${SftpStatus[code]}`);
        }
        if (response[0] !== SftpPacketType.NAME) {
          throw new SftpError(SftpStatus.BAD_MESSAGE, 'readdir: unexpected response');
        }
        const reader = new Reader(response.subarray(1));
        const count = reader.uint32();
        for (let i = 0; i < count; i++) {
          const name = reader.string();
          const longname = reader.string();
          const attrs = reader.attrs();
          if (name === '.' || name === '..') continue;
          const mode = attrs.permissions ?? 0;
          entries.push({
            name,
            path: joinRemotePath(displayBase ?? (dir === '.' ? '~' : dir), name),
            isDir: (mode & 0o170000) === 0o040000,
            isSymlink: (mode & 0o170000) === 0o120000,
            size: attrs.size ?? 0,
            mode: mode ? modeToOctalString(mode) : '0644',
            uid: attrs.uid ?? 0,
            gid: attrs.gid ?? 0,
            modTime: attrs.mtime ?? 0,
            longname
          });
        }
      }
    } finally {
      await this.closeHandle(handle).catch(() => undefined);
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  async mkdir(path: string, permissions?: number): Promise<void> {
    const resolved = await this.resolvePath(path);
    const payload = concatBytes(sshString(resolved), encodeAttrs({ permissions }));
    const response = await this.request(SftpPacketType.MKDIR, payload);
    if (response[0] === SftpPacketType.STATUS) {
      const reader = new Reader(response.subarray(1));
      const code = reader.uint32();
      if (code === SftpStatus.OK) return;
      // SSH_FX_FAILURE is what a v3 server returns for "already exists". Only
      // treat it as success when the path really is a directory; otherwise a
      // permission error would be silently swallowed.
      if (code === SftpStatus.FAILURE) {
        try {
          const attrs = await this.stat(path);
          if (((attrs.permissions ?? 0) & 0o170000) === 0o040000) return;
        } catch {
          // Not a readable directory — report the original failure below.
        }
      }
      throw new SftpError(code, `mkdir ${path}: ${reader.remaining >= 4 ? reader.string() : SftpStatus[code]}`);
    }
    throw new SftpError(SftpStatus.BAD_MESSAGE, 'mkdir: unexpected response');
  }

  async remove(path: string): Promise<void> {
    const resolved = await this.resolvePath(path);
    await this.expectOk(await this.request(SftpPacketType.REMOVE, sshString(resolved)), `remove ${path}`);
  }

  async rmdir(path: string): Promise<void> {
    const resolved = await this.resolvePath(path);
    await this.expectOk(await this.request(SftpPacketType.RMDIR, sshString(resolved)), `rmdir ${path}`);
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    const from = await this.resolvePath(fromPath);
    const to = await this.resolvePath(toPath);
    const response = await this.request(
      SftpPacketType.RENAME,
      concatBytes(sshString(from), sshString(to))
    );
    await this.expectOk(response, `rename ${fromPath} -> ${toPath}`);
  }

  /** Recursive delete. Callers must confirm destructive intent in the UI. */
  async removeRecursive(path: string, depth = 0): Promise<void> {
    if (depth > 64) throw new SftpError(SftpStatus.FAILURE, `Refusing to recurse deeper than 64 levels at ${path}`);
    const attrs = await this.lstat(path);
    const mode = attrs.permissions ?? 0;
    const isDir = (mode & 0o170000) === 0o040000;
    if (!isDir) {
      await this.remove(path);
      return;
    }
    for (const entry of await this.list(path)) {
      await this.removeRecursive(joinRemotePath(path, entry.name), depth + 1);
    }
    await this.rmdir(path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const resolved = await this.resolvePath(path);
    const payload = concatBytes(sshString(resolved), encodeAttrs({ permissions: mode }));
    await this.expectOk(await this.request(SftpPacketType.SETSTAT, payload), `chmod ${path}`);
  }

  /** Read a whole file with a hard byte budget. */
  async readFile(path: string, options: ReadFileOptions = {}): Promise<Uint8Array> {
    path = await this.resolvePath(path);
    const maxBytes = options.maxBytes ?? SFTP_MAX_READ_FILE_BYTES;
    const attrs = await this.stat(path);
    if ((attrs.size ?? 0) > maxBytes) {
      throw new SftpError(
        SftpStatus.FAILURE,
        `File is ${attrs.size} bytes, above the ${maxBytes} byte editor limit`
      );
    }
    const handle = await this.openFile(path, SftpOpenFlag.READ);
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      let offset = 0;
      for (;;) {
        options.signal?.throwIfAborted();
        const response = await this.request(
          SftpPacketType.READ,
          concatBytes(sshString(handle), u64(offset), u32(SFTP_MAX_READ_CHUNK))
        );
        if (response[0] === SftpPacketType.STATUS) {
          const reader = new Reader(response.subarray(1));
          const code = reader.uint32();
          if (code === SftpStatus.EOF) break;
          throw new SftpError(code, `read ${path}: ${SftpStatus[code]}`);
        }
        if (response[0] !== SftpPacketType.DATA) {
          throw new SftpError(SftpStatus.BAD_MESSAGE, 'read: unexpected response');
        }
        const reader = new Reader(response.subarray(1));
        const data = reader.bytes();
        if (data.byteLength === 0) break;
        total += data.byteLength;
        if (total > maxBytes) {
          throw new SftpError(
            SftpStatus.FAILURE,
            `File exceeds the ${maxBytes} byte editor limit while reading`
          );
        }
        chunks.push(data);
        offset += data.byteLength;
      }
    } finally {
      await this.closeHandle(handle).catch(() => undefined);
    }
    return concatBytes(...chunks);
  }

  /**
   * Write a whole file. By default writes a sibling temp file and renames it
   * into place, so a failed write never truncates the target.
   */
  async writeFile(path: string, data: Uint8Array, options: WriteFileOptions = {}): Promise<number> {
    path = await this.resolvePath(path);
    const atomic = options.atomic !== false;
    const target = atomic
      ? `${path}.webssh-tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : path;
    // A renamed temp file would otherwise land with the umask's mode (0644),
    // silently widening or narrowing a 0600 secret. Carry the original mode.
    let permissions = options.permissions;
    if (atomic && permissions === undefined) {
      try {
        permissions = (await this.stat(path)).permissions;
      } catch (err) {
        if (!(err instanceof SftpError) || !err.isNotFound) throw err;
      }
    }
    try {
      const handle = await this.openFile(
        target,
        SftpOpenFlag.WRITE | SftpOpenFlag.CREAT | SftpOpenFlag.TRUNC
      );
      try {
        let offset = 0;
        while (offset < data.byteLength) {
          options.signal?.throwIfAborted();
          const chunk = data.subarray(offset, offset + SFTP_MAX_WRITE_CHUNK);
          const response = await this.request(
            SftpPacketType.WRITE,
            concatBytes(sshString(handle), u64(offset), sshString(chunk))
          );
          await this.expectOk(response, `write ${path} at ${offset}`);
          offset += chunk.byteLength;
        }
      } finally {
        await this.closeHandle(handle).catch(() => undefined);
      }
      if (permissions !== undefined) {
        await this.chmod(target, permissions);
      }
      if (atomic) {
        await this.rename(target, path);
      }
      return data.byteLength;
    } catch (err) {
      if (atomic) {
        await this.remove(target).catch(() => undefined);
      }
      throw err;
    }
  }

  /**
   * Start (or resume) a resumable upload. Bytes go to a deterministic sibling
   * `.webssh-part` file; `commit()` renames it into place, so the target is
   * never left half-written.
   */
  async startUpload(path: string, options: { permissions?: number } = {}): Promise<SftpUploadSession> {
    path = await this.resolvePath(path);
    const partPath = `${path}.webssh-part`;
    let offset = 0;
    try {
      const attrs = await this.lstat(partPath);
      offset = attrs.size ?? 0;
    } catch (err) {
      if (!(err instanceof SftpError) || !err.isNotFound) throw err;
    }
    const handle = await this.openFile(partPath, SftpOpenFlag.WRITE | SftpOpenFlag.CREAT);
    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await this.closeHandle(handle).catch(() => undefined);
    };
    return {
      path,
      partPath,
      offset,
      write: async (chunk: Uint8Array): Promise<number> => {
        let written = 0;
        while (written < chunk.byteLength) {
          const slice = chunk.subarray(written, written + SFTP_MAX_WRITE_CHUNK);
          const response = await this.request(
            SftpPacketType.WRITE,
            concatBytes(sshString(handle), u64(offset + written), sshString(slice))
          );
          await this.expectOk(response, `upload ${path}`);
          written += slice.byteLength;
        }
        offset += written;
        return offset;
      },
      commit: async (): Promise<number> => {
        await closeOnce();
        if (options.permissions !== undefined) {
          await this.chmod(partPath, options.permissions);
        }
        await this.rename(partPath, path);
        return offset;
      },
      abort: async (): Promise<void> => {
        await closeOnce();
        await this.remove(partPath).catch(() => undefined);
      }
    };
  }

  private async openDirectory(path: string): Promise<string> {    const response = await this.request(
      SftpPacketType.OPENDIR,
      sshString(path)
    );
    return this.parseHandle(response, `opendir ${path}`);
  }

  private async openFile(path: string, flags: number): Promise<string> {
    const payload = concatBytes(sshString(path), u32(flags), encodeAttrs({}));
    const response = await this.request(SftpPacketType.OPEN, payload);
    return this.parseHandle(response, `open ${path}`);
  }

  private parseHandle(response: Uint8Array, action: string): string {
    if (response[0] === SftpPacketType.HANDLE) {
      return new Reader(response.subarray(1)).string();
    }
    if (response[0] === SftpPacketType.STATUS) {
      this.throwStatus(response.subarray(1), action);
    }
    throw new SftpError(SftpStatus.BAD_MESSAGE, `${action}: unexpected response`);
  }

  private async closeHandle(handle: string): Promise<void> {
    const response = await this.request(SftpPacketType.CLOSE, sshString(handle));
    await this.expectOk(response, 'close handle');
  }

  private async expectOk(response: Uint8Array, action: string): Promise<void> {
    if (response[0] === SftpPacketType.STATUS) {
      const reader = new Reader(response.subarray(1));
      const code = reader.uint32();
      if (code === SftpStatus.OK) return;
      throw new SftpError(
        code,
        `${action}: ${reader.remaining >= 4 ? reader.string() : SftpStatus[code]}`
      );
    }
    throw new SftpError(SftpStatus.BAD_MESSAGE, `${action}: unexpected response ${response[0]}`);
  }
}
