import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveGatewaySessionClient, type LiveConnectParams } from './transport';
import { FakeGatewaySocket, bytesToBase64 } from './testing/fake-gateway-socket';

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  FakeGatewaySocket.instances = [];
});

function params(overrides: Partial<LiveConnectParams> = {}): LiveConnectParams {
  return {
    gatewayUrl: 'wss://gateway.example.com/ws',
    host: '10.0.0.9',
    port: 22,
    user: 'ubuntu',
    authMethod: 'password',
    password: 'secret',
    cols: 80,
    rows: 24,
    onPtyData: () => undefined,
    onHostKeyPrompt: async () => true,
    ...overrides
  };
}

const connectedFrame = {
  type: 'connected' as const,
  sessionId: 'sess-1',
  resumeToken: 'tok-1',
  ptyChannel: 1
};

/** Let the client's async frame handling run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function connectedClient(overrides: Partial<LiveConnectParams> = {}) {
  globalThis.WebSocket = FakeGatewaySocket as unknown as typeof WebSocket;
  const client = new LiveGatewaySessionClient(params(overrides));
  const pending = client.connect();
  const socket = FakeGatewaySocket.instances[0]!;
  socket.fireOpen();
  socket.receiveControl(connectedFrame);
  await pending;
  return { client, socket };
}

function streamOpId(socket: FakeGatewaySocket, index = 0): string {
  const streams = socket.controls().filter((msg) => msg.type === 'exec_stream');
  return String(streams[index]!.opId);
}

const b64 = (text: string) => bytesToBase64(new TextEncoder().encode(text));

describe('gateway execStream', () => {
  it('delivers stdout and stderr to the callbacks as each frame arrives', async () => {
    const { client, socket } = await connectedClient();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = client.execStream('tail -f /var/log/syslog', {
      onStdout: (text) => stdout.push(text),
      onStderr: (text) => stderr.push(text)
    });
    const sent = socket.lastControl('exec_stream')!;
    expect(sent).toMatchObject({ command: 'tail -f /var/log/syslog' });
    expect(sent).not.toHaveProperty('timeoutMs');
    const opId = streamOpId(socket);

    socket.receiveControl({ type: 'exec_output', opId, stream: 'stdout', dataBase64: b64('line 1\n') });
    await flush();
    expect(stdout).toEqual(['line 1\n']);
    socket.receiveControl({ type: 'exec_output', opId, stream: 'stderr', dataBase64: b64('warn\n') });
    socket.receiveControl({ type: 'exec_output', opId, stream: 'stdout', dataBase64: b64('line 2\n') });
    await flush();
    expect(stdout).toEqual(['line 1\n', 'line 2\n']);
    expect(stderr).toEqual(['warn\n']);

    socket.receiveControl({ type: 'exec_stream_end', opId, ok: true, exitCode: 0, durationMs: 12 });
    await expect(result).resolves.toEqual({
      stdout: 'line 1\nline 2\n',
      stderr: 'warn\n',
      exitCode: 0,
      durationMs: 12
    });
  });

  it('sends the timeout only when one is given', async () => {
    const { client, socket } = await connectedClient();
    void client.execStream('journalctl -f', { timeoutMs: 5000 });
    expect(socket.lastControl('exec_stream')).toMatchObject({ timeoutMs: 5000 });
  });

  it('joins a UTF-8 character split across two output frames', async () => {
    const { client, socket } = await connectedClient();
    const chunks: string[] = [];
    const result = client.execStream('cat', { onStdout: (text) => chunks.push(text) });
    const opId = streamOpId(socket);
    const bytes = new TextEncoder().encode('✓ done');
    socket.receiveControl({ type: 'exec_output', opId, stream: 'stdout', dataBase64: bytesToBase64(bytes.subarray(0, 1)) });
    socket.receiveControl({ type: 'exec_output', opId, stream: 'stdout', dataBase64: bytesToBase64(bytes.subarray(1)) });
    socket.receiveControl({ type: 'exec_stream_end', opId, ok: true, durationMs: 1 });
    await expect(result).resolves.toMatchObject({ stdout: '✓ done' });
    expect(chunks.join('')).toBe('✓ done');
    expect(chunks.some((chunk) => chunk.includes('�'))).toBe(false);
  });

  it('reads a missing exit code as 0 and resolves a nonzero one', async () => {
    const { client, socket } = await connectedClient();
    const clean = client.execStream('true');
    socket.receiveControl({ type: 'exec_stream_end', opId: streamOpId(socket, 0), ok: true, durationMs: 1 });
    await expect(clean).resolves.toMatchObject({ exitCode: 0 });

    const failing = client.execStream('false');
    socket.receiveControl({
      type: 'exec_stream_end',
      opId: streamOpId(socket, 1),
      ok: false,
      exitCode: 3,
      error: 'exit status 3',
      durationMs: 1
    });
    await expect(failing).resolves.toMatchObject({ exitCode: 3 });
  });

  it('rejects with the gateway error when the stream failed without an exit code', async () => {
    const { client, socket } = await connectedClient();
    const result = client.execStream('x');
    socket.receiveControl({
      type: 'exec_stream_end',
      opId: streamOpId(socket),
      ok: false,
      error: 'too many concurrent streams (max 4)',
      durationMs: 0
    });
    await expect(result).rejects.toThrow('too many concurrent streams (max 4)');
  });

  it('cancels on abort with exec_cancel and rejects with an AbortError', async () => {
    const { client, socket } = await connectedClient();
    const controller = new AbortController();
    const result = client.execStream('tail -f log', { signal: controller.signal });
    const opId = streamOpId(socket);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(socket.lastControl('exec_cancel')).toEqual({ type: 'exec_cancel', opId });
    // The gateway's own end frame after the cancel is ignored.
    socket.receiveControl({ type: 'exec_stream_end', opId, ok: false, error: 'cancelled', durationMs: 4 });
    await flush();
  });

  it('rejects at once for a signal that is already aborted, sending nothing', async () => {
    const { client, socket } = await connectedClient();
    const controller = new AbortController();
    controller.abort();
    await expect(client.execStream('ls', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    });
    expect(socket.lastControl('exec_stream')).toBeUndefined();
  });

  it('rejects every open stream when the socket drops, and refuses new ones', async () => {
    const { client, socket } = await connectedClient();
    const first = client.execStream('tail -f a');
    const second = client.execStream('tail -f b');
    socket.close();
    await expect(first).rejects.toThrow(/disconnected/);
    await expect(second).rejects.toThrow(/disconnected/);
    await expect(client.execStream('ls')).rejects.toThrow(/not connected/);
  });

  it('cancels open streams on the gateway when the session is closed', async () => {
    const { client, socket } = await connectedClient();
    const result = client.execStream('tail -f a');
    const opId = streamOpId(socket);
    client.close();
    await expect(result).rejects.toThrow(/closed/);
    expect(socket.lastControl('exec_cancel')).toEqual({ type: 'exec_cancel', opId });
  });

  it('keeps no output when retainOutput is false, still feeding callbacks', async () => {
    const { client, socket } = await connectedClient();
    const seen: string[] = [];
    const result = client.execStream('tail -f a', { retainOutput: false, onStdout: (text) => seen.push(text) });
    const opId = streamOpId(socket);
    socket.receiveControl({ type: 'exec_output', opId, stream: 'stdout', dataBase64: b64('kept nowhere\n') });
    socket.receiveControl({ type: 'exec_output', opId, stream: 'stderr', dataBase64: b64('nor this\n') });
    socket.receiveControl({ type: 'exec_stream_end', opId, ok: true, exitCode: 0, durationMs: 1 });
    await expect(result).resolves.toMatchObject({ stdout: '', stderr: '' });
    expect(seen).toEqual(['kept nowhere\n']);
  });

  it('fails the stream and cancels it when an output frame is not base64', async () => {
    const { client, socket } = await connectedClient();
    const result = client.execStream('cat');
    const opId = streamOpId(socket);
    socket.receiveControl({ type: 'exec_output', opId, stream: 'stdout', dataBase64: '%%%not base64' });
    await expect(result).rejects.toThrow(/output/i);
    expect(socket.lastControl('exec_cancel')).toEqual({ type: 'exec_cancel', opId });
  });
});

describe('gateway connect environment', () => {
  it('forwards env on connect and reports what the server accepted and rejected', async () => {
    globalThis.WebSocket = FakeGatewaySocket as unknown as typeof WebSocket;
    const env = { LANG: 'C.UTF-8', APP_ENV: 'staging', TZ: 'UTC' };
    const client = new LiveGatewaySessionClient(params({ env }));
    const pending = client.connect();
    const socket = FakeGatewaySocket.instances[0]!;
    socket.fireOpen();
    expect(socket.lastControl('connect')).toMatchObject({ env });
    socket.receiveControl({ ...connectedFrame, envAccepted: ['LANG'], envRejected: ['APP_ENV'] });
    await expect(pending).resolves.toMatchObject({ envAccepted: ['LANG'], envRejected: ['APP_ENV'] });
    expect(client.envOutcome).toEqual({ accepted: ['LANG'], rejected: ['APP_ENV'], notReported: ['TZ'] });
  });

  it('surfaces the env report of a newly opened channel', async () => {
    const { client, socket } = await connectedClient({ env: { LANG: 'C' } });
    const opened = client.openChannel(80, 24);
    const opId = String(socket.lastControl('open_channel')!.opId);
    socket.receiveControl({ type: 'channel_opened', opId, ok: true, channel: 2, envAccepted: [], envRejected: ['LANG'] });
    await expect(opened).resolves.toMatchObject({ channel: 2, envRejected: ['LANG'] });
  });

  it('sends no env field when none is requested', async () => {
    const { socket } = await connectedClient();
    expect(socket.lastControl('connect')).not.toHaveProperty('env');
  });

  it('refuses invalid variables before opening a socket', async () => {
    globalThis.WebSocket = FakeGatewaySocket as unknown as typeof WebSocket;
    const client = new LiveGatewaySessionClient(params({ env: { 'BAD-NAME': 'x' } }));
    await expect(client.connect()).rejects.toThrow(/^invalid_env: .*BAD-NAME/);
    expect(FakeGatewaySocket.instances).toHaveLength(0);
  });

  it('does not invent cipher, key exchange or server version the gateway left out', async () => {
    const { client } = await connectedClient();
    expect(client.sessionMetadata).not.toHaveProperty('cipher');
    expect(client.sessionMetadata).not.toHaveProperty('kex');
    expect(client.sessionMetadata).not.toHaveProperty('serverVersion');
  });
});

describe('gateway per-hop credentials and sign routing', () => {
  const hopKey = {
    host: 'bastion.example.com',
    port: 2222,
    user: 'jump',
    authMethod: 'remote_signer' as const,
    keyFingerprint: 'SHA256:hop',
    publicKey: 'ssh-ed25519 AAAAhop'
  };

  it('sends each hop with only its own credential fields', async () => {
    const { socket } = await connectedClient({
      jumpHops: [hopKey, { host: '10.1.0.5', port: 22, user: 'ops', password: '' }]
    });
    expect(socket.lastControl('connect')!.jump).toEqual([hopKey, { host: '10.1.0.5', port: 22, user: 'ops' }]);
  });

  it('answers a hop sign_request with the key its fingerprint names', async () => {
    const target = vi.fn(async () => 'dGFyZ2V0');
    const hop = vi.fn(async () => 'aG9w');
    const { socket } = await connectedClient({
      authMethod: 'remote_signer',
      password: undefined,
      keyFingerprint: 'SHA256:target',
      jumpHops: [hopKey],
      signers: { 'SHA256:target': target, 'SHA256:hop': hop }
    });
    socket.receiveControl({
      type: 'sign_request',
      requestId: 'r1',
      dataBase64: 'AA==',
      algorithm: 'ssh-ed25519',
      keyFingerprint: 'SHA256:hop',
      host: 'bastion.example.com',
      port: 2222,
      hopIndex: 1
    });
    await flush();
    expect(socket.lastControl('sign_response')).toEqual({
      type: 'sign_response',
      requestId: 'r1',
      signatureBase64: 'aG9w'
    });
    expect(hop).toHaveBeenCalledTimes(1);
    expect(target).not.toHaveBeenCalled();
  });

  it('refuses an unknown fingerprint with an empty signature and explains the failed connect', async () => {
    globalThis.WebSocket = FakeGatewaySocket as unknown as typeof WebSocket;
    const target = vi.fn(async () => 'dGFyZ2V0');
    const client = new LiveGatewaySessionClient(
      params({
        authMethod: 'remote_signer',
        password: undefined,
        keyFingerprint: 'SHA256:target',
        signers: { 'SHA256:target': target }
      })
    );
    const pending = client.connect();
    const socket = FakeGatewaySocket.instances[0]!;
    socket.fireOpen();
    socket.receiveControl({
      type: 'sign_request',
      requestId: 'r1',
      dataBase64: 'AA==',
      algorithm: 'ssh-ed25519',
      keyFingerprint: 'SHA256:stranger'
    });
    await flush();
    expect(socket.lastControl('sign_response')).toEqual({
      type: 'sign_response',
      requestId: 'r1',
      signatureBase64: ''
    });
    expect(target).not.toHaveBeenCalled();
    socket.receiveControl({ type: 'error', code: 'auth_failed', message: 'remote signer refused', fatal: true });
    await expect(pending).rejects.toThrow(/auth_failed: remote signer refused \(browser refused to sign: .*SHA256:stranger/);
  });
});

describe('gateway resume keeps the env verdict', () => {
  it('carries envAccepted/envRejected across a resume that does not resend them', async () => {
    globalThis.WebSocket = FakeGatewaySocket as unknown as typeof WebSocket;
    const client = new LiveGatewaySessionClient(params({ env: { LANG: 'C', APP_ENV: 'x' } }));
    const first = client.connect();
    FakeGatewaySocket.instances[0]!.fireOpen();
    FakeGatewaySocket.instances[0]!.receiveControl({ ...connectedFrame, envAccepted: ['LANG'], envRejected: ['APP_ENV'] });
    await first;
    const second = client.reconnect();
    const socketB = FakeGatewaySocket.instances[1]!;
    socketB.fireOpen();
    socketB.receiveControl(connectedFrame);
    await expect(second).resolves.toMatchObject({ envAccepted: ['LANG'], envRejected: ['APP_ENV'] });
    expect(client.envOutcome).toEqual({ accepted: ['LANG'], rejected: ['APP_ENV'], notReported: [] });
  });
});
