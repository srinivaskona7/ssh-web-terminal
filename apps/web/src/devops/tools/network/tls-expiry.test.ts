import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TLS_LOCAL_COMMAND,
  parseLocalCertProbe,
  parseNotAfter,
  parseRemoteCertProbe,
  parseX509Lines,
  tlsExpiryTool
} from './tls-expiry.js';
import { fakeSession, repliesFor } from '../system/testing/fake-session.js';

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

const FP_LE = 'sha256 Fingerprint=4F:0B:9C:6A:21:D7:3E:58:90:AA:12:34:56:78:9A:BC:DE:F0:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE';
const FP_INTRANET = 'sha256 Fingerprint=80:D4:36:34:84:76:BA:2E:9F:A2:44:32:6E:2F:AF:86:54:7A:67:86:27:43:79:B6:10:5D:3A:AC:24:DF:64:D3';

// OpenSSL 3.0 (Ubuntu 22.04) prints `CN = x`; 3.2+ prints `CN=x`.
const LE_CERT = [
  '|subject=CN = example.com',
  "|issuer=C = US, O = Let's Encrypt, CN = R11",
  '|notAfter=Nov 10 08:15:00 2026 GMT',
  `|${FP_LE}`,
  '|X509v3 Subject Alternative Name: ',
  '|    DNS:example.com, DNS:www.example.com'
];

// Root on Ubuntu 22.04: certbot's live cert, nginx pointing at the same
// certificate through fullchain.pem (sites-available and the sites-enabled
// symlink), an Apache intranet certificate without SAN, an expired legacy
// certificate, a missing file, and a certificate chosen per request.
const LOCAL_ROOT = [
  '@@WEBSSH:cert /etc/letsencrypt/live/example.com/cert.pem',
  '@@WEBSSH:from letsencrypt',
  '@@WEBSSH:x509',
  ...LE_CERT,
  '@@WEBSSH:rc 0',
  '@@WEBSSH:cert /etc/letsencrypt/live/example.com/fullchain.pem',
  '@@WEBSSH:from /etc/nginx/sites-available/example:14',
  '@@WEBSSH:x509',
  ...LE_CERT,
  '@@WEBSSH:rc 0',
  '@@WEBSSH:cert /etc/letsencrypt/live/example.com/fullchain.pem',
  '@@WEBSSH:from /etc/nginx/sites-enabled/example:14',
  '@@WEBSSH:x509',
  ...LE_CERT,
  '@@WEBSSH:rc 0',
  '@@WEBSSH:cert /etc/nginx/certs/$ssl_server_name.crt',
  '@@WEBSSH:from /etc/nginx/conf.d/multi.conf:5',
  '@@WEBSSH:variable',
  '@@WEBSSH:cert /etc/nginx/ssl/old.pem',
  '@@WEBSSH:from /etc/nginx/conf.d/old.conf:3',
  '@@WEBSSH:x509',
  '|Could not open file or uri for loading certificate from /etc/nginx/ssl/old.pem: No such file or directory',
  '@@WEBSSH:rc 1',
  '@@WEBSSH:cert /etc/ssl/certs/intranet.crt',
  '@@WEBSSH:from /etc/apache2/sites-enabled/intranet.conf:8',
  '@@WEBSSH:x509',
  '|No extensions in certificate',
  '|subject=C=GB, O=Example Ltd, CN="intranet, legacy"',
  '|issuer=C=GB, O=Example Ltd, CN=Example Internal CA',
  '|notAfter=Jan  3 00:00:00 2027 GMT',
  `|${FP_INTRANET}`,
  '@@WEBSSH:rc 0',
  '@@WEBSSH:cert /etc/ssl/certs/legacy.pem',
  '@@WEBSSH:from /etc/apache2/sites-enabled/legacy.conf:11',
  '@@WEBSSH:x509',
  '|subject=CN=legacy.example.com',
  '|issuer=CN=legacy.example.com',
  '|notAfter=Oct  1 00:00:00 2026 GMT',
  '|sha256 Fingerprint=36:BD:24:28:19:69:7D:D9:4F:FE:08:49:45:68:41:85:DE:2C:01:A7:0D:E3:BF:7D:E1:7F:36:4D:E8:92:90:0F',
  '|X509v3 Subject Alternative Name: ',
  '|    DNS:legacy.example.com',
  '@@WEBSSH:rc 0',
  ''
].join('\n');

// A non-root user: certbot's directory is root-only, one Apache config is
// unreadable, and LibreSSL/OpenSSL 1.0 has no -ext and cannot open a key-protected file.
const LOCAL_USER = [
  '@@WEBSSH:unreadable /etc/letsencrypt/live',
  '@@WEBSSH:denied 2 /etc/httpd',
  '@@WEBSSH:cert /etc/pki/tls/certs/www.crt',
  '@@WEBSSH:from /etc/httpd/conf.d/ssl.conf:85',
  '@@WEBSSH:noext',
  '@@WEBSSH:x509',
  '|subject= /C=US/O=Example/CN=www.example.org',
  '|issuer= /C=US/O=DigiCert Inc/CN=DigiCert TLS RSA SHA256 2020 CA1',
  '|notAfter=Feb 28 23:59:59 2027 GMT',
  '|SHA256 Fingerprint=06:DB:C2:55:7D:7E:A3:49:7F:16:94:23:5F:D9:CF:2D:A9:8D:F2:16:8F:B2:95:A0:EC:19:09:09:C4:C2:17:11',
  '@@WEBSSH:rc 0',
  '@@WEBSSH:cert /etc/pki/tls/private/combined.pem',
  '@@WEBSSH:from /etc/httpd/conf.d/api.conf:12',
  '@@WEBSSH:x509',
  '|Error opening Certificate /etc/pki/tls/private/combined.pem',
  "|139872544634688:error:0200100D:system library:fopen:Permission denied:crypto/bio/bss_file.c:69:fopen('/etc/pki/tls/private/combined.pem','r')",
  '|unable to load certificate',
  '@@WEBSSH:rc 1',
  ''
].join('\n');

const REMOTE_OK = [
  '@@WEBSSH:rc 0',
  '@@WEBSSH:diag',
  '|Verify return code: 0 (ok)',
  '@@WEBSSH:x509',
  '|subject=CN = api.example.com',
  '|issuer=C = US, O = Amazon, CN = Amazon RSA 2048 M02',
  '|notAfter=Nov 20 23:59:59 2026 GMT',
  '|sha256 Fingerprint=EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD',
  '@@WEBSSH:x509rc 0',
  ''
].join('\n');

const REMOTE_REFUSED = [
  '@@WEBSSH:rc 1',
  '@@WEBSSH:diag',
  '|4007D5B1F17F0000:error:8000006F:system library:BIO_connect:Connection refused:../crypto/bio/bio_sock2.c:114:calling connect()',
  '|connect:errno=111',
  '@@WEBSSH:x509',
  '|Could not find certificate from <stdin>',
  '@@WEBSSH:x509rc 1',
  ''
].join('\n');

describe('tls-expiry parsers', () => {
  it('reads notAfter in UTC, including single-digit days', () => {
    expect(parseNotAfter('Nov 10 08:15:00 2026 GMT')).toBe(Date.UTC(2026, 10, 10, 8, 15, 0));
    expect(parseNotAfter('Jan  3 00:00:00 2027 GMT')).toBe(Date.UTC(2027, 0, 3));
    expect(parseNotAfter('2027-01-03')).toBeNull();
    expect(parseNotAfter('Foo 3 00:00:00 2027 GMT')).toBeNull();
  });

  it('reads OpenSSL 3.0, 3.2+ and 1.0/LibreSSL subject styles', () => {
    expect(parseX509Lines(LE_CERT.map((l) => l.slice(1)), true)).toEqual({
      subject: 'CN = example.com',
      commonName: 'example.com',
      issuer: "C = US, O = Let's Encrypt, CN = R11",
      issuerLabel: "R11 (Let's Encrypt)",
      notAfter: Date.UTC(2026, 10, 10, 8, 15, 0),
      fingerprint: FP_LE.slice('sha256 Fingerprint='.length),
      names: ['example.com', 'www.example.com']
    });
    const quoted = parseX509Lines(['No extensions in certificate', 'subject=C=GB, O=Example Ltd, CN="intranet, legacy"', 'issuer=CN=Example Internal CA'], true);
    expect(quoted.commonName).toBe('intranet, legacy');
    expect(quoted.issuerLabel).toBe('Example Internal CA');
    // Asked for and absent: reported as none.
    expect(quoted.names).toEqual([]);
    const old = parseX509Lines(['subject= /C=US/O=Example/CN=www.example.org', 'issuer= /C=US/O=DigiCert Inc/CN=DigiCert TLS RSA SHA256 2020 CA1'], false);
    expect(old).toMatchObject({ subject: '/C=US/O=Example/CN=www.example.org', commonName: 'www.example.org', issuerLabel: 'DigiCert TLS RSA SHA256 2020 CA1 (DigiCert Inc)' });
    // Not asked for (no -ext): not reported.
    expect(old.names).toBeNull();
    expect(parseX509Lines(['X509v3 Subject Alternative Name: critical', '    DNS:a.test, IP Address:10.0.0.5'], true).names).toEqual(['a.test', 'IP Address:10.0.0.5']);
  });

  it('groups probe output into one record per reference', () => {
    const probe = parseLocalCertProbe(LOCAL_USER);
    expect(probe.unreadableDirs).toEqual(['/etc/letsencrypt/live']);
    expect(probe.deniedConfigs).toEqual([{ dir: '/etc/httpd', count: 2 }]);
    expect(probe.records.map((r) => [r.path, r.sources, r.exitCode, r.extSupported, r.variable])).toEqual([
      ['/etc/pki/tls/certs/www.crt', ['/etc/httpd/conf.d/ssl.conf:85'], 0, false, false],
      ['/etc/pki/tls/private/combined.pem', ['/etc/httpd/conf.d/api.conf:12'], 1, true, false]
    ]);
    expect(parseLocalCertProbe('')).toEqual({ unreadableDirs: [], deniedConfigs: [], records: [] });
  });

  it('reads the remote handshake answer', () => {
    expect(parseRemoteCertProbe(REMOTE_OK)).toMatchObject({ exitCode: 0, verify: { code: 0, text: 'ok' }, x509ExitCode: 0 });
    expect(parseRemoteCertProbe(REMOTE_REFUSED)).toMatchObject({ exitCode: 1, verify: null, x509ExitCode: 1, reason: 'connection refused' });
  });
});

describe('tlsExpiryTool', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('previews the local scan, plus the handshake only when a host is given', () => {
    expect(tlsExpiryTool.id).toBe('tls-expiry');
    expect(tlsExpiryTool.preview({})).toEqual([TLS_LOCAL_COMMAND]);
    expect(tlsExpiryTool.preview({ host: '', port: '443' })).toEqual([TLS_LOCAL_COMMAND]);
    expect(TLS_LOCAL_COMMAND).toContain('openssl x509 -noout -subject -issuer -enddate -fingerprint -sha256 -ext subjectAltName -in "$1"');
    // LibreSSL and OpenSSL 1.0 reject -ext before opening the file, so only that answer drops it.
    expect(TLS_LOCAL_COMMAND).toContain('case $out in *"unknown option"*) ext=0;; esac');
    expect(TLS_LOCAL_COMMAND).toContain('/etc/letsencrypt/live');
    expect(TLS_LOCAL_COMMAND).toContain('for d in /etc/nginx /etc/apache2 /etc/httpd');
    const [, remote] = tlsExpiryTool.preview({ host: 'api.example.com', port: '8443' });
    expect(remote!.endsWith(" sh 'api.example.com:8443' 'api.example.com'")).toBe(true);
    expect(remote).toContain('openssl s_client -servername "$2" -connect "$1" </dev/null');
    // No SNI for IP literals; IPv6 is bracketed for -connect.
    expect(tlsExpiryTool.preview({ host: '2001:db8::5', port: '443' })[1]!.endsWith(" sh '[2001:db8::5]:443' ''")).toBe(true);
    expect(tlsExpiryTool.preview({ host: 'api.example.com', port: 'https' })).toEqual([]);
    expect(tlsExpiryTool.preview({ host: 'a b', port: '443' })).toEqual([]);
  });

  it('reports expiry per certificate, once per certificate, worst first', async () => {
    const fake = fakeSession(repliesFor([TLS_LOCAL_COMMAND], [{ stdout: LOCAL_ROOT }]), 'root');
    const result = await tlsExpiryTool.run(fake.session, {});
    expect(fake.commands).toEqual([TLS_LOCAL_COMMAND]);
    expect(result.status).toBe('ok');
    expect(result.summary).toBe('3 certificates checked: 1 expired, 1 expires within 30 days.');

    const rows = result.tables[0]!.rows;
    expect(rows.map((r) => [r.location, r.daysLeft, r.state])).toEqual([
      ['/etc/ssl/certs/legacy.pem', -37, 'expired'],
      ['/etc/letsencrypt/live/example.com/cert.pem', 3, 'expires within 7 days'],
      ['/etc/letsencrypt/live/example.com/fullchain.pem', 3, 'expires within 7 days'],
      ['/etc/ssl/certs/intranet.crt', 57, 'valid'],
      ['/etc/nginx/certs/$ssl_server_name.crt', null, 'chosen per request'],
      ['/etc/nginx/ssl/old.pem', null, 'file missing']
    ]);
    expect(rows[2]).toMatchObject({
      referencedBy: '/etc/nginx/sites-available/example:14, /etc/nginx/sites-enabled/example:14',
      subject: 'example.com',
      names: 'example.com, www.example.com',
      issuer: "R11 (Let's Encrypt)",
      expires: '2026-11-10'
    });
    expect(rows[3]).toMatchObject({ names: '', subject: 'intranet, legacy' });

    expect(result.findings.map((f) => [f.severity, f.title])).toEqual([
      ['critical', 'legacy.example.com expired on 2026-10-01'],
      ['critical', 'example.com expires in 3 days (2026-11-10)'],
      ['warning', '/etc/nginx/ssl/old.pem does not exist'],
      ['info', '/etc/nginx/conf.d/multi.conf:5 picks its certificate per request']
    ]);
    expect(result.findings[1]!.detail).toBe(
      '/etc/letsencrypt/live/example.com/cert.pem, /etc/letsencrypt/live/example.com/fullchain.pem; referenced by letsencrypt, /etc/nginx/sites-available/example:14, /etc/nginx/sites-enabled/example:14'
    );
  });

  it('is partial for a non-root user and says exactly what it could not read', async () => {
    const fake = fakeSession(repliesFor([TLS_LOCAL_COMMAND], [{ stdout: LOCAL_USER }]));
    const result = await tlsExpiryTool.run(fake.session, {});
    expect(result.status).toBe('partial');
    expect(result.notes).toEqual([
      '/etc/letsencrypt/live is readable only by root here; its certificates are not reported.',
      '2 config files under /etc/httpd could not be read; certificates they reference are not reported.',
      '/etc/pki/tls/private/combined.pem could not be read (permission denied).',
      'This openssl cannot print subjectAltName (-ext), so certificate names are not reported.'
    ]);
    const rows = result.tables[0]!.rows;
    expect(rows[0]).toMatchObject({ location: '/etc/pki/tls/certs/www.crt', daysLeft: 114, state: 'valid', names: null });
    expect(rows[1]).toMatchObject({ location: '/etc/pki/tls/private/combined.pem', daysLeft: null, state: 'unreadable', expires: null });
    expect(result.findings).toEqual([{ severity: 'ok', title: '1 certificate is valid for at least 30 more days' }]);
  });

  it('checks a remote endpoint from the server and reports verification problems', async () => {
    const input = { host: 'api.example.com', port: '443' };
    const commands = tlsExpiryTool.preview(input);
    const unverified = REMOTE_OK.replace('Verify return code: 0 (ok)', 'Verify return code: 20 (unable to get local issuer certificate)');
    const fake = fakeSession(repliesFor(commands, [{ stdout: '' }, { stdout: unverified }]));
    const result = await tlsExpiryTool.run(fake.session, input);
    expect(fake.commands).toEqual(commands);
    expect(result.status).toBe('ok');
    expect(result.tables[0]!.rows).toEqual([
      {
        location: 'api.example.com:443',
        referencedBy: 'TLS handshake from the server',
        subject: 'api.example.com',
        names: null,
        issuer: 'Amazon RSA 2048 M02 (Amazon)',
        expires: '2026-11-20',
        daysLeft: 14,
        state: 'expires within 30 days'
      }
    ]);
    expect(result.findings.map((f) => [f.severity, f.title])).toEqual([
      ['warning', 'api.example.com expires in 14 days (2026-11-20)'],
      ['warning', 'api.example.com:443 does not verify on the server: unable to get local issuer certificate'],
      ['info', "No certificate files were found in Let's Encrypt, nginx or Apache configuration"]
    ]);
  });

  it('is partial when the handshake fails, without inventing a certificate', async () => {
    const input = { host: 'api.example.com', port: '443' };
    const commands = tlsExpiryTool.preview(input);
    const result = await tlsExpiryTool.run(fakeSession(repliesFor(commands, [{ stdout: '' }, { stdout: REMOTE_REFUSED }])).session, input);
    expect(result.status).toBe('partial');
    expect(result.notes).toContain('No certificate from api.example.com:443: connection refused');
    expect(result.tables[0]!.rows).toEqual([]);
    expect(result.findings.map((f) => f.title)).toEqual([
      'No certificate from api.example.com:443: connection refused',
      "No certificate files were found in Let's Encrypt, nginx or Apache configuration"
    ]);
  });

  it('is unavailable without openssl', async () => {
    const fake = fakeSession(repliesFor([TLS_LOCAL_COMMAND], [{ exitCode: 127 }]));
    const result = await tlsExpiryTool.run(fake.session, {});
    expect(result.status).toBe('unavailable');
    expect(result.summary).toBe('openssl is not installed on this server.');
    expect(result.tables).toEqual([]);
  });

  it('runs nothing for invalid input', async () => {
    const fake = fakeSession({});
    const result = await tlsExpiryTool.run(fake.session, { host: 'api.example.com', port: '0' });
    expect(result.status).toBe('error');
    expect(result.summary).toBe('Port must be between 1 and 65535');
    expect(fake.commands).toEqual([]);
  });
});
