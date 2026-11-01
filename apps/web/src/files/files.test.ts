import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLOB_DOWNLOAD_CAP_BYTES,
  IncrementalSha256,
  RemoteFileEditor,
  StorageGuard,
  TransferQueue,
  buildStreamingZipArchive,
  sha256Hex,
  sortAndFilterEntries,
  type SftpRpcSender,
  type UploadSource
} from './index';
import type { ControlMessage } from '@webssh/protocol';

function createMemorySource(name: string, remotePath: string, data: Uint8Array): UploadSource {
  return {
    name,
    remotePath,
    size: data.byteLength,
    sliceChunk: async (offset, length) => data.slice(offset, offset + length)
  };
}

function createFakeSftpBackend() {
  const partFiles = new Map<string, Uint8Array>();
  const finalFiles = new Map<string, Uint8Array>();
  const dirs = new Set<string>();

  const rpc: SftpRpcSender = async (msg) => {
    const res: Extract<ControlMessage, { type: 'sftp_result' }> = {
      type: 'sftp_result',
      opId: msg.opId,
      ok: true
    };
    if (msg.op === 'mkdir') {
      dirs.add(msg.path);
      return res;
    }
    if (msg.op === 'upload_init') {
      const existing = partFiles.get(msg.path);
      res.offset = existing ? existing.byteLength : 0;
      if (!existing) {
        partFiles.set(msg.path, new Uint8Array(0));
      }
      return res;
    }
    if (msg.op === 'upload_chunk') {
      const binary = atob(msg.dataBase64 ?? '');
      const chunk = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        chunk[i] = binary.charCodeAt(i);
      }
      const existing = partFiles.get(msg.path) ?? new Uint8Array(0);
      const offset = msg.offset ?? 0;
      const next = new Uint8Array(Math.max(existing.byteLength, offset + chunk.byteLength));
      next.set(existing, 0);
      next.set(chunk, offset);
      partFiles.set(msg.path, next);
      res.offset = offset + chunk.byteLength;
      return res;
    }
    if (msg.op === 'upload_commit') {
      const part = partFiles.get(msg.path);
      if (!part) {
        return { ...res, ok: false, error: 'missing part' };
      }
      const sha = new IncrementalSha256().update(part).digestHex();
      if (msg.sha256 && sha !== msg.sha256) {
        return { ...res, ok: false, error: 'checksum mismatch' };
      }
      finalFiles.set(msg.path, part);
      partFiles.delete(msg.path);
      return res;
    }
    if (msg.op === 'download_read' || msg.op === 'read_file') {
      const file = finalFiles.get(msg.path);
      if (!file) {
        return { ...res, ok: false, error: 'not found' };
      }
      const offset = msg.offset ?? 0;
      const size = msg.size ?? 256 * 1024;
      const slice = file.slice(offset, offset + size);
      let bin = '';
      for (let i = 0; i < slice.byteLength; i++) {
        bin += String.fromCharCode(slice[i]!);
      }
      res.dataBase64 = btoa(bin);
      res.size = file.byteLength;
      res.offset = offset + slice.byteLength;
      res.sha256 = new IncrementalSha256().update(slice).digestHex();
      return res;
    }
    if (msg.op === 'write_file') {
      const binary = atob(msg.dataBase64 ?? '');
      const raw = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        raw[i] = binary.charCodeAt(i);
      }
      finalFiles.set(msg.path, raw);
      return res;
    }
    return res;
  };

  return { rpc, partFiles, finalFiles, dirs };
}

describe('File transfers, SHA-256, StorageGuard, ZIP stream, and RemoteFileEditor (M5)', () => {
  it('matches WebCrypto SHA-256 across multi-chunk incremental updates', async () => {
    const payload = new Uint8Array(300_000);
    for (let i = 0; i < payload.byteLength; i++) {
      payload[i] = (i * 31 + 7) & 0xff;
    }
    const inc = new IncrementalSha256();
    inc.update(payload.subarray(0, 64_000));
    inc.update(payload.subarray(64_000, 199_999));
    inc.update(payload.subarray(199_999));

    const expected = await sha256Hex(payload);
    expect(inc.digestHex()).toBe(expected);
  });

  it('uploads in 256 KiB chunks and resumes cleanly from an interrupted .part offset', async () => {
    const { rpc, partFiles, finalFiles } = createFakeSftpBackend();
    const data = new Uint8Array(600 * 1024);
    for (let i = 0; i < data.byteLength; i++) {
      data[i] = (i * 17) & 0xff;
    }
    // Simulate a previous interrupted upload that wrote the first 256 KiB to .part
    partFiles.set('/home/dev/archive.tar', data.slice(0, 256 * 1024));

    const queue = new TransferQueue(rpc, new StorageGuard(), 256 * 1024);
    const item = queue.enqueueUpload(createMemorySource('archive.tar', '/home/dev/archive.tar', data));
    const finished = await queue.runUpload(item.id);

    expect(finished.status).toBe('completed');
    expect(finished.transferredBytes).toBe(data.byteLength);
    expect(finalFiles.get('/home/dev/archive.tar')).toEqual(data);
  });

  it('creates remote directories first and uploads folder trees', async () => {
    const { rpc, dirs, finalFiles } = createFakeSftpBackend();
    const queue = new TransferQueue(rpc);
    const enc = new TextEncoder();

    const completed = await queue.uploadFolder('/srv/app', [
      {
        ...createMemorySource('index.ts', '/srv/app/src/utils/index.ts', enc.encode('export const x = 1;')),
        relativePath: 'src/utils/index.ts'
      }
    ]);

    expect(completed).toHaveLength(1);
    expect(dirs.has('/srv/app/src')).toBe(true);
    expect(dirs.has('/srv/app/src/utils')).toBe(true);
    expect(finalFiles.has('/srv/app/src/utils/index.ts')).toBe(true);
  });

  it('enforces StorageGuard and refuses oversized Blob fallback downloads', async () => {
    const guard = new StorageGuard(1024 * 1024, 512 * 1024);
    expect(guard.canAllocateStorage(512 * 1024)).toBe(true);
    guard.allocateStorage(512 * 1024);
    expect(() => guard.allocateStorage(700 * 1024)).toThrow(/Storage quota exceeded/);

    const oversizedRpc: SftpRpcSender = async (msg) => ({
      type: 'sftp_result',
      opId: msg.opId,
      ok: true,
      size: DEFAULT_BLOB_DOWNLOAD_CAP_BYTES + 1024,
      offset: 0,
      dataBase64: ''
    });

    const queue = new TransferQueue(oversizedRpc, guard);
    await expect(queue.downloadFile('/var/log/huge.iso')).rejects.toThrow(/exceeds browser Blob fallback cap/);
  });

  it('builds a valid ZIP archive stream and edits remote files', async () => {
    const enc = new TextEncoder();
    const zip = buildStreamingZipArchive([
      { relativePath: 'logs/app.log', data: enc.encode('hello zip') },
      { relativePath: 'README.md', data: enc.encode('# WebSSH') }
    ]);
    // Local file header PK\x03\x04
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);

    const { rpc, finalFiles } = createFakeSftpBackend();
    finalFiles.set('/etc/app.conf', enc.encode(`PORT=8080\n`));

    const editor = new RemoteFileEditor(rpc);
    const opened = await editor.openFile('/etc/app.conf');
    expect(opened.content).toBe(`PORT=8080\n`);
    editor.updateContent('/etc/app.conf', `PORT=9090\n`);
    const saved = await editor.saveToHost('/etc/app.conf');
    expect(saved.dirty).toBe(false);
    expect(new TextDecoder().decode(finalFiles.get('/etc/app.conf'))).toBe(`PORT=9090\n`);
  });

  it('sorts directories first and filters SFTP entries', () => {
    const sorted = sortAndFilterEntries(
      [
        { name: 'zebra.txt', path: '/zebra.txt', size: 100, mode: '-rw-r--r--', modTime: 10, isDir: false },
        { name: 'alpha', path: '/alpha', size: 0, mode: 'drwxr-xr-x', modTime: 5, isDir: true },
        { name: 'app.ts', path: '/app.ts', size: 50, mode: '-rw-r--r--', modTime: 20, isDir: false }
      ],
      'a',
      'name',
      true
    );
    expect(sorted.map((e) => e.name)).toEqual(['alpha', 'app.ts', 'zebra.txt']);
  });
});
