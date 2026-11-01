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

export interface JumpHop {
  host: string;
  port: number;
  user: string;
  keyFingerprint?: string;
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
      keyFingerprint: string;
      jump?: JumpHop[];
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
      cipher: string;
      serverVersion: string;
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
      op: 'list' | 'stat' | 'mkdir' | 'remove' | 'rename' | 'upload_init' | 'upload_chunk' | 'upload_commit' | 'download_read' | 'write_file' | 'read_file';
      path: string;
      targetPath?: string;
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
      sha256?: string;
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
