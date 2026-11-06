import { describe, expect, it } from 'vitest';
import { createRemoteSession, type RelayLikeClient } from './adapters';

function baseClient(overrides: Partial<RelayLikeClient> = {}): RelayLikeClient {
  return {
    execCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    ...overrides
  };
}

function session(client: RelayLikeClient) {
  return createRemoteSession(client, {
    transport: 'go-gateway',
    host: 'example.test',
    user: 'ubuntu',
    port: 22
  });
}

describe('createRemoteSession', () => {
  it('pages a chunked read until the reported size is met', async () => {
    const offsets: number[] = [];
    const client = baseClient({
      sftpOp: async (op) => {
        const offset = typeof op.offset === 'number' ? op.offset : 0;
        offsets.push(offset);
        const part = offset === 0 ? 'abc' : 'def';
        return {
          ok: true,
          dataBase64: btoa(part),
          size: 6,
          offset: offset + part.length
        };
      }
    });

    await expect(session(client).readFile?.('/app.ts')).resolves.toBe('abcdef');
    expect(offsets).toEqual([0, 3]);
  });

  it('refuses a partial read instead of returning a truncated buffer', async () => {
    const client = baseClient({
      sftpOp: async (op) => {
        const offset = typeof op.offset === 'number' ? op.offset : 0;
        return offset === 0
          ? { ok: true, dataBase64: btoa('abc'), size: 10, offset: 3 }
          : { ok: true, dataBase64: '', size: 10, offset: 3 };
      }
    });

    await expect(session(client).readFile?.('/app.ts')).rejects.toThrow(/partial file/);
  });

  it('refuses a file that is not valid UTF-8 text', async () => {
    const client = baseClient({
      sftpOp: async () => ({
        ok: true,
        dataBase64: btoa(String.fromCharCode(0xff, 0xfe)),
        size: 2,
        offset: 2
      })
    });

    await expect(session(client).readFile?.('/bin.dat')).rejects.toThrow(/not valid UTF-8/);
  });

  it('treats a missing exit code as success (gateway omits zero)', async () => {
    const client = baseClient({
      execCommand: async () =>
        ({ stdout: 'ok', stderr: '', exitCode: undefined }) as unknown as {
          stdout: string;
          stderr: string;
          exitCode: number;
        }
    });

    const result = await session(client).exec('true');
    expect(result.exitCode).toBe(0);
  });

  it('sends large writes through chunked upload ops, never one oversized frame', async () => {
    const ops: Array<{ op: string; size?: number; path?: string }> = [];
    let written = 0;
    const client = baseClient({
      sftpOp: async (op) => {
        ops.push({ op: String(op.op), size: op.size as number | undefined, path: op.path as string });
        if (op.op === 'upload_init') return { ok: true, offset: 0 };
        if (op.op === 'upload_chunk') {
          written += op.size as number;
          return { ok: true, offset: written };
        }
        if (op.op === 'upload_commit') return { ok: true };
        return { ok: true };
      }
    });

    const data = new Uint8Array(3 * 1024 * 1024 + 1);
    await session(client).writeFile?.('/big.bin', data);

    expect(ops.some((entry) => entry.op === 'write_file')).toBe(false);
    expect(ops[ops.length - 1]?.op).toBe('upload_commit');
    const chunks = ops.filter((entry) => entry.op === 'upload_chunk');
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((entry) => entry.size ?? 0))).toBeLessThanOrEqual(256 * 1024);
    expect(written).toBe(data.byteLength);
  });

  it('gives listing entries one canonical path form under the current folder', async () => {
    const client = baseClient({
      sftpOp: async () => ({
        ok: true,
        entries: [
          { name: 'app.ts', isDir: false, size: 3, modTime: 0 },
          { name: 'src', isDir: true, size: 0, modTime: 0 }
        ]
      })
    });

    const entries = await session(client).listDir?.('.');
    expect(entries?.map((entry) => entry.path)).toEqual(['./app.ts', './src']);
  });
});

describe('createRemoteSession exec routing', () => {
  function streamingClient() {
    const calls: Array<{ via: string; command: string; options?: unknown; timeoutMs?: number }> = [];
    const client = baseClient({
      execCommand: async (command, timeoutMs) => {
        calls.push({ via: 'execCommand', command, timeoutMs });
        return { stdout: 'buffered', stderr: '', exitCode: 0 };
      },
      execStream: async (command, options) => {
        calls.push({ via: 'execStream', command, options });
        return { stdout: 'streamed', stderr: '', exitCode: 0 };
      }
    });
    return { client, calls };
  }

  it('keeps a plain gateway exec on the buffered request', async () => {
    const { client, calls } = streamingClient();
    await expect(session(client).exec('uname -a')).resolves.toMatchObject({ stdout: 'buffered' });
    expect(calls).toEqual([{ via: 'execCommand', command: 'uname -a', timeoutMs: 120_000 }]);
  });

  it('streams a gateway exec that asks for output callbacks, a signal or no retention', async () => {
    for (const options of [{ onStdout: () => undefined }, { signal: new AbortController().signal }, { retainOutput: false }]) {
      const { client, calls } = streamingClient();
      await session(client).exec('tail -f log', options);
      expect(calls).toEqual([{ via: 'execStream', command: 'tail -f log', options }]);
    }
  });

  it('passes execStream options through unchanged, retainOutput included', async () => {
    const { client, calls } = streamingClient();
    const options = { retainOutput: false, onStdout: () => undefined };
    await expect(session(client).execStream?.('journalctl -f', options)).resolves.toMatchObject({
      stdout: 'streamed'
    });
    expect(calls).toEqual([{ via: 'execStream', command: 'journalctl -f', options }]);
  });

  it('runs every relay exec through its stream with a bounded default timeout', async () => {
    const { client, calls } = streamingClient();
    const relay = createRemoteSession(client, {
      transport: 'cloudflare-relay',
      host: 'example.test',
      user: 'ubuntu',
      port: 22
    });
    await relay.exec('uname -a');
    await relay.exec('ls', { timeoutMs: 5000 });
    expect(calls).toEqual([
      { via: 'execStream', command: 'uname -a', options: { timeoutMs: 30 * 60_000 } },
      { via: 'execStream', command: 'ls', options: { timeoutMs: 5000 } }
    ]);
  });
});
