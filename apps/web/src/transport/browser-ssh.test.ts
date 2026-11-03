import { describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { BrowserSshRelaySessionClient } from './browser-ssh-client.js';
import { bytesToBase64 } from '../vault/ssh-wire.js';

const subtle = (globalThis.crypto?.subtle ?? webcrypto.subtle) as SubtleCrypto;

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

function writeUint32BE(val: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, val >>> 0, false);
  return b;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0, false);
}

function sshString(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return concatBytes(writeUint32BE(bytes.byteLength), bytes);
}

function sshMpint(rawUnsignedBe: Uint8Array): Uint8Array {
  let start = 0;
  while (start < rawUnsignedBe.byteLength && rawUnsignedBe[start] === 0) start++;
  if (start === rawUnsignedBe.byteLength) return writeUint32BE(0);
  const stripped = rawUnsignedBe.subarray(start);
  if ((stripped[0] ?? 0) & 0x80) {
    const padded = new Uint8Array(stripped.byteLength + 1);
    padded[0] = 0;
    padded.set(stripped, 1);
    return sshString(padded);
  }
  return sshString(stripped);
}

function incrementCounter128(counter: Uint8Array, blocks: number): void {
  let carry = blocks >>> 0;
  for (let i = 15; i >= 0 && carry > 0; i--) {
    const sum = (counter[i] ?? 0) + (carry & 0xff);
    counter[i] = sum & 0xff;
    carry = (carry >>> 8) + (sum >>> 8);
  }
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', data as BufferSource));
}

async function deriveKey(
  kMpint: Uint8Array,
  hRaw: Uint8Array,
  letter: string,
  sessionId: Uint8Array,
  neededBytes: number
): Promise<Uint8Array> {
  const ch = new Uint8Array([letter.charCodeAt(0)]);
  let keyMat = await sha256(concatBytes(kMpint, hRaw, ch, sessionId));
  while (keyMat.byteLength < neededBytes) {
    const nextBlock = await sha256(concatBytes(kMpint, hRaw, keyMat));
    keyMat = concatBytes(keyMat, nextBlock);
  }
  return keyMat.subarray(0, neededBytes);
}

/**
 * Isolated RFC 4253/4252/4254 SSH-2.0 Test Fixture speaking real binary SSH packets
 * (ecdh-sha2-nistp256, ssh-ed25519 host key, aes128-ctr + hmac-sha2-256, password/publickey userauth,
 * multi-channel PTY shell, window-change resize, and exec channels).
 */
class IsolatedSsh2ServerFixture {
  public lastResize: { cols: number; rows: number } | null = null;
  public openedPtyChannels: number[] = [];
  public directTcpChannels = new Set<number>();
  public files = new Map<string, string>([['README.md', '# WebSSH Relay Server']]);
  public closed = false;

  private inBuffer: Uint8Array = new Uint8Array(0);
  private clientVersion = '';
  private serverVersion = 'SSH-2.0-OpenSSH_9.6_IsolatedFixture';
  private serverKexInitPayload: Uint8Array = new Uint8Array(0);
  private clientKexInitPayload: Uint8Array = new Uint8Array(0);
  private seqIn = 0;
  private seqOut = 0;
  private encryptedIn = false;
  private encryptedOut = false;
  private encKeyS2C: CryptoKey | null = null;
  private encKeyC2S: CryptoKey | null = null;
  private macKeyS2C: CryptoKey | null = null;
  private macKeyC2S: CryptoKey | null = null;
  private ivS2C: Uint8Array = new Uint8Array(16);
  private ivC2S: Uint8Array = new Uint8Array(16);
  private processing = Promise.resolve();

  constructor(
    private readonly hostKeyPair: CryptoKeyPair,
    private readonly hostKeyBlob: Uint8Array,
    private readonly onSendToClient: (chunk: Uint8Array) => void,
    private readonly expectedPassword = 'testpass123'
  ) {}

  startBanner(): void {
    this.onSendToClient(
      new TextEncoder().encode(`${this.serverVersion}${String.fromCharCode(13, 10)}`)
    );
  }

  receiveFromClient(chunk: Uint8Array): void {
    this.inBuffer = concatBytes(this.inBuffer, chunk);
    this.processing = this.processing
      .then(() => this.processInbound())
      .catch((err) => {
        console.error('FIXTURE_ERR:', err);
      });
  }

  private async sendPacket(payload: Uint8Array): Promise<void> {
    if (this.closed) return;
    const blockSize = this.encryptedOut ? 16 : 8;
    const unpadded = 4 + 1 + payload.byteLength;
    let padLen = blockSize - (unpadded % blockSize);
    if (padLen < 4) padLen += blockSize;
    const padding = new Uint8Array(padLen);
    const pktLen = 1 + payload.byteLength + padLen;
    const plain = concatBytes(writeUint32BE(pktLen), new Uint8Array([padLen]), payload, padding);
    const seq = this.seqOut;
    this.seqOut = (this.seqOut + 1) >>> 0;

    if (!this.encryptedOut) {
      this.onSendToClient(plain);
      return;
    }

    const macInput = concatBytes(writeUint32BE(seq), plain);
    const mac = new Uint8Array(
      await subtle.sign('HMAC', this.macKeyS2C!, macInput as BufferSource)
    );
    const cipher = new Uint8Array(
      await subtle.encrypt(
        { name: 'AES-CTR', counter: this.ivS2C as BufferSource, length: 128 },
        this.encKeyS2C!,
        plain as BufferSource
      )
    );
    incrementCounter128(this.ivS2C, plain.byteLength / 16);
    this.onSendToClient(concatBytes(cipher, mac));
  }

  private async tryReadPacket(): Promise<Uint8Array | null> {
    if (!this.encryptedIn) {
      if (this.inBuffer.byteLength < 5) return null;
      const pktLen = readUint32BE(this.inBuffer, 0);
      const total = 4 + pktLen;
      if (this.inBuffer.byteLength < total) return null;
      const padLen = this.inBuffer[4]!;
      const payload = this.inBuffer.subarray(5, total - padLen);
      this.inBuffer = this.inBuffer.subarray(total);
      this.seqIn = (this.seqIn + 1) >>> 0;
      return new Uint8Array(payload);
    }

    if (this.inBuffer.byteLength < 16 + 32) return null;
    const previewCounter = new Uint8Array(this.ivC2S);
    const firstBlock = new Uint8Array(
      await subtle.decrypt(
        { name: 'AES-CTR', counter: previewCounter as BufferSource, length: 128 },
        this.encKeyC2S!,
        this.inBuffer.subarray(0, 16) as BufferSource
      )
    );
    const pktLen = readUint32BE(firstBlock, 0);
    const cipherLen = 4 + pktLen;
    const totalWire = cipherLen + 32;
    if (this.inBuffer.byteLength < totalWire) return null;

    const cipherBytes = this.inBuffer.subarray(0, cipherLen);
    this.inBuffer = this.inBuffer.subarray(totalWire);
    const plain = new Uint8Array(
      await subtle.decrypt(
        { name: 'AES-CTR', counter: this.ivC2S as BufferSource, length: 128 },
        this.encKeyC2S!,
        cipherBytes as BufferSource
      )
    );
    incrementCounter128(this.ivC2S, cipherLen / 16);
    this.seqIn = (this.seqIn + 1) >>> 0;
    const padLen = plain[4]!;
    return new Uint8Array(plain.subarray(5, cipherLen - padLen));
  }

  private async processInbound(): Promise<void> {
    if (!this.clientVersion) {
      const nl = this.inBuffer.indexOf(0x0a);
      if (nl === -1) return;
      this.clientVersion = new TextDecoder()
        .decode(this.inBuffer.subarray(0, nl))
        .trim();
      this.inBuffer = this.inBuffer.subarray(nl + 1);

      // Send server KEXINIT
      const cookie = new Uint8Array(16);
      this.serverKexInitPayload = concatBytes(
        new Uint8Array([20]),
        cookie,
        sshString('ecdh-sha2-nistp256'),
        sshString('ssh-ed25519'),
        sshString('aes128-ctr'),
        sshString('aes128-ctr'),
        sshString('hmac-sha2-256'),
        sshString('hmac-sha2-256'),
        sshString('none'),
        sshString('none'),
        sshString(''),
        sshString(''),
        new Uint8Array([0]),
        writeUint32BE(0)
      );
      await this.sendPacket(this.serverKexInitPayload);
    }

    while (this.inBuffer.byteLength > 0) {
      const pkt = await this.tryReadPacket();
      if (!pkt) break;
      await this.handlePacket(pkt);
    }
  }

  private async handlePacket(payload: Uint8Array): Promise<void> {
    const msgType = payload[0]!;
    let offset = 1;
    const readUint32 = (): number => {
      const v = readUint32BE(payload, offset);
      offset += 4;
      return v;
    };
    const readBytes = (): Uint8Array => {
      const len = readUint32();
      const b = new Uint8Array(payload.subarray(offset, offset + len));
      offset += len;
      return b;
    };
    const readStr = (): string => new TextDecoder().decode(readBytes());

    if (msgType === 20) {
      this.clientKexInitPayload = payload;
      return;
    }

    if (msgType === 30) {
      // SSH_MSG_KEX_ECDH_INIT
      const clientQ = readBytes();
      const serverEcdh = await subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
      );
      const serverQ = new Uint8Array(await subtle.exportKey('raw', serverEcdh.publicKey));
      const clientPub = await subtle.importKey(
        'raw',
        clientQ as BufferSource,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );
      const sharedRaw = new Uint8Array(
        await subtle.deriveBits({ name: 'ECDH', public: clientPub }, serverEcdh.privateKey, 256)
      );
      const kMpint = sshMpint(sharedRaw);

      const hInput = concatBytes(
        sshString(this.clientVersion),
        sshString(this.serverVersion),
        sshString(this.clientKexInitPayload),
        sshString(this.serverKexInitPayload),
        sshString(this.hostKeyBlob),
        sshString(clientQ),
        sshString(serverQ),
        kMpint
      );
      const hRaw = await sha256(hInput);
      const rawSig = new Uint8Array(
        await subtle.sign({ name: 'Ed25519' }, this.hostKeyPair.privateKey, hRaw as BufferSource)
      );
      const sigBlob = concatBytes(sshString('ssh-ed25519'), sshString(rawSig));

      await this.sendPacket(
        concatBytes(
          new Uint8Array([31]),
          sshString(this.hostKeyBlob),
          sshString(serverQ),
          sshString(sigBlob)
        )
      );

      this.ivC2S = await deriveKey(kMpint, hRaw, 'A', hRaw, 16);
      this.ivS2C = await deriveKey(kMpint, hRaw, 'B', hRaw, 16);
      const keyC2S = await deriveKey(kMpint, hRaw, 'C', hRaw, 16);
      const keyS2C = await deriveKey(kMpint, hRaw, 'D', hRaw, 16);
      const macC2S = await deriveKey(kMpint, hRaw, 'E', hRaw, 32);
      const macS2C = await deriveKey(kMpint, hRaw, 'F', hRaw, 32);

      this.encKeyC2S = await subtle.importKey('raw', keyC2S as BufferSource, { name: 'AES-CTR' }, false, ['decrypt']);
      this.encKeyS2C = await subtle.importKey('raw', keyS2C as BufferSource, { name: 'AES-CTR' }, false, ['encrypt']);
      this.macKeyC2S = await subtle.importKey('raw', macC2S as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      this.macKeyS2C = await subtle.importKey('raw', macS2C as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

      await this.sendPacket(new Uint8Array([21])); // SSH_MSG_NEWKEYS
      this.encryptedOut = true;
      return;
    }

    if (msgType === 21) {
      this.encryptedIn = true;
      return;
    }

    if (msgType === 5) {
      // SERVICE_REQUEST
      const svc = readStr();
      await this.sendPacket(concatBytes(new Uint8Array([6]), sshString(svc)));
      return;
    }

    if (msgType === 50) {
      // USERAUTH_REQUEST
      readStr(); // user
      readStr(); // service
      const method = readStr();
      if (method === 'password') {
        offset += 1; // boolean FALSE
        const pass = readStr();
        if (pass === this.expectedPassword) {
          await this.sendPacket(new Uint8Array([52])); // USERAUTH_SUCCESS
        } else {
          await this.sendPacket(
            concatBytes(new Uint8Array([51]), sshString('password,publickey'), new Uint8Array([0]))
          );
        }
      } else if (method === 'publickey') {
        await this.sendPacket(new Uint8Array([52])); // USERAUTH_SUCCESS
      }
      return;
    }

    if (msgType === 90) {
      // CHANNEL_OPEN ("session" or "direct-tcpip")
      const chanType = readStr();
      const senderCh = readUint32();
      if (chanType === 'direct-tcpip') {
        this.directTcpChannels.add(senderCh);
      }
      await this.sendPacket(
        concatBytes(
          new Uint8Array([91]),
          writeUint32BE(senderCh),
          writeUint32BE(senderCh),
          writeUint32BE(2097152),
          writeUint32BE(32768)
        )
      );
      return;
    }

    if (msgType === 94) {
      // CHANNEL_DATA (used by direct-tcpip HTTP preview or interactive PTY)
      const recipientCh = readUint32();
      const data = readBytes();
      if (this.directTcpChannels.has(recipientCh)) {
        const reqText = new TextDecoder().decode(data);
        if (reqText.startsWith('GET ')) {
          const crlf = String.fromCharCode(13, 10);
          const httpResp = `HTTP/1.1 200 OK${crlf}Content-Type: application/json${crlf}${crlf}{"status":"ok","tunnel":"direct-tcpip"}`;
          await this.sendPacket(
            concatBytes(new Uint8Array([94]), writeUint32BE(recipientCh), sshString(httpResp))
          );
          await this.sendPacket(concatBytes(new Uint8Array([97]), writeUint32BE(recipientCh)));
        }
      }
      return;
    }

    if (msgType === 98) {
      // CHANNEL_REQUEST
      const recipientCh = readUint32();
      const reqType = readStr();
      const wantReply = payload[offset++]! !== 0;
      if (reqType === 'pty-req') {
        this.openedPtyChannels.push(recipientCh);
      } else if (reqType === 'window-change') {
        const cols = readUint32();
        const rows = readUint32();
        this.lastResize = { cols, rows };
      } else if (reqType === 'exec') {
        const cmd = readStr();
        if (wantReply) {
          await this.sendPacket(concatBytes(new Uint8Array([99]), writeUint32BE(recipientCh)));
        }
        const lf = String.fromCharCode(10);
        let out = '';
        let errOut = '';
        let exitCode = 0;
        if (cmd === 'uname -s') {
          out = `Linux${lf}`;
        } else if (cmd === 'pwd') {
          out = `/home/ubuntu${lf}`;
        } else if (cmd.startsWith('ls -la')) {
          out = `-rw-r--r-- 1 ubuntu ubuntu ${this.files.get('README.md')?.length ?? 24} Nov 2 12:00 README.md${lf}`;
        } else if (cmd.startsWith('cat ')) {
          const target = cmd.slice(4).trim();
          out = this.files.get(target) ?? `# WebSSH Relay Server${lf}`;
        } else if (cmd.startsWith('write-file ')) {
          const parts = cmd.split(' ');
          const target = parts[1] ?? 'README.md';
          const b64 = parts[2] ?? '';
          const decoded = new TextDecoder().decode(
            Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          );
          this.files.set(target, decoded);
        } else if (cmd.startsWith('chmod ')) {
          out = '';
        } else if (cmd.startsWith('printf ')) {
          out = cmd.slice(7).replace(/^['"]|['"]$/g, '');
        } else {
          errOut = `bash: ${cmd}: command not found${lf}`;
          exitCode = 127;
        }
        if (out) {
          await this.sendPacket(
            concatBytes(new Uint8Array([94]), writeUint32BE(recipientCh), sshString(out))
          );
        }
        if (errOut) {
          await this.sendPacket(
            concatBytes(
              new Uint8Array([95]),
              writeUint32BE(recipientCh),
              writeUint32BE(1),
              sshString(errOut)
            )
          );
        }
        // exit-status
        await this.sendPacket(
          concatBytes(
            new Uint8Array([98]),
            writeUint32BE(recipientCh),
            sshString('exit-status'),
            new Uint8Array([0]),
            writeUint32BE(exitCode)
          )
        );
        // CHANNEL_CLOSE
        await this.sendPacket(concatBytes(new Uint8Array([97]), writeUint32BE(recipientCh)));
        return;
      }
      if (wantReply) {
        await this.sendPacket(concatBytes(new Uint8Array([99]), writeUint32BE(recipientCh)));
      }
      if (reqType === 'shell') {
        await this.sendPacket(
          concatBytes(
            new Uint8Array([94]),
            writeUint32BE(recipientCh),
            sshString(
              `Welcome to Ubuntu 24.04 LTS (Cloudflare Relay SSH-2.0)${String.fromCharCode(13, 10)}ubuntu@ec2:~$ `
            )
          )
        );
      }
    }
  }
}

describe('BrowserSshRelaySessionClient + Cloudflare Worker Relay End-to-End SSH-2.0 (Step 18)', () => {
  it('completes real RFC 4253/4252/4254 SSH-2.0 handshake over the Worker relay, verifies host keys, rejects bad credentials, runs commands, resizes PTY, opens multiple tab channels, and cleans up', async () => {
    const hostKeyPair = (await subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify'
    ])) as CryptoKeyPair;
    const rawPub32 = new Uint8Array(await subtle.exportKey('raw', hostKeyPair.publicKey));
    const hostKeyBlob = concatBytes(sshString('ssh-ed25519'), sshString(rawPub32));

    const prevWs = globalThis.WebSocket;
    let activeFixture: IsolatedSsh2ServerFixture | null = null;

    class RelayBridgedWebSocket {
      static readonly OPEN = 1;
      public readyState = 0;
      public binaryType = 'arraybuffer';
      public onopen: (() => void) | null = null;
      public onmessage: ((ev: { data: Uint8Array }) => void) | null = null;
      public onerror: (() => void) | null = null;
      public onclose: ((ev: { code: number; reason: string }) => void) | null = null;

      private fixture: IsolatedSsh2ServerFixture;

      constructor(public readonly url: string) {
        this.fixture = new IsolatedSsh2ServerFixture(
          hostKeyPair,
          hostKeyBlob,
          (chunk) => {
            if (this.readyState === 1) {
              this.onmessage?.({ data: new Uint8Array(chunk) });
            }
          },
          'testpass123'
        );
        activeFixture = this.fixture;

        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
          this.fixture.startBanner();
        }, 2);
      }

      send(data: Uint8Array | ArrayBuffer): void {
        const bytes =
          ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        this.fixture.receiveFromClient(bytes);
      }

      close(code = 1000, reason = ''): void {
        this.readyState = 3;
        this.fixture.closed = true;
        this.onclose?.({ code, reason });
      }
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      value: RelayBridgedWebSocket,
      writable: true,
      configurable: true
    });

    try {
      // 1. Host-key mismatch rejection test
      const mismatchClient = new BrowserSshRelaySessionClient({
        transportMode: 'cloudflare-relay',
        gatewayUrl: 'wss://webssh-studio-relay.example.workers.dev/ws',
        gatewayAuthToken: 'cf-relay-secret-2026',
        host: 'ec2-54-210-11-99.compute.amazonaws.com',
        port: 22,
        user: 'ubuntu',
        authMethod: 'password',
        password: 'testpass123',
        cols: 80,
        rows: 24,
        onPtyData: () => {},
        onHostKeyPrompt: async () => false // Reject host key!
      });
      await expect(mismatchClient.connect()).rejects.toThrow(/HOST_KEY_MISMATCH/);

      // 2. Bad password rejection test
      const badPassClient = new BrowserSshRelaySessionClient({
        transportMode: 'cloudflare-relay',
        gatewayUrl: 'wss://webssh-studio-relay.example.workers.dev/ws',
        gatewayAuthToken: 'cf-relay-secret-2026',
        host: 'ec2-54-210-11-99.compute.amazonaws.com',
        port: 22,
        user: 'ubuntu',
        authMethod: 'password',
        password: 'wrong-password',
        cols: 80,
        rows: 24,
        onPtyData: () => {},
        onHostKeyPrompt: async () => true
      });
      await expect(badPassClient.connect()).rejects.toThrow(/SSH_CONNECT_FAILED/);

      // 3. Valid connection, PTY stream, exec commands, PTY resize, multi-tab channel, and feature gating
      const ptyChunks: string[] = [];
      let verifiedFingerprint = '';
      const client = new BrowserSshRelaySessionClient({
        transportMode: 'cloudflare-relay',
        gatewayUrl: 'wss://webssh-studio-relay.example.workers.dev/ws',
        gatewayAuthToken: 'cf-relay-secret-2026',
        host: 'ec2-54-210-11-99.compute.amazonaws.com',
        port: 22,
        user: 'ubuntu',
        authMethod: 'password',
        password: 'testpass123',
        cols: 80,
        rows: 24,
        onPtyData: (_ch, bytes) => {
          ptyChunks.push(new TextDecoder().decode(bytes));
        },
        onHostKeyPrompt: async (prompt) => {
          verifiedFingerprint = prompt.fingerprint;
          expect(prompt.publicKeyBase64).toBe(bytesToBase64(hostKeyBlob));
          return true;
        }
      });

      const meta = await client.connect();
      expect(verifiedFingerprint).toMatch(/^SHA256:/);
      expect(meta.serverVersion).toBe('SSH-2.0-OpenSSH_9.6_IsolatedFixture');
      expect(meta.cipher).toBe('aes128-ctr+hmac-sha2-256');
      expect(meta.sftpReady).toBe(true);
      expect(meta.resumeToken).toMatch(/^cf_resume_/);

      await new Promise((r) => setTimeout(r, 15));
      expect(ptyChunks.join('')).toContain('Welcome to Ubuntu 24.04 LTS');

      // Verify 4 MiB Ring-Buffer Replay recorded the initial PTY output
      const replayFrames = client.getReplayFramesAfter(0);
      expect(replayFrames.length).toBeGreaterThan(0);

      // Execute real POSIX commands over SSH-2.0 exec channels
      const unameRes = await client.execCommand('uname -s');
      expect(unameRes.stdout.trim()).toBe('Linux');
      expect(unameRes.exitCode).toBe(0);

      const pwdRes = await client.execCommand('pwd');
      expect(pwdRes.stdout.trim()).toBe('/home/ubuntu');

      const badCmdRes = await client.execCommand('nonexistent_cmd');
      expect(badCmdRes.exitCode).toBe(127);
      expect(badCmdRes.stderr).toContain('command not found');

      // Resize PTY channel
      client.resizeChannel(1, 132, 42);
      await vi.waitFor(() => expect(activeFixture!.lastResize).toEqual({ cols: 132, rows: 42 }));

      // Open independent second PTY channel (Tab 2)
      const tab2 = await client.openChannel(100, 30);
      expect(tab2.ok).toBe(true);
      expect(tab2.channel).toBe(5);
      expect(activeFixture!.openedPtyChannels.length).toBe(2);

      // Verify SFTP list, Remote File Editor read/write, and chmod over Cloudflare Relay SSH-2.0
      const sftpListRes = await client.sftpOp({ op: 'list', path: '~' });
      expect(sftpListRes.ok).toBe(true);
      expect(sftpListRes.entries?.[0]?.name).toBe('README.md');

      const writeRes = await client.sftpOp({
        op: 'write_file',
        path: 'README.md',
        dataBase64: bytesToBase64(new TextEncoder().encode('# Updated via Cloudflare Relay'))
      });
      expect(writeRes.ok).toBe(true);

      const readRes = await client.sftpOp({ op: 'read_file', path: 'README.md' });
      expect(readRes.ok).toBe(true);
      expect(atob(readRes.dataBase64 ?? '')).toBe('# Updated via Cloudflare Relay');

      const chmodRes = await client.sftpOp({ op: 'chmod', path: 'README.md', mode: '0400' });
      expect(chmodRes.ok).toBe(true);
      expect(chmodRes.mode).toBe('0400');

      // Verify RFC 4254 direct-tcpip TCP Tunnel HTTP Preview over Cloudflare Relay SSH-2.0
      const tunPreviewRes = await client.tunnelOp({
        op: 'http_preview',
        remoteHost: '127.0.0.1',
        remotePort: 8080,
        httpPath: '/healthz'
      });
      expect(tunPreviewRes.ok).toBe(true);
      expect(tunPreviewRes.statusCode).toBe(200);
      expect(tunPreviewRes.bodyPreview).toContain('direct-tcpip');

      // Disconnect cleanup
      client.close();
      await new Promise((r) => setTimeout(r, 10));
      expect(activeFixture!.closed).toBe(true);

      // 4. RSA PEM (rsa-sha2-256) in-browser publickey authentication test
      const rsaKeyPair = (await subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256'
        },
        true,
        ['sign', 'verify']
      )) as CryptoKeyPair;
      const pkcs8Rsa = new Uint8Array(await subtle.exportKey('pkcs8', rsaKeyPair.privateKey));
      const lf = String.fromCharCode(10);
      const rsaPem = `-----BEGIN PRIVATE KEY-----${lf}${bytesToBase64(pkcs8Rsa)}${lf}-----END PRIVATE KEY-----`;

      const rsaClient = new BrowserSshRelaySessionClient({
        transportMode: 'cloudflare-relay',
        gatewayUrl: 'wss://webssh-studio-relay.example.workers.dev/ws',
        gatewayAuthToken: 'cf-relay-secret-2026',
        host: 'ec2-54-210-11-99.compute.amazonaws.com',
        port: 22,
        user: 'ubuntu',
        authMethod: 'private_key',
        privateKeyPem: rsaPem,
        cols: 80,
        rows: 24,
        onPtyData: () => {},
        onHostKeyPrompt: async () => true
      });
      const rsaMeta = await rsaClient.connect();
      expect(rsaMeta.type).toBe('connected');
      rsaClient.close();
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', {
        value: prevWs,
        writable: true,
        configurable: true
      });
    }
  });
});
