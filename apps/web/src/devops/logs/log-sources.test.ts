import { describe, expect, it } from 'vitest';
import { buildLogCommand } from './log-sources.js';

describe('buildLogCommand', () => {
  it('tails a file with -F so rotation does not end the stream', () => {
    expect(buildLogCommand({ kind: 'file', path: '/var/log/nginx/error.log' })).toEqual({
      ok: true,
      command: "tail -n 200 -F '/var/log/nginx/error.log'"
    });
  });

  it('follows a systemd unit without a pager', () => {
    expect(buildLogCommand({ kind: 'unit', unit: 'nginx.service' })).toEqual({
      ok: true,
      command: "journalctl -n 200 -f -u 'nginx.service' --no-pager"
    });
  });

  it('follows a docker container', () => {
    expect(buildLogCommand({ kind: 'container', container: 'web-1' })).toEqual({
      ok: true,
      command: "docker logs -n 200 -f 'web-1'"
    });
  });

  it('follows a pod, adding namespace and container only when given', () => {
    expect(buildLogCommand({ kind: 'pod', pod: 'web-7d9c8b-x2x4z' })).toEqual({
      ok: true,
      command: "kubectl logs --tail=200 -f 'web-7d9c8b-x2x4z'"
    });
    expect(
      buildLogCommand({ kind: 'pod', pod: 'deploy/web', namespace: ' shop ', podContainer: 'app' })
    ).toEqual({
      ok: true,
      command: "kubectl logs --tail=200 -f 'deploy/web' -n 'shop' -c 'app'"
    });
  });

  it('quotes a path with spaces and quotes as one argument', () => {
    expect(buildLogCommand({ kind: 'file', path: "/var/log/my app/it's.log" })).toEqual({
      ok: true,
      command: "tail -n 200 -F '/var/log/my app/it'\\''s.log'"
    });
  });

  it('rejects inputs that are not plain names or paths, per field', () => {
    expect(buildLogCommand({ kind: 'file', path: '-n 1 /etc/shadow' })).toEqual({
      ok: false,
      errors: { path: 'Path must not start with a hyphen' }
    });
    expect(buildLogCommand({ kind: 'unit', unit: 'nginx; reboot' })).toMatchObject({
      ok: false,
      errors: { unit: expect.stringMatching(/may contain/) }
    });
    expect(buildLogCommand({ kind: 'container', container: '$(id)' })).toMatchObject({
      ok: false,
      errors: { container: expect.any(String) }
    });
    // A NUL must come back as a validation error, not as posixQuote's exception.
    expect(buildLogCommand({ kind: 'file', path: '/var/log/a\u0000b' })).toEqual({
      ok: false,
      errors: { path: 'Path contains control characters' }
    });
    expect(buildLogCommand({ kind: 'pod', pod: '', namespace: 'bad ns', podContainer: 'a|b' })).toEqual({
      ok: false,
      errors: {
        pod: 'A name is required',
        namespace: 'Name may contain letters, digits and . _ - @ : /',
        podContainer: 'Name may contain letters, digits and . _ - @ : /'
      }
    });
  });
});
