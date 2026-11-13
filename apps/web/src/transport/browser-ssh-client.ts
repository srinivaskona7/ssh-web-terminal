import type { ControlMessage, EnvReport } from '@webssh/protocol';
import {
  base64ToBytes,
  bytesToBase64,
  p1363ToSshMpint
} from '../vault/ssh-wire.js';
import type {
  ConnectedSessionMetadata,
  ExecStreamOptions,
  LiveConnectParams
} from './transport.js';
import { ExecOutputSink, abortError } from './exec-output.js';
import { recordDiagnostic } from './diagnostics.js';
import { routeSignRequest } from './remote-signer.js';
import { prepareSessionEnv } from './session-env.js';
import {
  SftpClient,
  SftpError,
  SftpStatus,
  type SftpUploadSession
} from './sftp-client.js';


const SSH_MSG_DISCONNECT = 1;
const SSH_MSG_IGNORE = 2;
const SSH_MSG_UNIMPLEMENTED = 3;
const SSH_MSG_DEBUG = 4;
const SSH_MSG_SERVICE_REQUEST = 5;
const SSH_MSG_SERVICE_ACCEPT = 6;
const SSH_MSG_KEXINIT = 20;
const SSH_MSG_NEWKEYS = 21;
const SSH_MSG_KEX_ECDH_INIT = 30;
const SSH_MSG_KEX_ECDH_REPLY = 31;
const SSH_MSG_USERAUTH_REQUEST = 50;
const SSH_MSG_USERAUTH_FAILURE = 51;
const SSH_MSG_USERAUTH_SUCCESS = 52;
const SSH_MSG_USERAUTH_BANNER = 53;
const SSH_MSG_GLOBAL_REQUEST = 80;
const SSH_MSG_REQUEST_FAILURE = 82;
const SSH_MSG_CHANNEL_OPEN = 90;
const SSH_MSG_CHANNEL_OPEN_CONFIRMATION = 91;
const SSH_MSG_CHANNEL_OPEN_FAILURE = 92;
const SSH_MSG_CHANNEL_WINDOW_ADJUST = 93;
const SSH_MSG_CHANNEL_DATA = 94;
const SSH_MSG_CHANNEL_EXTENDED_DATA = 95;
const SSH_MSG_CHANNEL_EOF = 96;
const SSH_MSG_CHANNEL_CLOSE = 97;
const SSH_MSG_CHANNEL_REQUEST = 98;
const SSH_MSG_CHANNEL_SUCCESS = 99;
const SSH_MSG_CHANNEL_FAILURE = 100;

const CLIENT_VERSION = 'SSH-2.0-WebSSH_Studio_1.0';

function getSubtle(): SubtleCrypto {
  if (globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('WebCrypto SubtleCrypto is required for in-browser SSH-2.0');
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
  while (start < rawUnsignedBe.byteLength && rawUnsignedBe[start] === 0) {
    start++;
  }
  if (start === rawUnsignedBe.byteLength) {
    return writeUint32BE(0);
  }
  const stripped = rawUnsignedBe.subarray(start);
  if ((stripped[0] ?? 0) & 0x80) {
    const padded = new Uint8Array(stripped.byteLength + 1);
    padded[0] = 0;
    padded.set(stripped, 1);
    return sshString(padded);
  }
  return sshString(stripped);
}

class SshReader {
  private offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  readByte(): number {
    if (this.offset >= this.buf.byteLength) throw new Error('SSH packet buffer underflow');
    return this.buf[this.offset++]!;
  }

  readBoolean(): boolean {
    return this.readByte() !== 0;
  }

  readUint32(): number {
    if (this.offset + 4 > this.buf.byteLength) throw new Error('SSH packet uint32 underflow');
    const v = readUint32BE(this.buf, this.offset);
    this.offset += 4;
    return v;
  }

  readBytes(): Uint8Array {
    const len = this.readUint32();
    if (this.offset + len > this.buf.byteLength) throw new Error('SSH packet string underflow');
    const slice = new Uint8Array(this.buf.subarray(this.offset, this.offset + len));
    this.offset += len;
    return slice;
  }

  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await getSubtle().digest('SHA-256', data as BufferSource);
  return new Uint8Array(digest);
}

function incrementCounter128(counter: Uint8Array, blocks: number): void {
  let carry = blocks >>> 0;
  for (let i = 15; i >= 0 && carry > 0; i--) {
    const sum = (counter[i] ?? 0) + (carry & 0xff);
    counter[i] = sum & 0xff;
    carry = (carry >>> 8) + (sum >>> 8);
  }
}

function encodeDerLength(len: number): Uint8Array {
  if (len < 128) return new Uint8Array([len]);
  if (len < 256) return new Uint8Array([0x81, len]);
  return new Uint8Array([0x82, (len >>> 8) & 0xff, len & 0xff]);
}

function wrapPkcs1RsaInPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  // AlgId: SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
  const algId = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const privOctetString = concatBytes(new Uint8Array([0x04]), encodeDerLength(pkcs1Der.byteLength), pkcs1Der);
  const inner = concatBytes(version, algId, privOctetString);
  return concatBytes(new Uint8Array([0x30]), encodeDerLength(inner.byteLength), inner);
}

function extractRsaPublicModulusAndExponentFromPkcs1Private(pkcs1Der: Uint8Array): {
  n: Uint8Array;
  e: Uint8Array;
} {
  let pos = 0;
  const readTagAndLen = (): { tag: number; len: number } => {
    const tag = pkcs1Der[pos++]!;
    let len = pkcs1Der[pos++]!;
    if (len & 0x80) {
      const nBytes = len & 0x7f;
      len = 0;
      for (let i = 0; i < nBytes; i++) {
        len = (len << 8) | pkcs1Der[pos++]!;
      }
    }
    return { tag, len };
  };
  // Outer SEQUENCE
  readTagAndLen();
  // version INTEGER
  const ver = readTagAndLen();
  pos += ver.len;
  // modulus n INTEGER
  const mod = readTagAndLen();
  const n = pkcs1Der.subarray(pos, pos + mod.len);
  pos += mod.len;
  // publicExponent e INTEGER
  const exp = readTagAndLen();
  const e = pkcs1Der.subarray(pos, pos + exp.len);
  return { n, e };
}

async function parsePemPrivateKeyForSshAuth(pemText: string): Promise<{
  algorithm: 'ssh-ed25519' | 'rsa-sha2-256';
  publicKeyBlob: Uint8Array;
  sign: (data: Uint8Array) => Promise<Uint8Array>;
}> {
  const trimmed = pemText.trim();
  const lines = trimmed
    .split(String.fromCharCode(10))
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('-----'));
  const der = base64ToBytes(lines.join(''));

  if (trimmed.includes('BEGIN OPENSSH PRIVATE KEY')) {
    const magic = `openssh-key-v1${String.fromCharCode(0)}`;
    let pos = magic.length;
    const r = new SshReader(der.subarray(pos));
    const cipherName = r.readString();
    const kdfName = r.readString();
    r.readBytes(); // kdfOptions
    const numKeys = r.readUint32();
    if (cipherName !== 'none' || kdfName !== 'none' || numKeys < 1) {
      throw new Error('Encrypted OpenSSH private keys require unlocking in Key Vault first.');
    }
    const pubKeyBlob = r.readBytes();
    const privBlock = r.readBytes();
    const pr = new SshReader(privBlock);
    const check1 = pr.readUint32();
    const check2 = pr.readUint32();
    if (check1 !== check2) {
      throw new Error('Corrupted OpenSSH private key checkint mismatch.');
    }
    const keyType = pr.readString();
    if (keyType === 'ssh-ed25519') {
      pr.readBytes(); // pub32
      const priv64 = pr.readBytes(); // seed32 || pub32
      const seed32 = priv64.subarray(0, 32);
      const pkcs8Prefix = new Uint8Array([
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20
      ]);
      const pkcs8 = concatBytes(pkcs8Prefix, seed32);
      const cryptoKey = await getSubtle().importKey(
        'pkcs8',
        pkcs8 as BufferSource,
        { name: 'Ed25519' },
        false,
        ['sign']
      );
      return {
        algorithm: 'ssh-ed25519',
        publicKeyBlob: pubKeyBlob,
        sign: async (data: Uint8Array) => {
          const rawSig = new Uint8Array(
            await getSubtle().sign({ name: 'Ed25519' }, cryptoKey, data as BufferSource)
          );
          return concatBytes(sshString('ssh-ed25519'), sshString(rawSig));
        }
      };
    }
    throw new Error(`Unsupported OpenSSH key type "${keyType}"`);
  }

  // PKCS#1 RSA or PKCS#8 RSA
  const pkcs8Der = trimmed.includes('BEGIN RSA PRIVATE KEY') ? wrapPkcs1RsaInPkcs8(der) : der;
  const cryptoKey = await getSubtle().importKey(
    'pkcs8',
    pkcs8Der as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['sign']
  );

  let nBytes: Uint8Array;
  let eBytes: Uint8Array;
  if (trimmed.includes('BEGIN RSA PRIVATE KEY')) {
    const extracted = extractRsaPublicModulusAndExponentFromPkcs1Private(der);
    nBytes = extracted.n;
    eBytes = extracted.e;
  } else {
    const jwk = await getSubtle().exportKey('jwk', cryptoKey);
    const b64UrlToBytes = (s: string): Uint8Array => {
      const padded = s.replace(/-/g, '+').replace(/_/g, '/');
      return base64ToBytes(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    };
    nBytes = b64UrlToBytes(jwk.n ?? '');
    eBytes = b64UrlToBytes(jwk.e ?? '');
  }

  const publicKeyBlob = concatBytes(sshString('ssh-rsa'), sshMpint(eBytes), sshMpint(nBytes));
  return {
    algorithm: 'rsa-sha2-256',
    publicKeyBlob,
    sign: async (data: Uint8Array) => {
      const sigBytes = new Uint8Array(
        await getSubtle().sign({ name: 'RSASSA-PKCS1-v1_5' }, cryptoKey, data as BufferSource)
      );
      return concatBytes(sshString('rsa-sha2-256'), sshString(sigBytes));
    }
  };
}

interface RemoteChannelState {
  localId: number;
  remoteId: number;
  kind: 'pty' | 'exec' | 'direct-tcpip' | 'sftp';
  stdoutChunks: string[];
  stderrChunks: string[];
  exitCode: number | null;
  startedAt: number;
  /** Bytes the server has not yet consumed and will accept from us. */
  remoteWindow: number;
  /** Outstanding CHANNEL_REQUEST acknowledgements, in send order. */
  pendingRequests: Array<{
    type: string;
    /** Resolves true on CHANNEL_SUCCESS; false on CHANNEL_FAILURE when the caller tolerates it. */
    resolve: (accepted: boolean) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    tolerateFailure?: boolean;
  }>;
  /** Waiters blocked on the remote window opening up. */
  windowWaiters: Array<() => void>;
  onExecComplete?: (res: Extract<ControlMessage, { type: 'exec_result' }>) => void;
  onDirectTcpComplete?: (rawResponse: string) => void;
  onData?: (data: Uint8Array) => void;
  onStderr?: (data: Uint8Array) => void;
  /** Fails a streaming exec when the channel or session goes away first. */
  onExecFailed?: (err: Error) => void;
  sftp?: SftpClient;
}

export interface RelaySessionLoginResult {
  token: string;
  userId: string;
  expiresAt: number;
  expiresIn: number;
}

export async function loginToCloudflareRelay(
  relayWsUrl: string,
  username: string,
  password: string
): Promise<RelaySessionLoginResult> {
  const raw = relayWsUrl.trim();
  if (!raw) {
    throw new Error('ERR_CONFIG_MISSING: Enter the Cloudflare Worker Relay URL before signing in.');
  }
  let target = raw;
  if (target.startsWith('ws://')) {
    target = `http://${target.slice('ws://'.length)}`;
  } else if (target.startsWith('wss://')) {
    target = `https://${target.slice('wss://'.length)}`;
  }
  const u = new URL(target);
  u.pathname = u.pathname.replace(/\/ws\/?$/, '/auth/session');
  if (!u.pathname.endsWith('/auth/session')) {
    u.pathname = '/auth/session';
  }
  u.search = '';

  const res = await fetch(u.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username.trim(), password })
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    code?: string;
    error?: string;
    token?: string;
    userId?: string;
    expiresAt?: number;
    expiresIn?: number;
  };
  if (!res.ok || !data.ok || !data.token) {
    throw new Error(
      `${data.code ?? 'ERR_RELAY_AUTH_FAILED'}: ${
        data.error ?? `Relay login failed with HTTP ${res.status}`
      }`
    );
  }
  try {
    globalThis.sessionStorage?.setItem('webssh.gateway.authToken', data.token);
  } catch {
    // ignore storage errors
  }
  return {
    token: data.token,
    userId: data.userId ?? username.trim(),
    expiresAt: data.expiresAt ?? Math.floor(Date.now() / 1000) + 900,
    expiresIn: data.expiresIn ?? 900
  };
}

export interface GuestTicketRequest {
  host: string;
  port: number;
  turnstileToken: string;
}

export interface GuestTicketResult {
  token: string;
  host: string;
  port: number;
  expiresAt: number;
  expiresIn: number;
}

/**
 * Exchange a Turnstile response for a short-lived connection ticket bound to
 * one host/port. No account is involved: the ticket is the authorisation.
 */
export async function requestConnectionTicket(
  relayWsUrl: string,
  request: GuestTicketRequest
): Promise<GuestTicketResult> {
  const raw = relayWsUrl.trim();
  if (!raw) {
    throw new Error('ERR_CONFIG_MISSING: The relay endpoint is not configured.');
  }
  const target = raw.startsWith('ws://')
    ? `http://${raw.slice('ws://'.length)}`
    : raw.startsWith('wss://')
      ? `https://${raw.slice('wss://'.length)}`
      : raw;
  const u = new URL(target);
  u.pathname = '/auth/ticket';
  u.search = '';

  const res = await fetch(u.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      turnstileToken: request.turnstileToken,
      host: request.host.trim().toLowerCase(),
      port: request.port
    })
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    code?: string;
    error?: string;
    token?: string;
    expiresAt?: number;
    expiresIn?: number;
    destination?: { host?: string; port?: number };
  };
  if (!res.ok || !data.ok || !data.token) {
    throw new Error(
      `${data.code ?? 'ERR_TURNSTILE_FAILED'}: ${
        data.error ?? `Connection ticket request failed with HTTP ${res.status}`
      }`
    );
  }
  return {
    token: data.token,
    host: data.destination?.host ?? request.host.trim().toLowerCase(),
    port: data.destination?.port ?? request.port,
    expiresAt: data.expiresAt ?? Math.floor(Date.now() / 1000) + 300,
    expiresIn: data.expiresIn ?? 300
  };
}

export const RELAY_RING_BUFFER_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB session replay ring buffer

export class BrowserSshRelaySessionClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private metadata: ConnectedSessionMetadata | null = null;
  private rawBuffer: Uint8Array = new Uint8Array(0);
  private bannerParsed = false;
  private serverVersion = '';
  private clientKexInitPayload: Uint8Array = new Uint8Array(0);
  private serverKexInitPayload: Uint8Array = new Uint8Array(0);
  private ecdhKeyPair: CryptoKeyPair | null = null;
  private clientEcdhPubRaw: Uint8Array = new Uint8Array(0);
  private sessionId: Uint8Array | null = null;

  private seqIn = 0;
  private seqOut = 0;
  private encryptedIn = false;
  private encryptedOut = false;
  private encKeyOut: CryptoKey | null = null;
  private encKeyIn: CryptoKey | null = null;
  private macKeyOut: CryptoKey | null = null;
  private macKeyIn: CryptoKey | null = null;
  private ivOut: Uint8Array = new Uint8Array(16);
  private ivIn: Uint8Array = new Uint8Array(16);

  private recvProcessing = Promise.resolve();
  private sendChain = Promise.resolve();

  private connectResolve: ((meta: ConnectedSessionMetadata) => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  private nextLocalChannel = 1;
  private channels = new Map<number, RemoteChannelState>();
  private pendingChannelOpen = new Map<
    number,
    {
      resolve: (info: {
        remoteId: number;
        remoteWindow: number;
        remoteMaxPacket: number;
      }) => void;
      reject: (err: Error) => void;
    }
  >();
  private opCounter = 0;

  private ptySeq = 0;
  private ringBuffer: Array<{ seq: number; channel: number; data: Uint8Array }> = [];
  private ringBufferBytes = 0;
  private activeTunnels = new Map<
    string,
    { remoteHost: string; remotePort: number; localPort: number }
  >();

  /** Validated env for this session's shells; undefined when none was requested. */
  private sessionEnv: Record<string, string> | undefined;

  constructor(private readonly params: LiveConnectParams) {}

  get isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get sessionMetadata(): ConnectedSessionMetadata | null {
    return this.metadata;
  }

  private buildRelayWsUrl(): string {
    const rawRelay = (this.params.gatewayUrl ?? '').trim();
    if (!rawRelay) {
      throw new Error(
        'ERR_CONFIG_MISSING: Cloudflare Worker Relay WebSocket URL is required (e.g. wss://webssh-studio-relay.<subdomain>.workers.dev/ws).'
      );
    }
    let normalized = rawRelay;
    if (normalized.startsWith('http://')) {
      normalized = `ws://${normalized.slice('http://'.length)}`;
    } else if (normalized.startsWith('https://')) {
      normalized = `wss://${normalized.slice('https://'.length)}`;
    }
    const parsed = new URL(normalized);
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/ws';
    }
    parsed.searchParams.set('host', this.params.host);
    parsed.searchParams.set('port', String(this.params.port));
    // Token goes via Sec-WebSocket-Protocol header only — never in the URL,
    // so it cannot land in edge logs. The relay prefers the header already.
    return parsed.toString();
  }

  async connect(): Promise<ConnectedSessionMetadata> {
    // The relay speaks SSH directly; it has no bastion dialling. Refuse rather
    // than connect straight to the target and pretend the chain was used.
    if (this.params.jumpHops?.length) {
      throw new Error(
        'ProxyJump requires the Go gateway: the Cloudflare relay cannot dial bastion hops.'
      );
    }
    this.sessionEnv = prepareSessionEnv(this.params.env);
    const wsUrl = this.buildRelayWsUrl();

    // Pre-flight HTTP check when possible to surface precise 401/403/503 JSON error codes from the Worker
    return new Promise<ConnectedSessionMetadata>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      let socket: WebSocket;
      try {
        const protocols = ['webssh-relay.v1'];
        if (this.params.gatewayAuthToken?.trim()) {
          protocols.push(`token.${this.params.gatewayAuthToken.trim()}`);
        }
        socket = new WebSocket(wsUrl, protocols);
      } catch (err) {
        this.connectResolve = null;
        this.connectReject = null;
        reject(
          new Error(
            `ERR_RELAY_UNREACHABLE: Failed to open Cloudflare Worker Relay WebSocket (${
              err instanceof Error ? err.message : String(err)
            })`
          )
        );
        return;
      }

      socket.binaryType = 'arraybuffer';
      this.ws = socket;
      let wsOpened = false;

      const connectTimer = setTimeout(() => {
        if (!this.connected) {
          this.failConnect(
            new Error(
              `ERR_RELAY_UNREACHABLE: Timed out connecting via Cloudflare Worker Relay to ${this.params.host}:${this.params.port}`
            )
          );
          this.close();
        }
      }, 10000);

      socket.onopen = () => {
        wsOpened = true;
        // Send client SSH-2.0 identification string immediately
        const bannerBytes = new TextEncoder().encode(`${CLIENT_VERSION}${String.fromCharCode(13, 10)}`);
        socket.send(bannerBytes);
      };

      socket.onmessage = (ev: MessageEvent) => {
        const chunk =
          ev.data instanceof Uint8Array
            ? ev.data
            : ArrayBuffer.isView(ev.data)
              ? new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength)
              : ev.data instanceof ArrayBuffer ||
                  (typeof ev.data === 'object' &&
                    ev.data !== null &&
                    Object.prototype.toString.call(ev.data) === '[object ArrayBuffer]')
                ? new Uint8Array(ev.data as ArrayBuffer)
                : new TextEncoder().encode(String(ev.data));
        this.rawBuffer = concatBytes(this.rawBuffer, chunk);
        this.recvProcessing = this.recvProcessing
          .then(() => this.processInboundBytes())
          .catch((err) => {
            this.failConnect(err instanceof Error ? err : new Error(String(err)));
            this.close();
          });
      };

      socket.onerror = () => {
        if (!wsOpened) {
          void this.probeRelayRejectionReason(wsUrl).then((reason) => {
            clearTimeout(connectTimer);
            this.failConnect(new Error(reason));
          });
        }
      };

      socket.onclose = (ev: CloseEvent) => {
        clearTimeout(connectTimer);
        const wasConnected = this.connected;
        this.connected = false;
        this.params.onStateChange?.('disconnected', 0);
        this.failOpenStreams(new Error('SSH session disconnected.'));
        if (!wasConnected && this.connectReject) {
          if (ev.reason) {
            this.failConnect(new Error(`ERR_RELAY_CLOSED (${ev.code}): ${ev.reason}`));
          } else {
            void this.probeRelayRejectionReason(wsUrl).then((reason) => {
              this.failConnect(new Error(reason));
            });
          }
        }
      };
    });
  }

  private async probeRelayRejectionReason(wsUrl: string): Promise<string> {
    try {
      const httpUrl = new URL(wsUrl);
      httpUrl.protocol = httpUrl.protocol === 'wss:' ? 'https:' : 'http:';
      const res = await fetch(httpUrl.toString(), { method: 'GET' });
      if (res.status === 401) {
        const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
        return `${data.code ?? 'ERR_RELAY_AUTH_FAILED'}: ${
          data.error ?? 'Relay authentication failed (check RELAY_AUTH_TOKEN).'
        }`;
      }
      if (res.status === 403) {
        const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
        return `${data.code ?? 'ERR_DESTINATION_DENIED'}: ${
          data.error ?? 'Target host/port or browser Origin is denied by Cloudflare Worker policy.'
        }`;
      }
      if (res.status === 429) {
        const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
        return `${data.code ?? 'ERR_RATE_LIMITED'}: ${
          data.error ?? 'Per-user connection or rate limit exceeded on Cloudflare Worker Relay.'
        }`;
      }
      if (res.status === 503 || res.status === 502) {
        const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
        return `${data.code ?? 'ERR_RELAY_UNREACHABLE'}: ${
          data.error ?? `Relay returned HTTP ${res.status}`
        }`;
      }
    } catch {
      // ignore fetch error when relay is offline
    }
    return `ERR_RELAY_UNREACHABLE: Could not establish WebSocket through Cloudflare Worker Relay (${wsUrl}). Verify the Worker URL, ALLOWED_SSH_TARGETS, and RELAY_AUTH_TOKEN.`;
  }

  private failConnect(err: Error): void {
    recordDiagnostic('ERR_RELAY_CONNECT', err.message, { host: this.params.host, port: this.params.port });
    if (this.connectReject) {
      const rej = this.connectReject;
      this.connectResolve = null;
      this.connectReject = null;
      rej(err);
    }
  }

  private async processInboundBytes(): Promise<void> {
    if (!this.bannerParsed) {
      const nlIdx = this.rawBuffer.indexOf(0x0a);
      if (nlIdx === -1) return;
      const lineBytes = this.rawBuffer.subarray(0, nlIdx);
      this.rawBuffer = this.rawBuffer.subarray(nlIdx + 1);
      const line = new TextDecoder().decode(lineBytes).trim();
      if (!line.startsWith('SSH-2.0-') && !line.startsWith('SSH-1.99-')) {
        throw new Error(`ERR_NON_SSH_BANNER: Invalid SSH server banner "${line}"`);
      }
      this.serverVersion = line;
      this.bannerParsed = true;
      await this.sendClientKexInit();
    }

    while (this.rawBuffer.byteLength > 0) {
      const packet = await this.tryReadPacket();
      if (!packet) break;
      await this.handlePacket(packet);
    }
  }

  private async tryReadPacket(): Promise<Uint8Array | null> {
    if (!this.encryptedIn) {
      if (this.rawBuffer.byteLength < 5) return null;
      const pktLen = readUint32BE(this.rawBuffer, 0);
      if (pktLen < 2 || pktLen > 262144) {
        throw new Error(`Invalid unencrypted SSH packet length ${pktLen}`);
      }
      const totalLen = 4 + pktLen;
      if (this.rawBuffer.byteLength < totalLen) return null;
      const padLen = this.rawBuffer[4]!;
      const payload = this.rawBuffer.subarray(5, totalLen - padLen);
      this.rawBuffer = this.rawBuffer.subarray(totalLen);
      this.seqIn = (this.seqIn + 1) >>> 0;
      return new Uint8Array(payload);
    }

    // Encrypted with aes128-ctr (16-byte block) + hmac-sha2-256 (32-byte MAC)
    if (this.rawBuffer.byteLength < 16 + 32) return null;
    if (!this.encKeyIn || !this.macKeyIn) throw new Error('Missing SSH inbound cipher keys');

    // Peek at decrypted first 16-byte block using current ivIn copy without mutating ivIn yet
    const firstBlockCipher = this.rawBuffer.subarray(0, 16);
    const previewCounter = new Uint8Array(this.ivIn);
    const firstBlockPlain = new Uint8Array(
      await getSubtle().decrypt(
        { name: 'AES-CTR', counter: previewCounter as BufferSource, length: 128 },
        this.encKeyIn,
        firstBlockCipher as BufferSource
      )
    );
    const pktLen = readUint32BE(firstBlockPlain, 0);
    if (pktLen < 2 || pktLen > 262144) {
      throw new Error(`Invalid encrypted SSH packet length ${pktLen}`);
    }
    const cipherLen = 4 + pktLen;
    const totalWireLen = cipherLen + 32; // +32 for hmac-sha2-256
    if (this.rawBuffer.byteLength < totalWireLen) return null;

    const fullCipher = this.rawBuffer.subarray(0, cipherLen);
    const wireMac = this.rawBuffer.subarray(cipherLen, totalWireLen);
    this.rawBuffer = this.rawBuffer.subarray(totalWireLen);

    const fullPlain = new Uint8Array(
      await getSubtle().decrypt(
        { name: 'AES-CTR', counter: this.ivIn as BufferSource, length: 128 },
        this.encKeyIn,
        fullCipher as BufferSource
      )
    );
    incrementCounter128(this.ivIn, cipherLen / 16);

    const macInput = concatBytes(writeUint32BE(this.seqIn), fullPlain);
    const macValid = await getSubtle().verify(
      'HMAC',
      this.macKeyIn,
      wireMac as BufferSource,
      macInput as BufferSource
    );
    if (!macValid) {
      throw new Error('SSH HMAC-SHA2-256 integrity verification failed');
    }
    this.seqIn = (this.seqIn + 1) >>> 0;
    const padLen = fullPlain[4]!;
    return new Uint8Array(fullPlain.subarray(5, cipherLen - padLen));
  }

  private sendPacket(payload: Uint8Array): Promise<void> {
    this.sendChain = this.sendChain.then(async () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const blockSize = this.encryptedOut ? 16 : 8;
      const unpaddedLen = 4 + 1 + payload.byteLength;
      let padLen = blockSize - (unpaddedLen % blockSize);
      if (padLen < 4) padLen += blockSize;

      const padding = new Uint8Array(padLen);
      globalThis.crypto.getRandomValues(padding);
      const pktLen = 1 + payload.byteLength + padLen;
      const plainPacket = concatBytes(
        writeUint32BE(pktLen),
        new Uint8Array([padLen]),
        payload,
        padding
      );

      const seq = this.seqOut;
      this.seqOut = (this.seqOut + 1) >>> 0;

      if (!this.encryptedOut) {
        this.ws.send(plainPacket);
        return;
      }

      if (!this.encKeyOut || !this.macKeyOut) {
        throw new Error('Missing SSH outbound cipher keys');
      }

      const macInput = concatBytes(writeUint32BE(seq), plainPacket);
      const macBytes = new Uint8Array(
        await getSubtle().sign('HMAC', this.macKeyOut, macInput as BufferSource)
      );
      const cipherPacket = new Uint8Array(
        await getSubtle().encrypt(
          { name: 'AES-CTR', counter: this.ivOut as BufferSource, length: 128 },
          this.encKeyOut,
          plainPacket as BufferSource
        )
      );
      incrementCounter128(this.ivOut, plainPacket.byteLength / 16);
      this.ws.send(concatBytes(cipherPacket, macBytes));
    });
    return this.sendChain;
  }

  private async sendClientKexInit(): Promise<void> {
    const cookie = new Uint8Array(16);
    globalThis.crypto.getRandomValues(cookie);
    const payload = concatBytes(
      new Uint8Array([SSH_MSG_KEXINIT]),
      cookie,
      sshString('ecdh-sha2-nistp256'),
      sshString('ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-256'),
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
    this.clientKexInitPayload = payload;
    await this.sendPacket(payload);

    // Generate ephemeral ECDH P-256 keypair and send SSH_MSG_KEX_ECDH_INIT
    this.ecdhKeyPair = await getSubtle().generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    this.clientEcdhPubRaw = new Uint8Array(
      await getSubtle().exportKey('raw', this.ecdhKeyPair.publicKey)
    );
    await this.sendPacket(
      concatBytes(new Uint8Array([SSH_MSG_KEX_ECDH_INIT]), sshString(this.clientEcdhPubRaw))
    );
  }

  private async verifyHostKeySignature(
    hostKeyBlob: Uint8Array,
    sigBlob: Uint8Array,
    exchangeHash: Uint8Array
  ): Promise<{ algorithm: string; valid: boolean }> {
    const kr = new SshReader(hostKeyBlob);
    const keyAlg = kr.readString();
    const sr = new SshReader(sigBlob);
    const sigAlg = sr.readString();
    const sigRaw = sr.readBytes();

    if (keyAlg === 'ssh-ed25519') {
      const pub32 = kr.readBytes();
      try {
        const pubKey = await getSubtle().importKey(
          'raw',
          pub32 as BufferSource,
          { name: 'Ed25519' },
          false,
          ['verify']
        );
        const valid = await getSubtle().verify(
          { name: 'Ed25519' },
          pubKey,
          sigRaw as BufferSource,
          exchangeHash as BufferSource
        );
        return { algorithm: keyAlg, valid };
      } catch {
        return { algorithm: keyAlg, valid: sigRaw.byteLength === 64 };
      }
    }

    if (keyAlg === 'ecdsa-sha2-nistp256') {
      kr.readString(); // curve name nistp256
      const qPoint = kr.readBytes();
      const pubKey = await getSubtle().importKey(
        'raw',
        qPoint as BufferSource,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );
      const mr = new SshReader(sigRaw);
      const rMpint = mr.readBytes();
      const sMpint = mr.readBytes();
      const toFixed32 = (b: Uint8Array): Uint8Array => {
        const stripped = b[0] === 0 && b.byteLength > 32 ? b.subarray(1) : b;
        const out = new Uint8Array(32);
        out.set(stripped.subarray(Math.max(0, stripped.byteLength - 32)), Math.max(0, 32 - stripped.byteLength));
        return out;
      };
      const p1363 = concatBytes(toFixed32(rMpint), toFixed32(sMpint));
      const valid = await getSubtle().verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pubKey,
        p1363 as BufferSource,
        exchangeHash as BufferSource
      );
      return { algorithm: keyAlg, valid };
    }

    return { algorithm: sigAlg || keyAlg, valid: true };
  }

  private async deriveSshKey(
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

  private async handlePacket(payload: Uint8Array): Promise<void> {
    const msgType = payload[0]!;
    const reader = new SshReader(payload.subarray(1));

    switch (msgType) {
      case SSH_MSG_IGNORE:
      case SSH_MSG_DEBUG:
      case SSH_MSG_USERAUTH_BANNER:
        return;

      case SSH_MSG_DISCONNECT: {
        reader.readUint32(); // reason code
        const desc = reader.readString();
        throw new Error(`SSH_DISCONNECT: ${desc || 'Remote server disconnected'}`);
      }

      case SSH_MSG_KEXINIT: {
        this.serverKexInitPayload = payload;
        return;
      }

      case SSH_MSG_KEX_ECDH_REPLY: {
        const hostKeyBlob = reader.readBytes();
        const serverEcdhPubRaw = reader.readBytes();
        const sigH = reader.readBytes();

        if (!this.ecdhKeyPair) throw new Error('Missing client ECDH keypair');
        const serverEcdhKey = await getSubtle().importKey(
          'raw',
          serverEcdhPubRaw as BufferSource,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          []
        );
        const sharedSecretRaw = new Uint8Array(
          await getSubtle().deriveBits(
            { name: 'ECDH', public: serverEcdhKey },
            this.ecdhKeyPair.privateKey,
            256
          )
        );
        const kMpint = sshMpint(sharedSecretRaw);

        const exchangeHashInput = concatBytes(
          sshString(CLIENT_VERSION),
          sshString(this.serverVersion),
          sshString(this.clientKexInitPayload),
          sshString(this.serverKexInitPayload),
          sshString(hostKeyBlob),
          sshString(this.clientEcdhPubRaw),
          sshString(serverEcdhPubRaw),
          kMpint
        );
        const hRaw = await sha256(exchangeHashInput);
        if (!this.sessionId) {
          this.sessionId = hRaw;
        }

        const sigVerification = await this.verifyHostKeySignature(hostKeyBlob, sigH, hRaw);
        if (!sigVerification.valid) {
          throw new Error('HOST_KEY_SIGNATURE_INVALID: Server ECDH reply signature verification failed');
        }

        const fpHash = await sha256(hostKeyBlob);
        const fingerprint = `SHA256:${bytesToBase64(fpHash).replace(/=+$/, '')}`;
        const trusted = await this.params.onHostKeyPrompt({
          type: 'hostkey_prompt',
          host: this.params.host,
          port: this.params.port,
          algorithm: sigVerification.algorithm,
          fingerprint,
          publicKeyBase64: bytesToBase64(hostKeyBlob)
        });
        if (!trusted) {
          throw new Error(
            `HOST_KEY_MISMATCH: Host key verification rejected for ${this.params.host}:${this.params.port} (${fingerprint})`
          );
        }

        const ivC2S = await this.deriveSshKey(kMpint, hRaw, 'A', this.sessionId, 16);
        const ivS2C = await this.deriveSshKey(kMpint, hRaw, 'B', this.sessionId, 16);
        const keyC2S = await this.deriveSshKey(kMpint, hRaw, 'C', this.sessionId, 16);
        const keyS2C = await this.deriveSshKey(kMpint, hRaw, 'D', this.sessionId, 16);
        const macC2S = await this.deriveSshKey(kMpint, hRaw, 'E', this.sessionId, 32);
        const macS2C = await this.deriveSshKey(kMpint, hRaw, 'F', this.sessionId, 32);

        this.ivOut = ivC2S;
        this.ivIn = ivS2C;
        this.encKeyOut = await getSubtle().importKey(
          'raw',
          keyC2S as BufferSource,
          { name: 'AES-CTR' },
          false,
          ['encrypt']
        );
        this.encKeyIn = await getSubtle().importKey(
          'raw',
          keyS2C as BufferSource,
          { name: 'AES-CTR' },
          false,
          ['decrypt']
        );
        this.macKeyOut = await getSubtle().importKey(
          'raw',
          macC2S as BufferSource,
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
        this.macKeyIn = await getSubtle().importKey(
          'raw',
          macS2C as BufferSource,
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['verify']
        );

        await this.sendPacket(new Uint8Array([SSH_MSG_NEWKEYS]));
        this.encryptedOut = true;
        return;
      }

      case SSH_MSG_NEWKEYS: {
        this.encryptedIn = true;
        await this.sendPacket(
          concatBytes(new Uint8Array([SSH_MSG_SERVICE_REQUEST]), sshString('ssh-userauth'))
        );
        return;
      }

      case SSH_MSG_SERVICE_ACCEPT: {
        await this.sendUserauthRequest();
        return;
      }

      case SSH_MSG_USERAUTH_FAILURE: {
        const methods = reader.readString();
        throw new Error(
          `SSH_CONNECT_FAILED: SSH authentication failed for ${this.params.user}@${this.params.host} (supported methods: ${methods || 'none'})`
        );
      }

      case SSH_MSG_USERAUTH_SUCCESS: {
        void (async () => {
          try {
            const shell = await this.openInteractivePtyChannel(this.params.cols, this.params.rows);
            const chId = shell.channel;
            this.connected = true;
            const meta: ConnectedSessionMetadata = {
              ...shell.env,
              type: 'connected',
              sessionId: `cf_ssh_${Date.now().toString(36)}`,
              resumeToken: `cf_resume_${Date.now().toString(36)}`,
              serverVersion: this.serverVersion,
              cipher: 'aes128-ctr+hmac-sha2-256',
              kex: 'ecdh-sha2-nistp256',
              ptyChannel: chId,
              sftpReady: true
            };
            this.metadata = meta;
            // The relay has no ping/pong, so round-trip time is not measured.
            // Report 0 (rendered as "not measured") rather than inventing one.
            this.params.onStateChange?.('connected', 0);
            if (this.connectResolve) {
              const res = this.connectResolve;
              this.connectResolve = null;
              this.connectReject = null;
              res(meta);
            }
          } catch (err) {
            this.failConnect(err instanceof Error ? err : new Error(String(err)));
            this.close();
          }
        })();
        return;
      }

      case SSH_MSG_GLOBAL_REQUEST: {
        reader.readString(); // reqName
        const wantReply = reader.readBoolean();
        if (wantReply) {
          await this.sendPacket(new Uint8Array([SSH_MSG_REQUEST_FAILURE]));
        }
        return;
      }

      case SSH_MSG_CHANNEL_OPEN_CONFIRMATION: {
        const localId = reader.readUint32();
        const remoteId = reader.readUint32();
        const remoteWindow = reader.readUint32();
        const remoteMaxPacket = reader.readUint32();
        const waiter = this.pendingChannelOpen.get(localId);
        if (waiter) {
          this.pendingChannelOpen.delete(localId);
          waiter.resolve({ remoteId, remoteWindow, remoteMaxPacket });
        }
        return;
      }

      case SSH_MSG_CHANNEL_OPEN_FAILURE: {
        const localId = reader.readUint32();
        reader.readUint32(); // reasonCode
        const desc = reader.readString();
        const waiter = this.pendingChannelOpen.get(localId);
        if (waiter) {
          this.pendingChannelOpen.delete(localId);
          waiter.reject(new Error(`SSH channel open failed: ${desc}`));
        }
        return;
      }

      case SSH_MSG_CHANNEL_WINDOW_ADJUST: {
        const localId = reader.readUint32();
        const bytesToAdd = reader.readUint32();
        const ch = this.channels.get(localId);
        if (!ch) return;
        ch.remoteWindow += bytesToAdd;
        const waiters = ch.windowWaiters;
        ch.windowWaiters = [];
        for (const wake of waiters) wake();
        return;
      }

      case SSH_MSG_CHANNEL_SUCCESS:
      case SSH_MSG_CHANNEL_FAILURE: {
        const localId = reader.readUint32();
        const ch = this.channels.get(localId);
        if (!ch) return;
        const pending = ch.pendingRequests.shift();
        if (!pending) return;
        clearTimeout(pending.timer);
        if (msgType === SSH_MSG_CHANNEL_SUCCESS) {
          pending.resolve(true);
        } else if (pending.tolerateFailure) {
          pending.resolve(false);
        } else {
          pending.reject(
            new Error(`SSH_REQUEST_FAILED: server rejected channel request "${pending.type}"`)
          );
        }
        return;
      }

      case SSH_MSG_CHANNEL_EOF: {
        // EOF means the peer will send no more data; the channel is closed
        // afterwards with CHANNEL_CLOSE, which is where we finalize results.
        return;
      }

      case SSH_MSG_UNIMPLEMENTED:
        return;


      case SSH_MSG_CHANNEL_DATA: {
        const localId = reader.readUint32();
        const data = reader.readBytes();
        const ch = this.channels.get(localId);
        if (!ch) return;
        // Replenish flow-control window
        void this.sendPacket(
          concatBytes(
            new Uint8Array([SSH_MSG_CHANNEL_WINDOW_ADJUST]),
            writeUint32BE(ch.remoteId),
            writeUint32BE(data.byteLength)
          )
        );
        if (ch.kind === 'pty') {
          this.appendToRingBuffer(localId, data);
          this.params.onPtyData(localId, data);
        } else if (ch.kind === 'sftp') {
          ch.sftp?.handleData(data);
        } else if (ch.onData) {
          // A streaming consumer owns decoding; chunks are only kept for buffered callers.
          ch.onData(data);
        } else {
          ch.stdoutChunks.push(new TextDecoder().decode(data));
        }
        return;
      }

      case SSH_MSG_CHANNEL_EXTENDED_DATA: {
        const localId = reader.readUint32();
        reader.readUint32(); // dataTypeCode (1 = stderr)
        const data = reader.readBytes();
        const ch = this.channels.get(localId);
        if (!ch) return;
        if (ch.kind === 'pty') {
          this.appendToRingBuffer(localId, data);
          this.params.onPtyData(localId, data);
        } else if (ch.onStderr) {
          ch.onStderr(data);
        } else {
          ch.stderrChunks.push(new TextDecoder().decode(data));
        }
        return;
      }

      case SSH_MSG_CHANNEL_REQUEST: {
        const localId = reader.readUint32();
        const reqType = reader.readString();
        // RFC 4254 §6.10/§6.11: exit-status and exit-signal carry no
        // want_reply byte. Reading one there desynchronizes the whole packet
        // and silently corrupts the exit code.
        const ch = this.channels.get(localId);
        if (reqType === 'exit-status') {
          const code = reader.readUint32();
          if (ch) ch.exitCode = code;
          return;
        }
        if (reqType === 'exit-signal') {
          reader.readString(); // signal name
          reader.readBoolean(); // core dumped
          reader.readString(); // error message
          reader.readString(); // language tag
          if (ch) ch.exitCode = 128;
          return;
        }
        const wantReply = reader.readBoolean();
        if (wantReply && ch) {
          await this.sendPacket(
            concatBytes(new Uint8Array([SSH_MSG_CHANNEL_SUCCESS]), writeUint32BE(ch.remoteId))
          );
        }
        return;
      }

      case SSH_MSG_CHANNEL_CLOSE: {
        const localId = reader.readUint32();
        const ch = this.channels.get(localId);
        if (!ch) return;
        this.channels.delete(localId);
        for (const pending of ch.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(
            new Error(`SSH_CHANNEL_CLOSED: channel closed before "${pending.type}" completed`)
          );
        }
        ch.pendingRequests = [];
        ch.sftp?.close();
        await this.sendPacket(
          concatBytes(new Uint8Array([SSH_MSG_CHANNEL_CLOSE]), writeUint32BE(ch.remoteId))
        );
        if (ch.kind === 'exec' && ch.onExecComplete) {
          ch.onExecComplete({
            type: 'exec_result',
            opId: `exec_${localId}`,
            ok: (ch.exitCode ?? 0) === 0,
            stdout: ch.stdoutChunks.join(''),
            stderr: ch.stderrChunks.join(''),
            exitCode: ch.exitCode ?? 0,
            durationMs: Math.max(1, Date.now() - ch.startedAt)
          });
        } else if (ch.kind === 'direct-tcpip' && ch.onDirectTcpComplete) {
          ch.onDirectTcpComplete(ch.stdoutChunks.join(''));
        } else if (ch.kind === 'pty') {
          this.params.onChannelClosed?.(localId, ch.exitCode ?? 0);
        }
        return;
      }
    }
  }

  private async sendUserauthRequest(): Promise<void> {
    if (!this.sessionId) throw new Error('Missing SSH sessionId');

    if (this.params.authMethod === 'password') {
      const pkt = concatBytes(
        new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
        sshString(this.params.user),
        sshString('ssh-connection'),
        sshString('password'),
        new Uint8Array([0]),
        sshString(this.params.password ?? '')
      );
      await this.sendPacket(pkt);
      return;
    }

    if (this.params.authMethod === 'private_key' && this.params.privateKeyPem) {
      const parsedKey = await parsePemPrivateKeyForSshAuth(this.params.privateKeyPem);
      const signData = concatBytes(
        sshString(this.sessionId),
        new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
        sshString(this.params.user),
        sshString('ssh-connection'),
        sshString('publickey'),
        new Uint8Array([1]),
        sshString(parsedKey.algorithm),
        sshString(parsedKey.publicKeyBlob)
      );
      const sigBlob = await parsedKey.sign(signData);
      const pkt = concatBytes(
        new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
        sshString(this.params.user),
        sshString('ssh-connection'),
        sshString('publickey'),
        new Uint8Array([1]),
        sshString(parsedKey.algorithm),
        sshString(parsedKey.publicKeyBlob),
        sshString(sigBlob)
      );
      await this.sendPacket(pkt);
      return;
    }

    // Remote signer (in-browser non-extractable WebCrypto KeyVault)
    const pubKeyParts = (this.params.publicKey ?? '').trim().split(' ').filter(Boolean);
    const alg = pubKeyParts[0] || 'ssh-ed25519';
    const pubBlob = pubKeyParts[1] ? base64ToBytes(pubKeyParts[1]) : new Uint8Array(0);
    const signData = concatBytes(
      sshString(this.sessionId),
      new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
      sshString(this.params.user),
      sshString('ssh-connection'),
      sshString('publickey'),
      new Uint8Array([1]),
      sshString(alg),
      sshString(pubBlob)
    );
    const verdict = await routeSignRequest(this.params, {
      type: 'sign_request',
      requestId: `sign_${++this.opCounter}`,
      keyFingerprint: this.params.keyFingerprint ?? '',
      algorithm: alg,
      dataBase64: bytesToBase64(signData),
      host: this.params.host,
      port: this.params.port
    });
    if (!verdict.ok) throw new Error(`SSH_SIGN_REFUSED: ${verdict.reason}`);
    const rawSig = base64ToBytes(verdict.signatureBase64);
    const sigBlob =
      alg === 'ecdsa-sha2-nistp256'
        ? concatBytes(sshString('ecdsa-sha2-nistp256'), sshString(p1363ToSshMpint(rawSig)))
        : concatBytes(sshString('ssh-ed25519'), sshString(rawSig));

    const pkt = concatBytes(
      new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
      sshString(this.params.user),
      sshString('ssh-connection'),
      sshString('publickey'),
      new Uint8Array([1]),
      sshString(alg),
      sshString(pubBlob),
      sshString(sigBlob)
    );
    await this.sendPacket(pkt);
  }

  private async openRawSessionChannel(
    kind: 'pty' | 'exec' | 'sftp'
  ): Promise<RemoteChannelState> {
    const localId = this.nextLocalChannel++;
    const remoteIdPromise = new Promise<{
      remoteId: number;
      remoteWindow: number;
      remoteMaxPacket: number;
    }>((resolve, reject) => {
      this.pendingChannelOpen.set(localId, { resolve, reject });
    });
    await this.sendPacket(
      concatBytes(
        new Uint8Array([SSH_MSG_CHANNEL_OPEN]),
        sshString('session'),
        writeUint32BE(localId),
        writeUint32BE(2 * 1024 * 1024),
        writeUint32BE(32768)
      )
    );
    const info = await remoteIdPromise;
    const chState: RemoteChannelState = {
      localId,
      remoteId: info.remoteId,
      kind,
      stdoutChunks: [],
      stderrChunks: [],
      exitCode: null,
      startedAt: Date.now(),
      remoteWindow: Math.max(0, info.remoteWindow),
      pendingRequests: [],
      windowWaiters: []
    };
    this.channels.set(localId, chState);
    return chState;
  }

  /**
   * Send a channel request and wait for the server's CHANNEL_SUCCESS /
   * CHANNEL_FAILURE. Terminal readiness must never be reported before this
   * resolves — that was the root cause of "connected" terminals that never
   * received a shell prompt.
   */
  private sendChannelRequest(
    ch: RemoteChannelState,
    reqType: string,
    payload: Uint8Array,
    wantReply = true,
    timeoutMs = 15_000,
    tolerateFailure = false
  ): Promise<boolean> {
    const ack = wantReply
      ? new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => {
            const idx = ch.pendingRequests.findIndex((p) => p.timer === timer);
            if (idx !== -1) ch.pendingRequests.splice(idx, 1);
            reject(
              new Error(
                `SSH_REQUEST_TIMEOUT: server did not acknowledge "${reqType}" within ${timeoutMs}ms`
              )
            );
          }, timeoutMs);
          ch.pendingRequests.push({ type: reqType, resolve, reject, timer, tolerateFailure });
        })
      : Promise.resolve(true);

    void this.sendPacket(
      concatBytes(
        new Uint8Array([SSH_MSG_CHANNEL_REQUEST]),
        writeUint32BE(ch.remoteId),
        sshString(reqType),
        new Uint8Array([wantReply ? 1 : 0]),
        payload
      )
    );
    return ack;
  }

  /** Wait until the peer's flow-control window admits `size` bytes. */
  private async waitForWindow(ch: RemoteChannelState, size: number): Promise<void> {
    while (ch.remoteWindow < size) {
      if (!this.channels.has(ch.localId)) {
        throw new Error('SSH_CHANNEL_CLOSED: channel closed while writing');
      }
      await new Promise<void>((resolve) => ch.windowWaiters.push(resolve));
    }
    ch.remoteWindow -= size;
  }

  private async sendChannelData(ch: RemoteChannelState, data: Uint8Array): Promise<void> {
    const maxPacket = 32 * 1024;
    let offset = 0;
    while (offset < data.byteLength) {
      const size = Math.min(maxPacket, data.byteLength - offset);
      await this.waitForWindow(ch, size);
      await this.sendPacket(
        concatBytes(
          new Uint8Array([SSH_MSG_CHANNEL_DATA]),
          writeUint32BE(ch.remoteId),
          sshString(data.subarray(offset, offset + size))
        )
      );
      offset += size;
    }
  }

  /**
   * Ask for each env variable with want_reply and wait for its verdict before the next one.
   * A rejected name is reported, never exported through the shell as a fallback.
   */
  private async requestEnv(ch: RemoteChannelState): Promise<EnvReport | null> {
    const env = this.sessionEnv;
    if (!env) return null;
    const report = { envAccepted: [] as string[], envRejected: [] as string[] };
    for (const [name, value] of Object.entries(env)) {
      const accepted = await this.sendChannelRequest(
        ch,
        'env',
        concatBytes(sshString(name), sshString(value)),
        true,
        15_000,
        true
      );
      (accepted ? report.envAccepted : report.envRejected).push(name);
    }
    return report;
  }

  private async openInteractivePtyChannel(
    cols: number,
    rows: number
  ): Promise<{ channel: number; env: EnvReport | null }> {
    const ch = await this.openRawSessionChannel('pty');
    const env = await this.requestEnv(ch);
    await this.sendChannelRequest(
      ch,
      'pty-req',
      concatBytes(
        sshString('xterm-256color'),
        writeUint32BE(cols),
        writeUint32BE(rows),
        writeUint32BE(0),
        writeUint32BE(0),
        sshString(new Uint8Array([0]))
      )
    );
    await this.sendChannelRequest(ch, 'shell', new Uint8Array(0));
    return { channel: ch.localId, env };
  }

  /**
   * Open the `sftp` subsystem and speak real SFTP v3 over it. Returns a
   * cached client per channel; a session may open several.
   */
  private async openSftpChannel(): Promise<SftpClient> {
    const ch = await this.openRawSessionChannel('sftp');
    const sftp = new SftpClient({
      send: (bytes) => {
        void this.sendChannelData(ch, bytes).catch((err) => {
          ch.sftp?.failAll(err instanceof Error ? err : new Error(String(err)));
        });
      }
    });
    ch.sftp = sftp;
    ch.onData = (data) => sftp.handleData(data);
    try {
      await this.sendChannelRequest(ch, 'subsystem', sshString('sftp'), true, 20_000);
      await sftp.init();
      return sftp;
    } catch (err) {
      this.channels.delete(ch.localId);
      void this.sendPacket(
        concatBytes(new Uint8Array([SSH_MSG_CHANNEL_CLOSE]), writeUint32BE(ch.remoteId))
      );
      throw new Error(
        `SFTP_UNAVAILABLE: server did not accept the SFTP subsystem (${
          err instanceof Error ? err.message : String(err)
        }). Enable the sftp subsystem in sshd_config.`
      );
    }
  }

  private sftpPromise: Promise<SftpClient> | null = null;

  /** Lazily opened, shared SFTP client for this session. */
  getSftpClient(): Promise<SftpClient> {
    if (!this.sftpPromise) {
      this.sftpPromise = this.openSftpChannel().catch((err) => {
        this.sftpPromise = null;
        throw err;
      });
    }
    return this.sftpPromise;
  }

  sendPtyText(channel: number, text: string): boolean {
    return this.sendPtyBytes(channel, new TextEncoder().encode(text));
  }

  sendPtyBytes(channel: number, bytes: Uint8Array): boolean {
    const ch = this.channels.get(channel);
    if (!ch || ch.kind !== 'pty' || !this.isConnected) return false;
    void this.sendChannelData(ch, bytes).catch((err) => {
      this.params.onFatalError?.(
        'SSH_WRITE_FAILED',
        err instanceof Error ? err.message : String(err)
      );
    });
    return true;
  }

  resizeChannel(channel: number, cols: number, rows: number): void {
    const ch = this.channels.get(channel);
    if (!ch || !this.isConnected) return;
    void this.sendChannelRequest(
      ch,
      'window-change',
      concatBytes(
        writeUint32BE(cols),
        writeUint32BE(rows),
        writeUint32BE(0),
        writeUint32BE(0)
      ),
      false
    ).catch(() => undefined);
  }

  async openChannel(
    cols: number,
    rows: number
  ): Promise<Extract<ControlMessage, { type: 'channel_opened' }>> {
    const shell = await this.openInteractivePtyChannel(cols, rows);
    return {
      type: 'channel_opened',
      opId: `chan_${++this.opCounter}`,
      ok: true,
      channel: shell.channel,
      ...shell.env
    };
  }

  closeChannel(channel: number): void {
    const ch = this.channels.get(channel);
    if (!ch) return;
    this.channels.delete(channel);
    ch.sftp?.close();
    for (const pending of ch.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('SSH_CHANNEL_CLOSED: channel closed by client'));
    }
    ch.pendingRequests = [];
    void this.sendPacket(
      concatBytes(new Uint8Array([SSH_MSG_CHANNEL_CLOSE]), writeUint32BE(ch.remoteId))
    );
  }

  private failOpenStreams(err: Error): void {
    for (const ch of this.channels.values()) ch.onExecFailed?.(err);
  }

  async execCommand(
    command: string,
    timeoutMs = 120_000
  ): Promise<Extract<ControlMessage, { type: 'exec_result' }>> {
    const ch = await this.openRawSessionChannel('exec');
    const result = new Promise<Extract<ControlMessage, { type: 'exec_result' }>>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.channels.delete(ch.localId);
          reject(
            new Error(
              `SSH_EXEC_TIMEOUT: remote command exceeded ${Math.round(timeoutMs / 1000)}s`
            )
          );
        }, timeoutMs);
        ch.onExecComplete = (res) => {
          clearTimeout(timer);
          resolve(res);
        };
      }
    );
    try {
      // wantReply=true: the command is not "running" until the server accepts it.
      await this.sendChannelRequest(ch, 'exec', sshString(command));
    } catch (err) {
      this.channels.delete(ch.localId);
      throw err;
    }
    return result;
  }

  /**
   * Execute a command and stream stdout/stderr as it arrives. Used by
   * discovery, installation jobs and build logs so the UI shows real
   * progress instead of waiting for a buffered blob. A nonzero exit resolves;
   * aborting closes the SSH channel and rejects with an AbortError.
   */
  async execStream(
    command: string,
    options: ExecStreamOptions = {}
  ): Promise<Extract<ControlMessage, { type: 'exec_result' }>> {
    const { signal } = options;
    if (signal?.aborted) throw abortError();
    if (!this.isConnected) throw new Error('SSH session is not connected.');
    const ch = await this.openRawSessionChannel('exec');
    if (signal?.aborted) {
      this.closeChannel(ch.localId);
      throw abortError();
    }
    const retain = options.retainOutput ?? true;
    const stdout = new ExecOutputSink(options.onStdout, retain);
    const stderr = new ExecOutputSink(options.onStderr, retain);
    ch.onData = (data) => stdout.push(data);
    ch.onStderr = (data) => stderr.push(data);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const result = new Promise<Extract<ControlMessage, { type: 'exec_result' }>>(
      (resolve, reject) => {
        const settle = () => {
          settled = true;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const fail = (err: Error) => {
          if (settled) return;
          settle();
          stdout.finish();
          stderr.finish();
          reject(err);
        };
        ch.onExecFailed = fail;
        if (options.timeoutMs !== undefined) {
          const timeoutMs = options.timeoutMs;
          timer = setTimeout(() => {
            this.closeChannel(ch.localId);
            fail(new Error(`SSH_EXEC_TIMEOUT: command exceeded ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs);
        }
        onAbort = () => {
          this.closeChannel(ch.localId);
          fail(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        ch.onExecComplete = (res) => {
          if (settled) return;
          settle();
          resolve({ ...res, stdout: stdout.finish(), stderr: stderr.finish() });
        };
      }
    );
    try {
      await this.sendChannelRequest(ch, 'exec', sshString(command));
    } catch (err) {
      this.closeChannel(ch.localId);
      ch.onExecFailed?.(err instanceof Error ? err : new Error(String(err)));
      // The request's own error is what the caller needs; the result promise carries it.
    }
    return result;
  }

  private appendToRingBuffer(channel: number, data: Uint8Array): void {
    const copy = new Uint8Array(data);
    const seq = ++this.ptySeq;
    this.ringBuffer.push({ seq, channel, data: copy });
    this.ringBufferBytes += copy.byteLength;
    while (this.ringBufferBytes > RELAY_RING_BUFFER_MAX_BYTES && this.ringBuffer.length > 1) {
      const evicted = this.ringBuffer.shift()!;
      this.ringBufferBytes -= evicted.data.byteLength;
    }
  }

  getReplayFramesAfter(lastSeq: number): Array<{ seq: number; channel: number; data: Uint8Array }> {
    return this.ringBuffer.filter((f) => f.seq > lastSeq);
  }

  /**
   * The relay keeps no server-side session, so this re-establishes a fresh SSH
   * shell. Frames buffered for the old shell are NOT replayed: they carry the
   * dead channel ids and would duplicate output against a shell that never
   * produced it. Callers must treat the returned metadata as a NEW shell.
   */
  async reconnect(): Promise<ConnectedSessionMetadata> {
    return this.reconnectAndResume(Number.MAX_SAFE_INTEGER);
  }

  async reconnectAndResume(lastSeq = 0): Promise<ConnectedSessionMetadata> {
    this.rawBuffer = new Uint8Array(0);
    this.bannerParsed = false;
    this.seqIn = 0;
    this.seqOut = 0;
    this.encryptedIn = false;
    this.encryptedOut = false;
    for (const ch of this.channels.values()) {
      for (const request of ch.pendingRequests) {
        clearTimeout(request.timer);
        request.reject(new Error('SSH session reconnecting'));
      }
      ch.pendingRequests = [];
    }
    this.channels.clear();
    this.pendingChannelOpen.clear();
    this.sftpPromise = null;
    for (const session of this.uploadSessions.values()) {
      void session.abort().catch(() => undefined);
    }
    this.uploadSessions.clear();
    const meta = await this.connect();
    for (const frame of this.getReplayFramesAfter(lastSeq)) {
      this.params.onPtyData(frame.channel, frame.data);
    }
    return meta;
  }

  private async openDirectTcpipChannel(
    remoteHost: string,
    remotePort: number,
    originHost = '127.0.0.1',
    originPort = 0
  ): Promise<RemoteChannelState> {
    const localId = this.nextLocalChannel++;
    const remoteIdPromise = new Promise<{
      remoteId: number;
      remoteWindow: number;
      remoteMaxPacket: number;
    }>((resolve, reject) => {
      this.pendingChannelOpen.set(localId, { resolve, reject });
    });
    await this.sendPacket(
      concatBytes(
        new Uint8Array([SSH_MSG_CHANNEL_OPEN]),
        sshString('direct-tcpip'),
        writeUint32BE(localId),
        writeUint32BE(2 * 1024 * 1024),
        writeUint32BE(32768),
        sshString(remoteHost),
        writeUint32BE(remotePort),
        sshString(originHost),
        writeUint32BE(originPort)
      )
    );
    const info = await remoteIdPromise;
    const chState: RemoteChannelState = {
      localId,
      remoteId: info.remoteId,
      kind: 'direct-tcpip',
      stdoutChunks: [],
      stderrChunks: [],
      exitCode: null,
      startedAt: Date.now(),
      remoteWindow: Math.max(0, info.remoteWindow),
      pendingRequests: [],
      windowWaiters: []
    };
    this.channels.set(localId, chState);
    return chState;
  }

  /**
   * Send an HTTP/1.1 request through a real `direct-tcpip` channel and read the
   * response until the server closes. This is genuine remote-port reachability
   * — it does not bind a local socket, because a browser page cannot listen on
   * a localhost port.
   */
  private async httpRequestOverTunnel(
    remoteHost: string,
    remotePort: number,
    httpPath: string,
    timeoutMs = 15_000
  ): Promise<{ statusCode: number; statusText: string; body: string; bytes: number }> {
    const ch = await this.openDirectTcpipChannel(remoteHost, remotePort);
    try {
      const crlf = String.fromCharCode(13, 10);
      const request =
        `GET ${httpPath.startsWith('/') ? httpPath : `/${httpPath}`} HTTP/1.1${crlf}` +
        `Host: ${remoteHost}:${remotePort}${crlf}` +
        `User-Agent: WebSSH-Studio/1.0${crlf}` +
        `Accept: */*${crlf}` +
        `Connection: close${crlf}${crlf}`;
      const collected: Uint8Array[] = [];
      const responsePromise = new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `ERR_TUNNEL_TIMEOUT: no HTTP response from ${remoteHost}:${remotePort} within ${timeoutMs}ms`
            )
          );
        }, timeoutMs);
        ch.onData = (data) => collected.push(data);
        ch.onDirectTcpComplete = () => {
          clearTimeout(timer);
          resolve(concatBytes(...collected));
        };
      });
      await this.sendChannelData(ch, new TextEncoder().encode(request));
      const raw = await responsePromise;
      const text = new TextDecoder().decode(raw);
      const firstLine = text.split(String.fromCharCode(10))[0] ?? '';
      const tokens = firstLine.trim().split(/\s+/);
      const statusCode = Number.parseInt(tokens[1] ?? '', 10);
      if (!Number.isFinite(statusCode)) {
        throw new Error(
          `ERR_TUNNEL_BAD_RESPONSE: ${remoteHost}:${remotePort} did not return an HTTP response`
        );
      }
      const separator = `${crlf}${crlf}`;
      const headerEnd = text.indexOf(separator);
      const body = headerEnd === -1 ? '' : text.slice(headerEnd + separator.length);
      return {
        statusCode,
        statusText: tokens.slice(2).join(' '),
        body,
        bytes: raw.byteLength
      };
    } finally {
      this.closeChannel(ch.localId);
    }
  }

  /** Reject-and-report helper: never return a fabricated success. */
  private sftpFailure(
    opId: string,
    err: unknown
  ): Extract<ControlMessage, { type: 'sftp_result' }> {
    if (err instanceof SftpError) {
      console.debug(`[webssh:sftp] opid=${opId} error=SFTP_${SftpStatus[err.code] ?? err.code}: ${err.message}`);
      return {
        type: 'sftp_result',
        opId,
        ok: false,
        error: `SFTP_${SftpStatus[err.code] ?? err.code}: ${err.message}`
      };
    }
    console.debug(`[webssh:sftp] opid=${opId} error=${err instanceof Error ? err.message : String(err)}`);
    return {
      type: 'sftp_result',
      opId,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  private uploadSessions = new Map<string, SftpUploadSession>();

  async sftpOp(
    req: Omit<Extract<ControlMessage, { type: 'sftp_op' }>, 'type' | 'opId'>
  ): Promise<Extract<ControlMessage, { type: 'sftp_result' }>> {
    const opId = `sftp_${++this.opCounter}`;
    const targetPath = (req.path ?? '~').trim() || '~';
    console.debug(`[webssh:sftp] op=${req.op} path=${targetPath} opid=${opId}`);

    try {
      const sftp = await this.getSftpClient();
      switch (req.op) {
        case 'list': {
          const entries = await sftp.list(targetPath);
          return {
            type: 'sftp_result',
            opId,
            ok: true,
            entries: entries.map((entry) => ({
              name: entry.name,
              path: entry.path,
              isDir: entry.isDir,
              size: entry.size,
              mode: entry.mode,
              modTime: entry.modTime
            }))
          };
        }

        case 'stat': {
          const attrs = await sftp.stat(targetPath);
          const mode = attrs.permissions ?? 0;
          return {
            type: 'sftp_result',
            opId,
            ok: true,
            size: attrs.size ?? 0,
            mode: mode ? (mode & 0o7777).toString(8).padStart(4, '0') : '0644'
          };
        }

        case 'read_file':
        case 'download_read': {
          const bytes = await sftp.readFile(targetPath);
          return {
            type: 'sftp_result',
            opId,
            ok: true,
            dataBase64: bytesToBase64(bytes),
            size: bytes.byteLength
          };
        }

        case 'write_file': {
          const bytes = req.dataBase64 ? base64ToBytes(req.dataBase64) : new Uint8Array(0);
          let size: number;
          try {
            // Atomic write: stage to a .webssh-tmp-* sibling then rename into
            // place so a failed write never truncates the target.
            size = await sftp.writeFile(targetPath, bytes, { atomic: true });
          } catch (err) {
            // Some SSH servers (notably certain EC2 SFTP subsystems) do not
            // support SFTP RENAME, or place the temp file and target on
            // different filesystems. The data was written to the temp file but
            // the rename into place failed. Fall back to a direct non-atomic
            // write so the save still succeeds.
            size = await sftp.writeFile(targetPath, bytes, { atomic: false });
          }
          return { type: 'sftp_result', opId, ok: true, size };
        }

        case 'chmod': {
          const mode = Number.parseInt((req.mode ?? '0644'), 8);
          if (!Number.isFinite(mode) || mode < 0 || mode > 0o7777) {
            return { type: 'sftp_result', opId, ok: false, error: `Invalid file mode "${req.mode}"` };
          }
          await sftp.chmod(targetPath, mode);
          return {
            type: 'sftp_result',
            opId,
            ok: true,
            mode: mode.toString(8).padStart(4, '0')
          };
        }

        case 'mkdir': {
          await sftp.mkdir(targetPath);
          return { type: 'sftp_result', opId, ok: true };
        }

        case 'remove': {
          await sftp.removeRecursive(targetPath);
          return { type: 'sftp_result', opId, ok: true };
        }

        case 'rename': {
          if (!req.targetPath) {
            return { type: 'sftp_result', opId, ok: false, error: 'rename requires targetPath' };
          }
          await sftp.rename(targetPath, req.targetPath);
          return { type: 'sftp_result', opId, ok: true };
        }

        case 'upload_init': {
          const existing = this.uploadSessions.get(targetPath);
          if (existing) {
            await existing.abort().catch(() => undefined);
            this.uploadSessions.delete(targetPath);
          }
          const session = await sftp.startUpload(targetPath);
          this.uploadSessions.set(targetPath, session);
          return { type: 'sftp_result', opId, ok: true, offset: session.offset };
        }

        case 'upload_chunk': {
          const session = this.uploadSessions.get(targetPath);
          if (!session) {
            return {
              type: 'sftp_result',
              opId,
              ok: false,
              error: 'upload_chunk without a started upload (call upload_init first)'
            };
          }
          const chunk = req.dataBase64 ? base64ToBytes(req.dataBase64) : new Uint8Array(0);
          const offset = await session.write(chunk);
          return { type: 'sftp_result', opId, ok: true, offset };
        }

        case 'upload_commit': {
          const session = this.uploadSessions.get(targetPath);
          if (!session) {
            return {
              type: 'sftp_result',
              opId,
              ok: false,
              error: 'upload_commit without a started upload (call upload_init first)'
            };
          }
          this.uploadSessions.delete(targetPath);
          const size = await session.commit();
          return { type: 'sftp_result', opId, ok: true, size };
        }

        default:
          return {
            type: 'sftp_result',
            opId,
            ok: false,
            error: `Unsupported SFTP operation "${req.op}"`
          };
      }
    } catch (err) {
      return this.sftpFailure(opId, err);
    }
  }

  async tunnelOp(
    req: Omit<Extract<ControlMessage, { type: 'tunnel_op' }>, 'type' | 'opId'>
  ): Promise<Extract<ControlMessage, { type: 'tunnel_result' }>> {
    const opId = `tun_${++this.opCounter}`;
    try {
      if (req.op === 'http_preview') {
        const remoteHost = req.remoteHost ?? '127.0.0.1';
        const remotePort = req.remotePort ?? 80;
        const result = await this.httpRequestOverTunnel(
          remoteHost,
          remotePort,
          req.httpPath ?? '/'
        );
        return {
          type: 'tunnel_result',
          opId,
          ok: true,
          active: false,
          statusCode: result.statusCode,
          statusText: result.statusText,
          bodyPreview: result.body.slice(0, 4096),
          bytesTransferred: result.bytes
        };
      }

      if (req.op === 'stop') {
        if (req.tunnelId) this.activeTunnels.delete(req.tunnelId);
        return { type: 'tunnel_result', opId, tunnelId: req.tunnelId, ok: true, active: false };
      }

      // A browser page cannot bind 127.0.0.1:<port>. Reporting a bound address
      // here used to be a fabricated success; a tunnel only exists while a
      // request is in flight over direct-tcpip.
      return {
        type: 'tunnel_result',
        opId,
        tunnelId: req.tunnelId,
        ok: false,
        active: false,
        error:
          'ERR_TUNNEL_UNSUPPORTED: relay mode cannot bind a localhost port from the browser. ' +
          'Use HTTP preview for a one-off request, or the Go gateway transport for persistent tunnels.'
      };
    } catch (err) {
      return {
        type: 'tunnel_result',
        opId,
        tunnelId: req.tunnelId,
        ok: false,
        active: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  close(): void {
    this.connected = false;
    this.failOpenStreams(new Error('SSH session closed'));
    for (const ch of this.channels.values()) {
      ch.sftp?.close();
    }
    this.sftpPromise = null;
    this.uploadSessions.clear();
    try {
      this.ws?.close(1000, 'Client closed SSH session');
    } catch {
      // ignore
    }
    this.ws = null;
    for (const ch of this.channels.values()) {
      for (const request of ch.pendingRequests) {
        clearTimeout(request.timer);
        request.reject(new Error('SSH session closed'));
      }
      ch.pendingRequests = [];
    }
    this.channels.clear();
    for (const [, waiter] of this.pendingChannelOpen) {
      waiter.reject(new Error('SSH session closed'));
    }
    this.pendingChannelOpen.clear();
  }
}
