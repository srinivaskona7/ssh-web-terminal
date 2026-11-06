export const HEADER_BYTE_LENGTH = 15;
export const MAX_FRAME_PAYLOAD_BYTES = 4 * 1024 * 1024; // 4 MiB hard frame ceiling
export const DEFAULT_CHANNEL_CREDIT_BYTES = 512 * 1024; // 512 KiB initial credit per channel

export const CONTROL_CHANNEL_ID = 0;
export const FIRST_PTY_CHANNEL_ID = 1;
export const FIRST_SFTP_CHANNEL_ID = 1024;

export enum FrameType {
  Control = 1,
  PtyData = 2,
  SftpData = 3,
  Ping = 4,
  Pong = 5
}

export interface BinaryFrame {
  type: FrameType;
  channel: number;
  seq: bigint;
  payload: Uint8Array;
}

/**
 * One ProxyJump hop. A hop that carries any credential authenticates with
 * only its own; a hop with none reuses the target's credentials.
 */
export interface JumpHop {
  host: string;
  port: number;
  user: string;
  keyFingerprint?: string;
  authMethod?: 'password' | 'private_key' | 'remote_signer';
  password?: string;
  /** authorized_keys line of the remote-signer key for this hop. */
  publicKey?: string;
  privateKeyPem?: string;
  privateKeyPassphrase?: string;
}

/** Names the server accepted and rejected from the requested environment. */
export interface EnvReport {
  envAccepted?: string[];
  envRejected?: string[];
}

/** Limits the gateway enforces on `connect.env`; the relay client applies the same. */
export const ENV_MAX_VARIABLES = 32;
export const ENV_MAX_VALUE_BYTES = 4096;
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface EnvVarError {
  /** The offending variable; absent when the whole set breaks a limit. */
  name?: string;
  field: 'name' | 'value' | 'count';
  message: string;
}

/** Check requested environment variables against the gateway's rules. Empty means valid. */
export function validateEnvVars(env: Record<string, string>): EnvVarError[] {
  const errors: EnvVarError[] = [];
  const entries = Object.entries(env);
  if (entries.length > ENV_MAX_VARIABLES) {
    errors.push({
      field: 'count',
      message: `${entries.length} variables requested; at most ${ENV_MAX_VARIABLES} are allowed`
    });
  }
  for (const [name, value] of entries) {
    if (!ENV_NAME_PATTERN.test(name)) {
      errors.push({
        name,
        field: 'name',
        message: `"${name}" is not a valid variable name (letters, digits and _, not starting with a digit, at most 64 characters)`
      });
    }
    if (typeof value !== 'string') {
      errors.push({ name, field: 'value', message: `${name} must have a text value` });
    } else if (value.includes('\u0000')) {
      errors.push({ name, field: 'value', message: `${name} contains a NUL character` });
    } else if (textEncoder.encode(value).byteLength > ENV_MAX_VALUE_BYTES) {
      errors.push({
        name,
        field: 'value',
        message: `${name} is longer than ${ENV_MAX_VALUE_BYTES} bytes`
      });
    }
  }
  return errors;
}

export interface SftpDirEntry {
  name: string;
  path: string;
  size: number;
  mode: string;
  modTime: number;
  isDir: boolean;
}

export type ControlMessage =
  | {
      type: 'hello';
      protocolVersion: number;
      clientVersion: string;
      oidcToken?: string;
    }
  | {
      type: 'connect';
      sessionId?: string;
      host: string;
      port: number;
      user: string;
      authMethod?: 'password' | 'private_key' | 'remote_signer';
      password?: string;
      privateKeyPem?: string;
      privateKeyPassphrase?: string;
      publicKey?: string;
      keyFingerprint: string;
      jump?: JumpHop[];
      /** Requested shell environment, sent to the server as SSH `env` requests. */
      env?: Record<string, string>;
      cols: number;
      rows: number;
      tmuxSession?: string;
    }
  | {
      type: 'hostkey_prompt';
      host: string;
      port: number;
      algorithm: string;
      fingerprint: string;
      publicKeyBase64: string;
    }
  | {
      type: 'hostkey_decision';
      trusted: boolean;
      overrideMismatch?: boolean;
    }
  | {
      type: 'sign_request';
      requestId: string;
      dataBase64: string;
      algorithm: string;
      keyFingerprint: string;
      host?: string;
      port?: number;
      /** 1-based jump hop asking for the signature; absent for the final target. */
      hopIndex?: number;
    }
  | {
      type: 'sign_response';
      requestId: string;
      signatureBase64: string;
    }
  | {
      type: 'connected';
      sessionId: string;
      resumeToken: string;
      ptyChannel: number;
      /** Negotiated values are present only when the server side observed them. */
      cipher?: string;
      kex?: string;
      serverVersion?: string;
      authMethodUsed?: string;
      sftpReady?: boolean;
      sftpError?: string;
      envAccepted?: string[];
      envRejected?: string[];
    }
  | {
      type: 'open_channel';
      opId: string;
      channel?: number;
      cols: number;
      rows: number;
    }
  | {
      type: 'channel_opened';
      opId: string;
      channel: number;
      ok: boolean;
      error?: string;
      envAccepted?: string[];
      envRejected?: string[];
    }
  | {
      type: 'close_channel';
      channel: number;
    }
  | {
      type: 'channel_closed';
      channel: number;
      exitCode?: number;
    }
  | {
      type: 'exec_command';
      opId: string;
      command: string;
      timeoutMs?: number;
    }
  | {
      type: 'exec_result';
      opId: string;
      ok: boolean;
      stdout: string;
      stderr: string;
      exitCode: number;
      durationMs: number;
      error?: string;
    }
  | {
      /** Run a command and stream its output; absent timeoutMs means no timeout. */
      type: 'exec_stream';
      opId: string;
      command: string;
      timeoutMs?: number;
    }
  | {
      type: 'exec_output';
      opId: string;
      stream: 'stdout' | 'stderr';
      dataBase64: string;
    }
  | {
      /** Sent exactly once per stream. An omitted exitCode means 0. */
      type: 'exec_stream_end';
      opId: string;
      ok: boolean;
      exitCode?: number;
      error?: string;
      durationMs: number;
    }
  | {
      type: 'exec_cancel';
      opId: string;
    }
  | {
      type: 'resize';
      channel: number;
      cols: number;
      rows: number;
    }
  | {
      type: 'resume';
      sessionId: string;
      token: string;
      lastSeq: string;
    }
  | {
      type: 'ack';
      seq: string;
    }
  | {
      type: 'credit';
      channel: number;
      bytes: number;
    }
  | {
      type: 'resync';
      firstAvailableSeq: string;
      lastSeq: string;
      truncatedBytes: number;
    }
  | {
      type: 'deploy_key';
      publicKey: string;
      password?: string;
    }
  | {
      type: 'sftp_op';
      opId: string;
      op:
        | 'list'
        | 'stat'
        | 'chmod'
        | 'mkdir'
        | 'remove'
        | 'rename'
        | 'upload_init'
        | 'upload_chunk'
        | 'upload_commit'
        | 'download_read'
        | 'write_file'
        | 'read_file';
      path: string;
      targetPath?: string;
      mode?: string;
      offset?: number;
      size?: number;
      sha256?: string;
      dataBase64?: string;
    }
  | {
      type: 'sftp_result';
      opId: string;
      ok: boolean;
      entries?: SftpDirEntry[];
      dataBase64?: string;
      offset?: number;
      size?: number;
      mode?: string;
      sha256?: string;
      error?: string;
    }
  | {
      type: 'tunnel_op';
      opId: string;
      op: 'start' | 'stop' | 'http_preview';
      tunnelId?: string;
      forwardType?: 'L' | 'R' | 'D';
      bindAddress?: string;
      localPort?: number;
      remoteHost?: string;
      remotePort?: number;
      httpPath?: string;
    }
  | {
      type: 'tunnel_result';
      opId: string;
      ok: boolean;
      tunnelId?: string;
      active?: boolean;
      boundAddress?: string;
      statusCode?: number;
      statusText?: string;
      bodyPreview?: string;
      bytesTransferred?: number;
      error?: string;
    }
  | {
      type: 'error';
      code: string;
      message: string;
      fatal?: boolean;
    };

export class ProtocolError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function encodeFrame(frame: BinaryFrame): Uint8Array {
  if (!Number.isInteger(frame.type) || frame.type < 1 || frame.type > 5) {
    throw new ProtocolError('INVALID_FRAME_TYPE', `Unsupported frame type: ${String(frame.type)}`);
  }
  if (!Number.isInteger(frame.channel) || frame.channel < 0 || frame.channel > 0xffff) {
    throw new ProtocolError('INVALID_CHANNEL', `Channel out of uint16 range: ${frame.channel}`);
  }
  if (frame.seq < 0n || frame.seq > 0xffffffffffffffffn) {
    throw new ProtocolError('INVALID_SEQ', `Sequence out of uint64 range: ${String(frame.seq)}`);
  }
  if (frame.payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
    throw new ProtocolError('PAYLOAD_TOO_LARGE', `Payload ${frame.payload.byteLength} exceeds max ${MAX_FRAME_PAYLOAD_BYTES}`);
  }

  const out = new Uint8Array(HEADER_BYTE_LENGTH + frame.payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, frame.type);
  view.setUint16(1, frame.channel, false);
  view.setBigUint64(3, frame.seq, false);
  view.setUint32(11, frame.payload.byteLength, false);
  out.set(frame.payload, HEADER_BYTE_LENGTH);
  return out;
}

export function decodeFrame(bytes: Uint8Array): BinaryFrame {
  if (bytes.byteLength < HEADER_BYTE_LENGTH) {
    throw new ProtocolError('TRUNCATED_HEADER', `Frame shorter than ${HEADER_BYTE_LENGTH} bytes (${bytes.byteLength})`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawType = view.getUint8(0);
  if (rawType < 1 || rawType > 5) {
    throw new ProtocolError('INVALID_FRAME_TYPE', `Invalid frame type byte: ${rawType}`);
  }
  const channel = view.getUint16(1, false);
  const seq = view.getBigUint64(3, false);
  const payloadLen = view.getUint32(11, false);

  if (payloadLen > MAX_FRAME_PAYLOAD_BYTES) {
    throw new ProtocolError('PAYLOAD_TOO_LARGE', `Declared payload ${payloadLen} exceeds max ${MAX_FRAME_PAYLOAD_BYTES}`);
  }
  if (bytes.byteLength !== HEADER_BYTE_LENGTH + payloadLen) {
    throw new ProtocolError(
      'LENGTH_MISMATCH',
      `Frame length ${bytes.byteLength} does not match header + payload (${HEADER_BYTE_LENGTH + payloadLen})`
    );
  }
  const payload = bytes.slice(HEADER_BYTE_LENGTH, HEADER_BYTE_LENGTH + payloadLen);
  return {
    type: rawType as FrameType,
    channel,
    seq,
    payload
  };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function encodeControlFrame(seq: bigint, msg: ControlMessage): Uint8Array {
  const json = JSON.stringify(msg);
  const payload = textEncoder.encode(json);
  return encodeFrame({
    type: FrameType.Control,
    channel: CONTROL_CHANNEL_ID,
    seq,
    payload
  });
}

export function decodeControlPayload(payload: Uint8Array): ControlMessage {
  let parsed: unknown;
  try {
    const text = textDecoder.decode(payload);
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProtocolError('INVALID_CONTROL_JSON', `Failed to parse control JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError('INVALID_CONTROL_OBJECT', 'Control payload must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== 'string' || obj.type.length === 0) {
    throw new ProtocolError('MISSING_CONTROL_TYPE', 'Control message missing string "type" field');
  }
  return parsed as ControlMessage;
}

export class FlowController {
  private readonly sendCredits = new Map<number, number>();
  private readonly defaultCredit: number;

  constructor(defaultCredit: number = DEFAULT_CHANNEL_CREDIT_BYTES) {
    this.defaultCredit = defaultCredit;
  }

  public initChannel(channel: number, initialCredit: number = this.defaultCredit): void {
    this.sendCredits.set(channel, initialCredit);
  }

  public getAvailableCredit(channel: number): number {
    if (!this.sendCredits.has(channel)) {
      this.sendCredits.set(channel, this.defaultCredit);
    }
    return this.sendCredits.get(channel) ?? 0;
  }

  public consumeCredit(channel: number, bytes: number): boolean {
    if (bytes < 0 || !Number.isInteger(bytes)) {
      throw new ProtocolError('INVALID_CREDIT_AMOUNT', `Invalid credit consumption: ${bytes}`);
    }
    const available = this.getAvailableCredit(channel);
    if (available < bytes) {
      return false;
    }
    this.sendCredits.set(channel, available - bytes);
    return true;
  }

  public addCredit(channel: number, bytes: number): number {
    if (bytes <= 0 || !Number.isInteger(bytes)) {
      throw new ProtocolError('INVALID_CREDIT_GRANT', `Credit grant must be positive integer: ${bytes}`);
    }
    const next = this.getAvailableCredit(channel) + bytes;
    this.sendCredits.set(channel, next);
    return next;
  }
}
