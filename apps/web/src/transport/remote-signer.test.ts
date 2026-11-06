import { describe, expect, it, vi } from 'vitest';
import type { JumpHop } from '@webssh/protocol';
import {
  hopHasOwnCredential,
  routeSignRequest,
  toWireJumpHop,
  type SignRequestMessage,
  type SignRoutingParams
} from './remote-signer';

function request(overrides: Partial<SignRequestMessage> = {}): SignRequestMessage {
  return {
    type: 'sign_request',
    requestId: 'sig-1',
    dataBase64: 'Y2hhbGxlbmdl',
    algorithm: 'ssh-ed25519',
    keyFingerprint: 'SHA256:target',
    ...overrides
  };
}

const signerReturning = (signature: string) => vi.fn(async (_req: SignRequestMessage) => signature);

const ownKeyHop: JumpHop = {
  host: 'bastion.example.com',
  port: 2222,
  user: 'jump',
  authMethod: 'remote_signer',
  keyFingerprint: 'SHA256:hop',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHop'
};
const inheritingHop: JumpHop = { host: '10.1.0.5', port: 22, user: 'ops' };

describe('routeSignRequest', () => {
  it('signs a target request with the key its fingerprint names and no other key', async () => {
    const target = signerReturning('dGFyZ2V0');
    const other = signerReturning('b3RoZXI=');
    const params: SignRoutingParams = {
      authMethod: 'remote_signer',
      keyFingerprint: 'SHA256:target',
      signers: { 'SHA256:target': target, 'SHA256:other': other }
    };
    await expect(routeSignRequest(params, request())).resolves.toEqual({
      ok: true,
      signatureBase64: 'dGFyZ2V0'
    });
    expect(target).toHaveBeenCalledWith(request());
    expect(other).not.toHaveBeenCalled();
  });

  it('signs for a hop with its own key, and for an inheriting hop with the target key', async () => {
    const target = signerReturning('dGFyZ2V0');
    const hop = signerReturning('aG9w');
    const params: SignRoutingParams = {
      authMethod: 'remote_signer',
      keyFingerprint: 'SHA256:target',
      jumpHops: [ownKeyHop, inheritingHop],
      signers: { 'SHA256:target': target, 'SHA256:hop': hop }
    };
    await expect(
      routeSignRequest(params, request({ hopIndex: 1, keyFingerprint: 'SHA256:hop' }))
    ).resolves.toEqual({ ok: true, signatureBase64: 'aG9w' });
    await expect(
      routeSignRequest(params, request({ hopIndex: 2, keyFingerprint: 'SHA256:target' }))
    ).resolves.toEqual({ ok: true, signatureBase64: 'dGFyZ2V0' });
    expect(hop).toHaveBeenCalledTimes(1);
    expect(target).toHaveBeenCalledTimes(1);
  });

  it('refuses a fingerprint that is not the one configured for the hop or target asking', async () => {
    const target = signerReturning('dGFyZ2V0');
    const hop = signerReturning('aG9w');
    const params: SignRoutingParams = {
      authMethod: 'remote_signer',
      keyFingerprint: 'SHA256:target',
      jumpHops: [ownKeyHop],
      signers: { 'SHA256:target': target, 'SHA256:hop': hop }
    };
    const hopAsksForTarget = await routeSignRequest(
      params,
      request({ hopIndex: 1, keyFingerprint: 'SHA256:target' })
    );
    expect(hopAsksForTarget).toEqual({
      ok: false,
      reason: expect.stringMatching(/jump hop 1 \(jump@bastion\.example\.com:2222\).*SHA256:hop.*SHA256:target/)
    });
    const targetAsksForHop = await routeSignRequest(params, request({ keyFingerprint: 'SHA256:hop' }));
    expect(targetAsksForHop).toMatchObject({ ok: false, reason: expect.stringMatching(/target/) });
    const unknown = await routeSignRequest(params, request({ keyFingerprint: 'SHA256:unknown' }));
    expect(unknown).toMatchObject({ ok: false, reason: expect.stringContaining('SHA256:unknown') });
    expect(target).not.toHaveBeenCalled();
    expect(hop).not.toHaveBeenCalled();
  });

  it('refuses a hop index outside the jump chain', async () => {
    const target = signerReturning('dGFyZ2V0');
    const params: SignRoutingParams = {
      authMethod: 'remote_signer',
      keyFingerprint: 'SHA256:target',
      jumpHops: [inheritingHop],
      signers: { 'SHA256:target': target }
    };
    for (const hopIndex of [0, 2, 1.5, -1]) {
      await expect(routeSignRequest(params, request({ hopIndex }))).resolves.toMatchObject({
        ok: false,
        reason: expect.stringMatching(/hop/)
      });
    }
    expect(target).not.toHaveBeenCalled();
  });

  it('refuses when the hop or target asking does not sign in with a browser key', async () => {
    const target = signerReturning('dGFyZ2V0');
    const passwordTarget: SignRoutingParams = {
      authMethod: 'password',
      keyFingerprint: 'SHA256:target',
      signers: { 'SHA256:target': target }
    };
    await expect(routeSignRequest(passwordTarget, request())).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/password/)
    });
    const passwordHop: SignRoutingParams = {
      authMethod: 'remote_signer',
      keyFingerprint: 'SHA256:target',
      jumpHops: [{ ...inheritingHop, authMethod: 'password', password: 'pw' }],
      signers: { 'SHA256:target': target }
    };
    await expect(routeSignRequest(passwordHop, request({ hopIndex: 1 }))).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/jump hop 1 .*password/)
    });
    const keylessHop: SignRoutingParams = {
      ...passwordHop,
      jumpHops: [{ ...inheritingHop, authMethod: 'remote_signer' }]
    };
    await expect(
      routeSignRequest(keylessHop, request({ hopIndex: 1, keyFingerprint: '' }))
    ).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/names no key/) });
    expect(target).not.toHaveBeenCalled();
  });

  it('refuses when no browser key matches, even for a name every object inherits', async () => {
    const params: SignRoutingParams = {
      authMethod: 'remote_signer',
      keyFingerprint: 'toString',
      signers: {}
    };
    await expect(routeSignRequest(params, request({ keyFingerprint: 'toString' }))).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(/no key in this browser matches toString/)
    });
  });

  it('turns a failing signer or an empty signature into a refusal', async () => {
    const params = (signer: SignRoutingParams['onSignRequest']): SignRoutingParams => ({
      authMethod: 'remote_signer',
      keyFingerprint: 'SHA256:target',
      signers: { 'SHA256:target': signer! }
    });
    const failing = vi.fn(async () => {
      throw new Error('vault is locked');
    });
    await expect(routeSignRequest(params(failing), request())).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(/SHA256:target.*vault is locked/)
    });
    await expect(routeSignRequest(params(signerReturning('')), request())).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(/no signature/)
    });
  });

  it('falls back to onSignRequest when no signer map is given, still bound to the configured key', async () => {
    const legacy = signerReturning('bGVnYWN5');
    const params: SignRoutingParams = {
      authMethod: 'remote_signer',
      keyFingerprint: 'SHA256:target',
      onSignRequest: legacy
    };
    await expect(routeSignRequest(params, request())).resolves.toEqual({
      ok: true,
      signatureBase64: 'bGVnYWN5'
    });
    await expect(
      routeSignRequest(params, request({ keyFingerprint: 'SHA256:elsewhere' }))
    ).resolves.toMatchObject({ ok: false });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing in the browser can sign', async () => {
    await expect(
      routeSignRequest({ authMethod: 'remote_signer', keyFingerprint: 'SHA256:target' }, request())
    ).resolves.toEqual({ ok: false, reason: expect.stringMatching(/no browser key signer/) });
  });
});

describe('jump hop credentials', () => {
  it('treats any non-empty credential field as the hop owning its sign-in', () => {
    expect(hopHasOwnCredential(inheritingHop)).toBe(false);
    expect(hopHasOwnCredential({ ...inheritingHop, password: '', keyFingerprint: '' })).toBe(false);
    for (const field of [
      'authMethod',
      'password',
      'publicKey',
      'privateKeyPem',
      'privateKeyPassphrase',
      'keyFingerprint'
    ] as const) {
      const value = field === 'authMethod' ? 'password' : 'x';
      expect(hopHasOwnCredential({ ...inheritingHop, [field]: value })).toBe(true);
    }
  });

  it('sends a hop with only its address and the credential fields it actually has', () => {
    expect(toWireJumpHop({ ...inheritingHop, password: '', publicKey: undefined })).toEqual(inheritingHop);
    expect(Object.keys(toWireJumpHop({ ...inheritingHop, password: '' }))).toEqual(['host', 'port', 'user']);
    expect(toWireJumpHop(ownKeyHop)).toEqual(ownKeyHop);
    expect(
      toWireJumpHop({
        ...inheritingHop,
        authMethod: 'private_key',
        privateKeyPem: 'PEM',
        privateKeyPassphrase: 'pp'
      })
    ).toEqual({ ...inheritingHop, authMethod: 'private_key', privateKeyPem: 'PEM', privateKeyPassphrase: 'pp' });
  });
});
