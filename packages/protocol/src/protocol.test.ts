import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CONTROL_CHANNEL_ID,
  ENV_MAX_VALUE_BYTES,
  ENV_MAX_VARIABLES,
  FlowController,
  FrameType,
  HEADER_BYTE_LENGTH,
  MAX_FRAME_PAYLOAD_BYTES,
  ProtocolError,
  decodeControlPayload,
  decodeFrame,
  encodeControlFrame,
  encodeFrame,
  validateEnvVars,
  type ControlMessage
} from './index.js';

describe('@webssh/protocol binary framing & property/fuzz suite', () => {
  it('round-trips arbitrary valid frames via fast-check property testing', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          FrameType.Control,
          FrameType.PtyData,
          FrameType.SftpData,
          FrameType.Ping,
          FrameType.Pong
        ),
        fc.integer({ min: 0, max: 0xffff }),
        fc.bigInt({ min: 0n, max: 0xffffffffffffffffn }),
        fc.uint8Array({ minLength: 0, maxLength: 2048 }),
        (type, channel, seq, payload) => {
          const encoded = encodeFrame({ type, channel, seq, payload });
          expect(encoded.byteLength).toBe(HEADER_BYTE_LENGTH + payload.byteLength);
          const decoded = decodeFrame(encoded);
          expect(decoded.type).toBe(type);
          expect(decoded.channel).toBe(channel);
          expect(decoded.seq).toBe(seq);
          expect(decoded.payload).toEqual(payload);
        }
      ),
      { numRuns: 150 }
    );
  });

  it('safely rejects malformed or truncated binary frames without crashing (fuzz)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 256 }), (randomBytes) => {
        try {
          const frame = decodeFrame(randomBytes);
          expect(frame.payload.byteLength + HEADER_BYTE_LENGTH).toBe(randomBytes.byteLength);
        } catch (err) {
          expect(err).toBeInstanceOf(ProtocolError);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('rejects out-of-range fields and oversized frames', () => {
    expect(() =>
      encodeFrame({
        type: 99 as FrameType,
        channel: 1,
        seq: 1n,
        payload: new Uint8Array(0)
      })
    ).toThrow(ProtocolError);

    expect(() =>
      encodeFrame({
        type: FrameType.PtyData,
        channel: 70000,
        seq: 1n,
        payload: new Uint8Array(0)
      })
    ).toThrow(ProtocolError);

    expect(() =>
      encodeFrame({
        type: FrameType.PtyData,
        channel: 1,
        seq: -1n,
        payload: new Uint8Array(0)
      })
    ).toThrow(ProtocolError);

    const fakeHeader = new Uint8Array(HEADER_BYTE_LENGTH);
    const view = new DataView(fakeHeader.buffer);
    view.setUint8(0, FrameType.PtyData);
    view.setUint16(1, 1, false);
    view.setBigUint64(3, 1n, false);
    view.setUint32(11, MAX_FRAME_PAYLOAD_BYTES + 1, false);
    expect(() => decodeFrame(fakeHeader)).toThrow(/exceeds max/);
  });

  it('round-trips control messages and rejects invalid control JSON', () => {
    const messages: ControlMessage[] = [
      { type: 'hello', protocolVersion: 1, clientVersion: '1.0.0' },
      {
        type: 'connect',
        host: 'prod.example.com',
        port: 22,
        user: 'ubuntu',
        keyFingerprint: 'SHA256:abc123xyz',
        cols: 120,
        rows: 36,
        jump: [{ host: 'bastion.example.com', port: 22, user: 'ec2-user' }]
      },
      { type: 'sign_request', requestId: 'req-1', dataBase64: 'YWJj', algorithm: 'ssh-ed25519', keyFingerprint: 'SHA256:abc' },
      {
        type: 'sign_request',
        requestId: 'req-2',
        dataBase64: 'YWJj',
        algorithm: 'ssh-ed25519',
        keyFingerprint: 'SHA256:hop',
        host: 'bastion.example.com',
        port: 22,
        hopIndex: 1
      },
      { type: 'sign_response', requestId: 'req-1', signatureBase64: 'c2ln' },
      { type: 'credit', channel: 1, bytes: 65536 },
      { type: 'resync', firstAvailableSeq: '100', lastSeq: '250', truncatedBytes: 4096 },
      { type: 'exec_stream', opId: 'op-1', command: 'journalctl -fu nginx' },
      { type: 'exec_output', opId: 'op-1', stream: 'stderr', dataBase64: 'b29wcw==' },
      { type: 'exec_stream_end', opId: 'op-1', ok: false, error: 'cancelled', durationMs: 40 },
      { type: 'exec_cancel', opId: 'op-1' }
    ];

    for (const [idx, msg] of messages.entries()) {
      const raw = encodeControlFrame(BigInt(idx + 1), msg);
      const frame = decodeFrame(raw);
      expect(frame.channel).toBe(CONTROL_CHANNEL_ID);
      expect(frame.type).toBe(FrameType.Control);
      const decoded = decodeControlPayload(frame.payload);
      expect(decoded).toEqual(msg);
    }

    expect(() => decodeControlPayload(new TextEncoder().encode('not-json'))).toThrow(ProtocolError);
    expect(() => decodeControlPayload(new TextEncoder().encode('[]'))).toThrow(ProtocolError);
    expect(() => decodeControlPayload(new TextEncoder().encode('{}'))).toThrow(ProtocolError);
  });

  it('enforces credit-based flow control per channel', () => {
    const fcCtrl = new FlowController(1024);
    fcCtrl.initChannel(1, 1024);
    expect(fcCtrl.getAvailableCredit(1)).toBe(1024);
    expect(fcCtrl.consumeCredit(1, 512)).toBe(true);
    expect(fcCtrl.getAvailableCredit(1)).toBe(512);
    expect(fcCtrl.consumeCredit(1, 600)).toBe(false);
    expect(fcCtrl.addCredit(1, 512)).toBe(1024);
    expect(fcCtrl.consumeCredit(1, 1024)).toBe(true);
    expect(fcCtrl.getAvailableCredit(1)).toBe(0);
    expect(() => fcCtrl.consumeCredit(1, -5)).toThrow(ProtocolError);
    expect(() => fcCtrl.addCredit(1, 0)).toThrow(ProtocolError);
  });
});

describe('validateEnvVars', () => {
  it('accepts portable names and values within the limits', () => {
    expect(validateEnvVars({})).toEqual([]);
    expect(
      validateEnvVars({
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
        _private: '',
        APP_ENV2: 'x'.repeat(ENV_MAX_VALUE_BYTES),
        ['A'.repeat(64)]: 'ok'
      })
    ).toEqual([]);
  });

  it('rejects names that are empty, start with a digit, hold punctuation, or pass 64 characters', () => {
    const errors = validateEnvVars({
      '': 'a',
      '1ABC': 'b',
      'MY-VAR': 'c',
      'A B': 'd',
      'É': 'e',
      ['A'.repeat(65)]: 'f'
    });
    expect(errors.map((e) => [e.name, e.field])).toEqual([
      ['', 'name'],
      ['1ABC', 'name'],
      ['MY-VAR', 'name'],
      ['A B', 'name'],
      ['É', 'name'],
      ['A'.repeat(65), 'name']
    ]);
  });

  it('measures values in UTF-8 bytes, not characters', () => {
    // "é" is two bytes, so 2048 of them are exactly at the limit.
    expect(validateEnvVars({ GREETING: 'é'.repeat(2048) })).toEqual([]);
    expect(validateEnvVars({ GREETING: 'é'.repeat(2049) })).toEqual([
      { name: 'GREETING', field: 'value', message: expect.stringMatching(/4096 bytes/) }
    ]);
    expect(validateEnvVars({ BIG: 'x'.repeat(ENV_MAX_VALUE_BYTES + 1) })).toHaveLength(1);
  });

  it('rejects a NUL inside a value and a value that is not text', () => {
    expect(validateEnvVars({ BAD: 'a\u0000b' })).toEqual([
      { name: 'BAD', field: 'value', message: expect.stringMatching(/NUL/) }
    ]);
    expect(validateEnvVars({ NUM: 5 as unknown as string })).toEqual([
      { name: 'NUM', field: 'value', message: expect.any(String) }
    ]);
  });

  it(`allows ${ENV_MAX_VARIABLES} variables and reports one more as a count error`, () => {
    const env = Object.fromEntries(
      Array.from({ length: ENV_MAX_VARIABLES }, (_, i) => [`VAR_${i}`, 'x'])
    );
    expect(validateEnvVars(env)).toEqual([]);
    expect(validateEnvVars({ ...env, VAR_EXTRA: 'x' })).toEqual([
      { field: 'count', message: expect.stringMatching(/33 .*at most 32/) }
    ]);
  });
});
