/**
 * Minimal in-memory SFTP v3 server used by transport tests.
 *
 * It speaks just enough of the protocol to exercise the real client: version
 * negotiation, directory listing, stat, binary reads/writes, rename, chmod.
 * It is a test double only — it is not a reference implementation.
 */
import { SftpOpenFlag, SftpPacketType, SftpStatus, joinRemotePath } from '../sftp-client.js';
export function concat(...arrays) {
    const total = arrays.reduce((n, a) => n + a.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.byteLength;
    }
    return out;
}
export function u32(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, false);
    return out;
}
export function u64(value) {
    const out = new Uint8Array(8);
    const view = new DataView(out.buffer);
    view.setUint32(0, Math.floor(value / 0x100000000), false);
    view.setUint32(4, value >>> 0, false);
    return out;
}
export function str(value) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const out = new Uint8Array(4 + bytes.byteLength);
    new DataView(out.buffer).setUint32(0, bytes.byteLength, false);
    out.set(bytes, 4);
    return out;
}
export function attrs(size, mode) {
    return concat(u32(0x1 | 0x4 | 0x8), u64(size), u32(mode), u32(1700000000), u32(1700000000));
}
export class FakeSftpServer {
    files = new Map();
    dirs = new Set(['/home/user']);
    handles = new Map();
    nextHandle = 1;
    buffer = new Uint8Array(0);
    sendToClient = () => undefined;
    /** Hook the transport: every SFTP reply is handed to this callback. */
    setSendTarget(fn) {
        this.sendToClient = fn;
    }
    send = (data) => {
        this.buffer = concat(this.buffer, data);
        while (this.buffer.byteLength >= 4) {
            const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0, false);
            if (this.buffer.byteLength < 4 + length)
                return;
            const packet = this.buffer.slice(4, 4 + length);
            this.buffer = this.buffer.slice(4 + length);
            this.handle(packet);
        }
    };
    reply(type, id, payload = new Uint8Array(0)) {
        const body = concat(new Uint8Array([type]), u32(id), payload);
        this.sendToClient(concat(u32(body.byteLength), body));
    }
    status(id, code, message = '') {
        this.reply(SftpPacketType.STATUS, id, concat(u32(code), message ? str(message) : new Uint8Array(0)));
    }
    handle(packet) {
        const type = packet[0];
        if (type === SftpPacketType.INIT) {
            // SFTP VERSION carries no request id: type + version only.
            const body = concat(new Uint8Array([SftpPacketType.VERSION]), u32(3));
            this.sendToClient(concat(u32(body.byteLength), body));
            return;
        }
        const id = new DataView(packet.buffer, packet.byteOffset + 1, 4).getUint32(0, false);
        let offset = 5;
        const readString = () => {
            const len = new DataView(packet.buffer, packet.byteOffset + offset, 4).getUint32(0, false);
            const value = packet.slice(offset + 4, offset + 4 + len);
            offset += 4 + len;
            return value;
        };
        const readU64 = () => {
            const view = new DataView(packet.buffer, packet.byteOffset + offset, 8);
            offset += 8;
            return view.getUint32(0, false) * 0x100000000 + view.getUint32(4, false);
        };
        const readU32 = () => {
            const value = new DataView(packet.buffer, packet.byteOffset + offset, 4).getUint32(0, false);
            offset += 4;
            return value;
        };
        switch (type) {
            case SftpPacketType.REALPATH: {
                const path = new TextDecoder().decode(readString());
                const resolved = path === '.' || path === '~' || path === '' ? '/home/user' : path;
                this.reply(SftpPacketType.NAME, id, concat(u32(1), str(resolved), str(resolved)));
                return;
            }
            case SftpPacketType.OPENDIR: {
                const path = new TextDecoder().decode(readString());
                const prefix = path === '.' ? '' : path.endsWith('/') ? path : `${path}/`;
                const matches = [...this.files.keys()].filter((p) => (path === '.' || path === '' || p.startsWith(prefix)) &&
                    !(path === '.' ? p : p.slice(prefix.length)).includes('/'));
                if (!this.dirs.has(path) && path !== '.') {
                    this.status(id, SftpStatus.NO_SUCH_FILE, 'no such directory');
                    return;
                }
                const entries = matches.map((p) => (path === '.' ? p : p.slice(prefix.length)));
                const handle = `h${this.nextHandle++}`;
                this.handles.set(handle, { kind: 'dir', path, isWrite: false, entries });
                this.reply(SftpPacketType.HANDLE, id, str(handle));
                return;
            }
            case SftpPacketType.READDIR: {
                const handle = new TextDecoder().decode(readString());
                const entry = this.handles.get(handle);
                if (!entry?.entries?.length) {
                    this.status(id, SftpStatus.EOF);
                    return;
                }
                const names = entry.entries.splice(0);
                const payload = [u32(names.length)];
                for (const name of names) {
                    const path = entry.path === '.' ? name : joinRemotePath(entry.path, name);
                    const file = this.files.get(path);
                    payload.push(str(name), str(`${name} long`), attrs(file?.data.byteLength ?? 0, file?.mode ?? 0o644));
                }
                this.reply(SftpPacketType.NAME, id, concat(...payload));
                return;
            }
            case SftpPacketType.OPEN: {
                const path = new TextDecoder().decode(readString());
                const flags = readU32();
                const isWrite = (flags & SftpOpenFlag.WRITE) !== 0;
                if (isWrite) {
                    if (!this.files.has(path))
                        this.files.set(path, { data: new Uint8Array(0), mode: 0o644 });
                }
                else if (!this.files.has(path)) {
                    this.status(id, SftpStatus.NO_SUCH_FILE, 'no such file');
                    return;
                }
                const handle = `h${this.nextHandle++}`;
                this.handles.set(handle, { kind: 'file', path, isWrite });
                this.reply(SftpPacketType.HANDLE, id, str(handle));
                return;
            }
            case SftpPacketType.WRITE: {
                const handle = new TextDecoder().decode(readString());
                const writeOffset = readU64();
                const data = readString();
                const entry = this.handles.get(handle);
                if (!entry) {
                    this.status(id, SftpStatus.FAILURE, 'bad handle');
                    return;
                }
                const file = this.files.get(entry.path);
                const size = Math.max(file.data.byteLength, writeOffset + data.byteLength);
                const next = new Uint8Array(size);
                next.set(file.data);
                next.set(data, writeOffset);
                file.data = next;
                this.status(id, SftpStatus.OK);
                return;
            }
            case SftpPacketType.READ: {
                const handle = new TextDecoder().decode(readString());
                const readOffset = readU64();
                const asked = readU32();
                const entry = this.handles.get(handle);
                if (!entry) {
                    this.status(id, SftpStatus.FAILURE, 'bad handle');
                    return;
                }
                const file = this.files.get(entry.path);
                if (readOffset >= file.data.byteLength) {
                    this.status(id, SftpStatus.EOF);
                    return;
                }
                const slice = file.data.slice(readOffset, Math.min(readOffset + asked, file.data.byteLength));
                this.reply(SftpPacketType.DATA, id, str(slice));
                return;
            }
            case SftpPacketType.CLOSE: {
                const handle = new TextDecoder().decode(readString());
                this.handles.delete(handle);
                this.status(id, SftpStatus.OK);
                return;
            }
            case SftpPacketType.STAT:
            case SftpPacketType.LSTAT: {
                const path = new TextDecoder().decode(readString());
                const file = this.files.get(path);
                if (!file) {
                    this.status(id, SftpStatus.NO_SUCH_FILE, 'no such file');
                    return;
                }
                this.reply(SftpPacketType.ATTRS, id, attrs(file.data.byteLength, file.mode));
                return;
            }
            case SftpPacketType.SETSTAT: {
                const path = new TextDecoder().decode(readString());
                const flags = readU32();
                const file = this.files.get(path);
                if (!file) {
                    this.status(id, SftpStatus.NO_SUCH_FILE);
                    return;
                }
                if (flags & 0x4)
                    file.mode = readU32();
                this.status(id, SftpStatus.OK);
                return;
            }
            case SftpPacketType.RENAME: {
                const from = new TextDecoder().decode(readString());
                const to = new TextDecoder().decode(readString());
                const file = this.files.get(from);
                if (!file) {
                    this.status(id, SftpStatus.NO_SUCH_FILE);
                    return;
                }
                this.files.delete(from);
                this.files.set(to, file);
                this.status(id, SftpStatus.OK);
                return;
            }
            case SftpPacketType.MKDIR: {
                const path = new TextDecoder().decode(readString());
                this.dirs.add(path);
                this.status(id, SftpStatus.OK);
                return;
            }
            case SftpPacketType.REMOVE: {
                const path = new TextDecoder().decode(readString());
                if (!this.files.delete(path)) {
                    this.status(id, SftpStatus.NO_SUCH_FILE);
                    return;
                }
                this.status(id, SftpStatus.OK);
                return;
            }
            case SftpPacketType.RMDIR: {
                const path = new TextDecoder().decode(readString());
                this.dirs.delete(path);
                this.status(id, SftpStatus.OK);
                return;
            }
            default:
                this.status(id, SftpStatus.OP_UNSUPPORTED);
        }
    }
}
//# sourceMappingURL=fake-sftp-server.js.map