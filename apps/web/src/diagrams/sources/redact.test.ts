import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactFields, redactTags } from './redact.js';

describe('redact', () => {
  it('drops managedFields and the last-applied annotation', () => {
    const out = redact({
      kind: 'Pod',
      metadata: {
        name: 'web',
        managedFields: [{ manager: 'kubectl' }],
        annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"x":1}', team: 'core' }
      }
    });
    expect(out.metadata).toEqual({ name: 'web', annotations: { team: 'core' } });
  });

  it('keeps env names and valueFrom references but not values', () => {
    const out = redact({
      spec: {
        containers: [
          {
            name: 'app',
            env: [
              { name: 'MODE', value: 'prod' },
              { name: 'DB', valueFrom: { secretKeyRef: { name: 'db-creds', key: 'url' } } }
            ]
          }
        ]
      }
    });
    const env = (out.spec.containers[0] as { env: Array<Record<string, unknown>> }).env;
    expect(env[0]).toEqual({ name: 'MODE', value: REDACTED });
    expect(env[1]).toEqual({ name: 'DB', valueFrom: { secretKeyRef: { name: 'db-creds', key: 'url' } } });
  });

  it('redacts Compose environment in list and map forms', () => {
    const out = redact({ environment: ['A=1', 'FLAG', 'B=x=y'] });
    expect(out.environment).toEqual([`A=${REDACTED}`, 'FLAG', `B=${REDACTED}`]);
    expect(redact({ environment: { A: '1', B: null } }).environment).toEqual({ A: REDACTED, B: null });
  });

  it('redacts Secret and ConfigMap data but keeps key names', () => {
    const secret = redact({ kind: 'Secret', metadata: { name: 's' }, data: { password: 'cGFzcw==' }, stringData: { k: 'v' } });
    expect(secret.data).toEqual({ password: REDACTED });
    expect(secret.stringData).toEqual({ k: REDACTED });
    const cm = redact({ kind: 'ConfigMap', data: { 'app.conf': 'listen 80' }, binaryData: { b: 'AA==' } });
    expect(cm.data).toEqual({ 'app.conf': REDACTED });
    expect(cm.binaryData).toEqual({ b: REDACTED });
  });

  it('redacts data by shape when kind is missing', () => {
    const out = redact({ metadata: { name: 'x' }, data: { a: 'b' } });
    expect(out.data).toEqual({ a: REDACTED });
  });

  it('leaves a data key alone on a non-secret kind', () => {
    expect(redact({ kind: 'Pod', data: { a: 'b' } }).data).toEqual({ a: 'b' });
  });

  it('redacts strings under credential-looking keys', () => {
    const out = redact({ dbPassword: 'hunter2', apiKey: 'k', token: 't', ok: 'fine', n: 3, nil: null });
    expect(out).toEqual({ dbPassword: REDACTED, apiKey: REDACTED, token: REDACTED, ok: 'fine', n: 3, nil: null });
  });

  it('keeps secretName and reference containers, wipes other credential objects', () => {
    const out = redact({
      volumes: [{ name: 'v', secret: { secretName: 'tls' } }],
      imagePullSecrets: [{ name: 'regcred' }],
      envFrom: [{ secretRef: { name: 'bundle' } }],
      credentials: { user: 'a', nested: { p: 'b' } }
    });
    expect(out.volumes).toEqual([{ name: 'v', secret: { secretName: 'tls' } }]);
    expect(out.imagePullSecrets).toEqual([{ name: 'regcred' }]);
    expect(out.envFrom).toEqual([{ secretRef: { name: 'bundle' } }]);
    expect(out.credentials).toEqual({ user: REDACTED, nested: { p: REDACTED } });
  });

  it('scrubs PEM blocks, URL passwords, flags and assignments in free text', () => {
    const out = redact({
      pem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
      url: 'postgres://app:s3cret@db:5432/x',
      cmd: 'run --password hunter2 --token=abc --name ok',
      line: 'DB_PASSWORD=zzz PATH=/bin'
    });
    expect(out.pem).toBe(REDACTED);
    expect(out.url).toBe(`postgres://app:${REDACTED}@db:5432/x`);
    expect(out.cmd).toBe(`run --password ${REDACTED} --token=${REDACTED} --name ok`);
    expect(out.line).toBe(`DB_PASSWORD=${REDACTED} PATH=/bin`);
  });

  it('does not mutate its input', () => {
    const input = { env: [{ name: 'A', value: 'b' }], metadata: { managedFields: [1] } };
    const copy = JSON.parse(JSON.stringify(input));
    redact(input);
    expect(input).toEqual(copy);
  });

  it('passes primitives through and caps depth', () => {
    expect(redact(5)).toBe(5);
    expect(redact(null)).toBeNull();
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 80; i += 1) deep = { a: deep };
    expect(JSON.stringify(redact(deep))).toContain(REDACTED);
  });
});

describe('redactFields and redactTags', () => {
  it('redacts credential keys and embedded credentials, keeps other value types', () => {
    const out = redactFields({ password: 'x', image: 'repo/app:1', cmd: 'x --token abc', replicas: 3, ready: true, none: null });
    expect(out).toEqual({ password: REDACTED, image: 'repo/app:1', cmd: `x --token ${REDACTED}`, replicas: 3, ready: true, none: null });
  });

  it('applies the same rule to tags', () => {
    expect(redactTags({ 'app.kubernetes.io/name': 'web', api_key: 'k' })).toEqual({
      'app.kubernetes.io/name': 'web',
      api_key: REDACTED
    });
  });
});
