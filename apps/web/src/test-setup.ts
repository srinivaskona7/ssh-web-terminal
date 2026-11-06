import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import {
  FrameType,
  decodeControlPayload,
  decodeFrame,
  encodeControlFrame,
  encodeFrame,
  type ControlMessage
} from '@webssh/protocol';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(String(key), String(value));
    }
  };
}

try {
  if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.getItem !== 'function') {
    const mem = createMemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mem,
      writable: true,
      configurable: true
    });
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, 'localStorage', {
        value: mem,
        writable: true,
        configurable: true
      });
    }
  }
} catch {
  // Ignore if not configurable
}

if (!globalThis.crypto || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: true,
    configurable: true
  });
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    })
  });
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  class MockResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = MockResizeObserver;
}

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillStyle: '',
    fillRect: () => {},
    clearRect: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => {},
    createImageData: () => [],
    setTransform: () => {},
    drawImage: () => {},
    save: () => {},
    fillText: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    arc: () => {},
    fill: () => {},
    measureText: () => ({ width: 8 }),
    transform: () => {},
    rect: () => {},
    clip: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} })
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

// Protocol-speaking loopback WebSocket for JSDOM unit tests
class LoopbackProtocolWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  public readyState = LoopbackProtocolWebSocket.CONNECTING;
  public binaryType: BinaryType = 'arraybuffer';
  public onopen: ((ev: Event) => void) | null = null;
  public onmessage: ((ev: MessageEvent) => void) | null = null;
  public onerror: ((ev: Event) => void) | null = null;
  public onclose: ((ev: CloseEvent) => void) | null = null;

  private seq = 1n;
  private files = new Map<string, { content: string; mode: string; isDir: boolean }>([
    ['README.md', { content: '# Test Server' + String.fromCharCode(10), mode: '-rw-r--r--', isDir: false }],
    ['config', { content: '', mode: 'drwxr-xr-x', isDir: true }]
  ]);

  constructor(public readonly url: string) {
    setTimeout(() => {
      if (url.includes('unreachable-gateway')) {
        this.readyState = LoopbackProtocolWebSocket.CLOSED;
        this.onerror?.(new Event('error'));
        this.onclose?.(new Event('close') as CloseEvent);
        return;
      }
      this.readyState = LoopbackProtocolWebSocket.OPEN;
      this.onopen?.(new Event('open'));
    }, 1);
  }

  private emitBytes(bytes: Uint8Array): void {
    if (this.readyState !== LoopbackProtocolWebSocket.OPEN) return;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.onmessage?.(new MessageEvent('message', { data: copy.buffer }));
  }

  private emitControl(msg: ControlMessage): void {
    const frame = encodeControlFrame(this.seq++, msg);
    this.emitBytes(frame);
  }

  send(data: ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== LoopbackProtocolWebSocket.OPEN) return;
    let bytes: Uint8Array;
    if (data instanceof Uint8Array) {
      bytes = data;
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      return;
    }

    try {
      const frame = decodeFrame(bytes);
      if (frame.type === FrameType.Ping) {
        this.emitBytes(
          encodeFrame({
            type: FrameType.Pong,
            channel: frame.channel,
            seq: frame.seq,
            payload: frame.payload
          })
        );
        return;
      }
      if (frame.type === FrameType.PtyData) {
        const text = new TextDecoder().decode(frame.payload);
        if (text.includes('uname')) {
          this.emitBytes(
            encodeFrame({
              type: FrameType.PtyData,
              channel: frame.channel || 1,
              seq: this.seq++,
              payload: new TextEncoder().encode('Linux' + String.fromCharCode(13, 10))
            })
          );
        }
        return;
      }
      if (frame.type === FrameType.Control) {
        const ctrl = decodeControlPayload(frame.payload);
        switch (ctrl.type) {
          case 'connect':
            if (ctrl.password === 'wrong-password') {
              this.emitControl({
                type: 'error',
                code: 'SSH_CONNECT_FAILED',
                message: 'ssh: handshake failed: invalid password',
                fatal: true
              });
              return;
            }
            this.emitControl({
              type: 'connected',
              sessionId: 'sess_jsdom_1',
              resumeToken: 'tok_jsdom_1',
              ptyChannel: 1,
              // The gateway does not report cipher or key exchange; neither does this double.
              serverVersion: 'SSH-2.0-OpenSSH_9.6_testsshd',
              authMethodUsed: ctrl.authMethod ?? 'password',
              sftpReady: true
            });
            break;
          case 'open_channel':
            this.emitControl({
              type: 'channel_opened',
              opId: ctrl.opId,
              channel: ctrl.channel ?? 2,
              ok: true
            });
            break;
          case 'exec_command': {
            const cmd = ctrl.command.trim();
            const nl = String.fromCharCode(10);
            if (cmd.startsWith('uname')) {
              this.emitControl({
                type: 'exec_result',
                opId: ctrl.opId,
                ok: true,
                stdout: 'Linux' + nl,
                stderr: '',
                exitCode: 0,
                durationMs: 4
              });
            } else if (cmd.startsWith('pwd')) {
              this.emitControl({
                type: 'exec_result',
                opId: ctrl.opId,
                ok: true,
                stdout: '/home/ubuntu' + nl,
                stderr: '',
                exitCode: 0,
                durationMs: 3
              });
            } else if (cmd.includes('nonexistent')) {
              this.emitControl({
                type: 'exec_result',
                opId: ctrl.opId,
                ok: false,
                stdout: '',
                stderr: `bash: ${cmd}: command not found` + nl,
                exitCode: 127,
                durationMs: 2
              });
            } else {
              this.emitControl({
                type: 'exec_result',
                opId: ctrl.opId,
                ok: true,
                stdout: `${cmd}` + nl,
                stderr: '',
                exitCode: 0,
                durationMs: 5
              });
            }
            break;
          }
          case 'sftp_op': {
            if (ctrl.op === 'list') {
              this.emitControl({
                type: 'sftp_result',
                opId: ctrl.opId,
                ok: true,
                entries: Array.from(this.files.entries()).map(([name, info]) => ({
                  name,
                  path: name,
                  size: info.content.length,
                  mode: info.mode,
                  modTime: 1700000000,
                  isDir: info.isDir
                }))
              });
            } else if (ctrl.op === 'chmod') {
              const entry = this.files.get(ctrl.path) ?? { content: '', mode: '-r--------', isDir: false };
              entry.mode = ctrl.mode ?? '0400';
              this.files.set(ctrl.path, entry);
              this.emitControl({
                type: 'sftp_result',
                opId: ctrl.opId,
                ok: true,
                mode: entry.mode
              });
            } else if (ctrl.op === 'write_file') {
              const raw = ctrl.dataBase64 ? Buffer.from(ctrl.dataBase64, 'base64').toString('utf-8') : '';
              this.files.set(ctrl.path, { content: raw, mode: '-rw-r--r--', isDir: false });
              this.emitControl({
                type: 'sftp_result',
                opId: ctrl.opId,
                ok: true
              });
            } else if (ctrl.op === 'read_file' || ctrl.op === 'download_read') {
              const f = this.files.get(ctrl.path) ?? { content: '', mode: '-rw-r--r--', isDir: false };
              this.emitControl({
                type: 'sftp_result',
                opId: ctrl.opId,
                ok: true,
                dataBase64: Buffer.from(f.content, 'utf-8').toString('base64'),
                size: f.content.length
              });
            } else {
              this.emitControl({
                type: 'sftp_result',
                opId: ctrl.opId,
                ok: true,
                offset: 0
              });
            }
            break;
          }
          case 'tunnel_op':
            this.emitControl({
              type: 'tunnel_result',
              opId: ctrl.opId,
              ok: true,
              tunnelId: ctrl.tunnelId ?? 'tun_1',
              active: ctrl.op !== 'stop',
              boundAddress: `127.0.0.1:${ctrl.localPort ?? 8080}`,
              statusCode: 200,
              statusText: '200 OK',
              bodyPreview: 'HTTP/1.1 200 OK' + String.fromCharCode(10) + 'Server: testsshd-tunnel'
            });
            break;
        }
      }
    } catch {
      // ignore malformed frames in mock
    }
  }

  close(): void {
    this.readyState = LoopbackProtocolWebSocket.CLOSED;
    this.onclose?.(new Event('close') as CloseEvent);
  }
}

if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
  Object.defineProperty(globalThis, 'WebSocket', {
    value: LoopbackProtocolWebSocket,
    writable: true,
    configurable: true
  });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'WebSocket', {
      value: LoopbackProtocolWebSocket,
      writable: true,
      configurable: true
    });
  }
}
