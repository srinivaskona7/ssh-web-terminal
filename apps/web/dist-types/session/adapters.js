function toBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.byteLength; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
function bytesFromBinary(binary) {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    return bytes;
}
/**
 * Decode file bytes as UTF-8 and refuse anything that is not valid text. A
 * lossy decode would turn every invalid byte into U+FFFD, and the editor would
 * then write that corruption back on the next save.
 */
function decodeUtf8Text(bytes, path) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        throw new Error(`${path} is not valid UTF-8 text; refusing to open it in the editor`);
    }
}
export function createRemoteSession(client, options) {
    const exec = async (command, execOptions = {}) => {
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
    const session = {
        transport: options.transport,
        host: options.host,
        user: options.user,
        port: options.port,
        isConnected: () => options.isConnected?.() ?? true,
        exec
    };
    if (client.execStream) {
        session.execStream = (command, execOptions) => exec(command, execOptions);
    }
    if (client.sftpOp) {
        const sftpOp = client.sftpOp.bind(client);
        session.writeFile = async (path, data) => {
            const result = await sftpOp({ op: 'write_file', path, dataBase64: toBase64(data) });
            if (!result.ok)
                throw new Error(result.error ?? `Could not write ${path}`);
        };
        session.readFile = async (path) => {
            // The relay returns the whole file in one reply, while the Go gateway
            // reads at most one chunk per call (256 KiB by default) and reports the
            // full size plus the next offset. Page until the whole file is in hand:
            // stopping early and writing the partial buffer back would truncate the
            // file on the server.
            let binary = '';
            let offset = 0;
            let total = null;
            for (let attempt = 0; attempt < 512; attempt++) {
                const result = await sftpOp({
                    op: 'read_file',
                    path,
                    ...(offset > 0 ? { offset } : {})
                });
                if (!result.ok)
                    throw new Error(result.error ?? `Could not read ${path}`);
                const chunk = result.dataBase64 ? atob(result.dataBase64) : '';
                if (total === null && typeof result.size === 'number')
                    total = result.size;
                binary += chunk;
                if (total !== null && binary.length >= total)
                    break;
                if (chunk.length === 0)
                    break;
                const next = typeof result.offset === 'number' && result.offset > offset
                    ? result.offset
                    : offset + chunk.length;
                if (next <= offset)
                    break;
                offset = next;
            }
            if (total !== null && binary.length < total) {
                throw new Error(`Read only ${binary.length} of ${total} bytes from ${path}; refusing to open a partial file`);
            }
            return decodeUtf8Text(bytesFromBinary(binary), path);
        };
        session.listDir = async (path) => {
            const result = (await sftpOp({ op: 'list', path }));
            if (!result.ok)
                throw new Error(result.error ?? `Could not list ${path}`);
            return (result.entries ?? [])
                .filter((entry) => typeof entry.name === 'string' && entry.name.length > 0)
                .map((entry) => ({
                name: entry.name,
                path: entry.path ?? `${path.replace(/\/$/, '')}/${entry.name}`,
                isDir: Boolean(entry.isDir),
                isSymlink: Boolean(entry.isSymlink),
                size: typeof entry.size === 'number' ? entry.size : 0,
                modTime: typeof entry.modTime === 'number' ? entry.modTime : 0
            }));
        };
        session.renamePath = async (from, to) => {
            const result = await sftpOp({ op: 'rename', path: from, targetPath: to });
            if (!result.ok)
                throw new Error(result.error ?? `Could not rename ${from}`);
        };
        session.removePath = async (path) => {
            const result = await sftpOp({ op: 'remove', path });
            if (!result.ok)
                throw new Error(result.error ?? `Could not remove ${path}`);
        };
        session.makeDir = async (path) => {
            const result = await sftpOp({ op: 'mkdir', path });
            if (!result.ok)
                throw new Error(result.error ?? `Could not create ${path}`);
        };
        session.probeSftp = async () => {
            try {
                const result = await sftpOp({ op: 'stat', path: '.' });
                return result.ok;
            }
            catch {
                return false;
            }
        };
    }
    else if (client.getSftpClient) {
        session.probeSftp = async () => {
            try {
                await client.getSftpClient();
                return true;
            }
            catch {
                return false;
            }
        };
    }
    return session;
}
//# sourceMappingURL=adapters.js.map