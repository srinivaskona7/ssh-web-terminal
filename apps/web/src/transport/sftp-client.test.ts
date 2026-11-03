import { describe, expect, it } from 'vitest';
import {
  SftpClient,
  SftpError,
  SftpStatus,
  joinRemotePath,
  modeToOctalString,
  normalizeRemotePath,
  octalStringToMode
} from './sftp-client.js';
import { FakeSftpServer } from './testing/fake-sftp-server.js';

function makeClient(): { client: SftpClient; server: FakeSftpServer } {
  const server = new FakeSftpServer();
  const client = new SftpClient(server);
  server.setSendTarget((data) => client.handleData(data));
  return { client, server };
}

describe('SFTP v3 client', () => {
  it('negotiates version 3', async () => {
    const { client } = makeClient();
    await client.init();
    expect(client.negotiatedVersion).toBe(3);
  });

  it('lists directory entries without a shell command', async () => {
    const { client, server } = makeClient();
    await client.init();
    server.files.set('/home/user/notes.txt', { data: new TextEncoder().encode('hello'), mode: 0o644 });
    server.files.set('/home/user/archive.bin', { data: new Uint8Array([0, 1, 2]), mode: 0o600 });

    const entries = await client.list('/home/user');
    expect(entries.map((e) => e.name).sort()).toEqual(['archive.bin', 'notes.txt']);
    const notes = entries.find((e) => e.name === 'notes.txt')!;
    expect(notes.size).toBe(5);
    expect(notes.mode).toBe('0644');
    expect(notes.isDir).toBe(false);
  });

  it('round-trips binary content byte for byte', async () => {
    const { client, server } = makeClient();
    await client.init();
    const payload = new Uint8Array([0, 255, 0, 10, 13, 26, 128]);
    server.files.set('/home/user/blob.bin', { data: payload, mode: 0o644 });

    const read = await client.readFile('/home/user/blob.bin');
    expect([...read]).toEqual([...payload]);
  });

  it('writes atomically through a temp file and rename', async () => {
    const { client, server } = makeClient();
    await client.init();
    server.files.set('/home/user/config.yml', {
      data: new TextEncoder().encode('old'),
      mode: 0o644
    });

    const data = new TextEncoder().encode('new-content');
    const written = await client.writeFile('/home/user/config.yml', data);
    expect(written).toBe(data.byteLength);
    expect(new TextDecoder().decode(server.files.get('/home/user/config.yml')!.data)).toBe('new-content');
    // No temporary sibling survives.
    expect([...server.files.keys()].some((p) => p.includes('.webssh-tmp-'))).toBe(false);
  });

  it('maps protocol errors to typed SftpError', async () => {
    const { client } = makeClient();
    await client.init();
    await expect(client.readFile('/home/user/missing.txt')).rejects.toBeInstanceOf(SftpError);
    await expect(client.stat('/home/user/missing.txt')).rejects.toMatchObject({
      code: SftpStatus.NO_SUCH_FILE
    });
  });

  it('resumes an upload from an existing .webssh-part offset', async () => {
    const { client, server } = makeClient();
    await client.init();
    server.files.set('/home/user/big.bin.webssh-part', {
      data: new TextEncoder().encode('abc'),
      mode: 0o644
    });
    const session = await client.startUpload('/home/user/big.bin');
    expect(session.offset).toBe(3);
    await session.write(new TextEncoder().encode('def'));
    const size = await session.commit();
    expect(size).toBe(6);
    expect(new TextDecoder().decode(server.files.get('/home/user/big.bin')!.data)).toBe('abcdef');
    expect(server.files.has('/home/user/big.bin.webssh-part')).toBe(false);
  });
});

describe('remote path helpers', () => {
  it('joins and normalizes POSIX paths', () => {
    expect(joinRemotePath('/a/b', 'c')).toBe('/a/b/c');
    expect(joinRemotePath('/', 'c')).toBe('/c');
    expect(joinRemotePath('~', 'c')).toBe('c');
    expect(normalizeRemotePath('/a/./b/../c')).toBe('/a/c');
    expect(normalizeRemotePath('a/../../b')).toBe('../b');
  });

  it('converts modes', () => {
    expect(modeToOctalString(0o100644)).toBe('0644');
    expect(octalStringToMode('0750')).toBe(0o750);
    expect(() => octalStringToMode('abc')).toThrow();
  });
});
