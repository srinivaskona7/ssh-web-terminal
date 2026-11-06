import { describe, expect, it, vi } from 'vitest';
import {
  readRemoteFile,
  writeRemoteFile,
  REMOTE_INLINE_WRITE_BYTES,
  type SftpOp
} from './remote-file-io';
import { bytesToBase64 } from '../vault/ssh-wire';

/**
 * Regression cover for the two data-loss bugs found in review: a single
 * `read_file` truncates at the gateway's 256 KiB page, and a single
 * `write_file` frame dies above ~3 MiB because base64 + JSON cross the 4 MiB
 * frame ceiling.
 */

const fileOf = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
  return bytes;
};

/** A gateway that answers `read_file` one 256 KiB page at a time. */
const pagingReader = (file: Uint8Array, page = 256 * 1024) => {
  const calls: Array<Record<string, unknown>> = [];
  const op: SftpOp = vi.fn(async (req) => {
    calls.push(req);
    const offset = typeof req.offset === 'number' ? req.offset : 0;
    const chunk = file.subarray(offset, Math.min(offset + page, file.byteLength));
    return {
      ok: true,
      size: file.byteLength,
      offset: offset + chunk.byteLength,
      dataBase64: bytesToBase64(chunk)
    };
  });
  return { op, calls };
};

describe('readRemoteFile', () => {
  it('pages past 256 KiB instead of returning the first chunk', async () => {
    const file = fileOf(700 * 1024);
    const { op, calls } = pagingReader(file);

    const result = await readRemoteFile(op, '/var/log/app.log');

    expect('bytes' in result).toBe(true);
    if (!('bytes' in result)) return;
    expect(result.bytes.byteLength).toBe(file.byteLength);
    expect(Array.from(result.bytes.subarray(0, 8))).toEqual(Array.from(file.subarray(0, 8)));
    expect(Array.from(result.bytes.subarray(-8))).toEqual(Array.from(file.subarray(-8)));
    expect(calls.length).toBeGreaterThan(2);
  });

  it('refuses a short read rather than handing back partial bytes', async () => {
    const file = fileOf(600 * 1024);
    let calls = 0;
    const op: SftpOp = vi.fn(async () => {
      calls += 1;
      return {
        ok: true,
        size: file.byteLength,
        offset: 128,
        dataBase64: calls === 1 ? bytesToBase64(file.subarray(0, 128)) : ''
      };
    });

    const result = await readRemoteFile(op, '/etc/big.conf');

    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('128 of');
  });

  it('refuses a file above the cap', async () => {
    const op: SftpOp = vi.fn(async () => ({ ok: true, size: 10, dataBase64: '' }));

    const result = await readRemoteFile(op, '/etc/big.conf', 5);

    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('above the 5-byte browser cap');
  });

  it('surfaces the gateway error', async () => {
    const op: SftpOp = vi.fn(async () => ({ ok: false, error: 'no such file' }));

    const result = await readRemoteFile(op, '/missing');

    expect(result).toEqual({ error: 'no such file' });
  });
});

describe('writeRemoteFile', () => {
  it('sends a small file in one write_file', async () => {
    const bytes = fileOf(1024);
    const calls: Array<Record<string, unknown>> = [];
    const op: SftpOp = vi.fn(async (req) => {
      calls.push(req);
      return { ok: true };
    });

    expect(await writeRemoteFile(op, '/tmp/small.txt', bytes)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: 'write_file', path: '/tmp/small.txt' });
  });

  it('chunks a 3 MiB file, because base64 turns it into a 4 MiB frame plus envelope', async () => {
    const bytes = fileOf(3 * 1024 * 1024);
    const calls: Array<Record<string, unknown>> = [];
    const op: SftpOp = vi.fn(async (req) => {
      calls.push(req);
      if (req.op === 'upload_init') return { ok: true, offset: 0 };
      if (req.op === 'upload_chunk') {
        return { ok: true, offset: (req.offset as number) + (req.size as number) };
      }
      return { ok: true };
    });

    expect(await writeRemoteFile(op, '/tmp/exactly-3mib.bin', bytes)).toBeNull();
    expect(calls.some((c) => c.op === 'write_file')).toBe(false);
    expect(calls.some((c) => c.op === 'upload_init')).toBe(true);
  });

  it('chunks a file above the inline limit and commits it', async () => {
    const bytes = fileOf(REMOTE_INLINE_WRITE_BYTES + 512 * 1024);
    const calls: Array<Record<string, unknown>> = [];
    const op: SftpOp = vi.fn(async (req) => {
      calls.push(req);
      if (req.op === 'upload_init') return { ok: true, offset: 0 };
      if (req.op === 'upload_chunk') {
        return { ok: true, offset: (req.offset as number) + (req.size as number) };
      }
      return { ok: true };
    });

    expect(await writeRemoteFile(op, '/tmp/big.bin', bytes)).toBeNull();

    const kinds = calls.map((c) => c.op);
    expect(kinds).toContain('upload_init');
    expect(kinds).toContain('upload_commit');
    expect(kinds).not.toContain('write_file');
    const chunks = calls.filter((c) => c.op === 'upload_chunk');
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk fits the frame budget.
    for (const c of chunks) expect(c.size as number).toBeLessThanOrEqual(256 * 1024);
  });

  it('refuses to resume over a stale part file', async () => {
    const op: SftpOp = vi.fn(async (req) => {
      if (req.op === 'upload_init') return { ok: true, offset: 4096 };
      return { ok: true };
    });

    const error = await writeRemoteFile(op, '/tmp/big.bin', fileOf(REMOTE_INLINE_WRITE_BYTES + 1));

    expect(error).toContain('already holds 4096 bytes');
  });

  it('reports a rejected chunk', async () => {
    const op: SftpOp = vi.fn(async (req) => {
      if (req.op === 'upload_init') return { ok: true, offset: 0 };
      if (req.op === 'upload_chunk') return { ok: false, error: 'disk full' };
      return { ok: true };
    });

    const error = await writeRemoteFile(op, '/tmp/big.bin', fileOf(REMOTE_INLINE_WRITE_BYTES + 1));

    expect(error).toBe('disk full');
  });

  it('reports a failed commit', async () => {
    const op: SftpOp = vi.fn(async (req) => {
      if (req.op === 'upload_init') return { ok: true, offset: 0 };
      if (req.op === 'upload_chunk') {
        return { ok: true, offset: (req.offset as number) + (req.size as number) };
      }
      if (req.op === 'upload_commit') return { ok: false, error: 'rename failed' };
      return { ok: true };
    });

    const error = await writeRemoteFile(op, '/tmp/big.bin', fileOf(REMOTE_INLINE_WRITE_BYTES + 1));

    expect(error).toBe('rename failed');
  });
});
