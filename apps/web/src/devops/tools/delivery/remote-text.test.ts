import { describe, expect, it } from 'vitest';
import { fakeSession } from './fake-session.js';
import { catCommand, readRemoteText } from './remote-text.js';

const path = '/etc/app/config.yml';
const cat = "cat -- '/etc/app/config.yml'";

describe('readRemoteText', () => {
  it('quotes the path in the cat command', () => {
    expect(catCommand(" /srv/it's here ")).toBe("cat -- '/srv/it'\\''s here'");
  });

  it('falls back to cat when the SFTP channel itself fails', async () => {
    const { session, commands } = fakeSession(
      { [cat]: { stdout: 'a: 1\n' } },
      {
        readFile: async () => {
          throw new Error('SFTP subsystem request failed');
        }
      }
    );
    const read = await readRemoteText(session, path, 1024);
    expect(read).toMatchObject({ ok: true, text: 'a: 1\n' });
    expect(commands).toEqual([cat]);
    expect(read.evidence.map((item) => item.command)).toEqual(['SFTP read /etc/app/config.yml', cat]);
  });

  it('trusts an SFTP answer about the file itself instead of retrying with cat', async () => {
    const { session, commands } = fakeSession(
      {},
      {
        readFile: async () => {
          throw new Error('permission denied');
        }
      }
    );
    const read = await readRemoteText(session, path, 1024);
    expect(read).toMatchObject({ ok: false, denied: true, missing: false });
    expect(commands).toEqual([]);
  });

  it('refuses binary content on either path', async () => {
    const sftp = fakeSession(
      {},
      {
        readFile: async () => {
          throw new Error(`${path} is not valid UTF-8 text; refusing to open it in the editor`);
        }
      }
    );
    expect(await readRemoteText(sftp.session, path, 1024)).toMatchObject({ ok: false, error: `${path} is not a UTF-8 text file` });
    expect(sftp.commands).toEqual([]);

    const shell = fakeSession({ [cat]: { stdout: 'ELF\uFFFD\uFFFD' } });
    expect(await readRemoteText(shell.session, path, 1024)).toMatchObject({ ok: false, error: `${path} is not a UTF-8 text file` });
  });

  it('refuses a file over the size cap rather than working on part of it', async () => {
    const { session } = fakeSession({ [cat]: { stdout: 'é'.repeat(600) } });
    const read = await readRemoteText(session, path, 1024);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toMatch(/larger than 1 KiB/);
  });

  it('reports a missing file from the cat error', async () => {
    const { session } = fakeSession({ [cat]: { exitCode: 1, stderr: `cat: ${path}: No such file or directory\n` } });
    expect(await readRemoteText(session, path, 1024)).toMatchObject({ ok: false, missing: true, denied: false });
  });
});
