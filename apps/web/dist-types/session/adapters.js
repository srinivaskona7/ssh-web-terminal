function toBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.byteLength; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
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