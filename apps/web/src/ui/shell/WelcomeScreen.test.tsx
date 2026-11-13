// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import type { AuthMethod } from '../App';
import type { TransportBackendMode } from '../../transport';
import { CONNECT_FIELD_MESSAGES, WelcomeScreen, describeRoute, endpointHost, type WelcomeScreenProps } from './WelcomeScreen';

interface Options {
  connectErrorMsg?: string;
  authMethod?: AuthMethod;
  transportMode?: TransportBackendMode;
  gatewayUrl?: string;
  connectHost?: string;
  connectUser?: string;
  connectPort?: string;
  turnstileSiteKey?: string;
  isConnecting?: boolean;
  browserKeyLine?: string;
  browserKeyCopied?: boolean;
}

function setup(options: Options = {}) {
  const setConnectErrorMsg = vi.fn();
  const onNavigate = vi.fn();
  const onCancel = vi.fn();
  const onCopyBrowserKey = vi.fn();
  const props: WelcomeScreenProps = {
    recentHosts: [],
    setPendingJump: vi.fn(),
    setConnectModalOpen: vi.fn(),
    quickConnect: {
      connectHost: options.connectHost ?? '',
      setConnectHost: vi.fn(),
      connectUser: options.connectUser ?? '',
      setConnectUser: vi.fn(),
      connectPort: options.connectPort ?? '22',
      setConnectPort: vi.fn(),
      authMethod: options.authMethod ?? 'Password',
      setAuthMethod: vi.fn(),
      connectPassword: '',
      setConnectPassword: vi.fn(),
      keyPermissionMode: '0400',
      setKeyPermissionMode: vi.fn(),
      uploadedKeyContent: '',
      setUploadedKeyContent: vi.fn(),
      keyPassphrase: '',
      setKeyPassphrase: vi.fn(),
      connectErrorMsg: options.connectErrorMsg ?? '',
      setConnectErrorMsg,
      handleConnectSubmit: vi.fn(),
      handlePrivateKeyFileUpload: vi.fn(async () => {}),
      handleGenerateKey: vi.fn(async () => {}),
      browserKeyLine: options.browserKeyLine ?? '',
      browserKeyFingerprint: options.browserKeyLine ? 'SHA256:q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c' : '',
      onCopyBrowserKey,
      browserKeyCopied: options.browserKeyCopied ?? false,
      isConnecting: options.isConnecting ?? false,
      onCancel
    },
    transport: {
      transportMode: options.transportMode ?? 'go-gateway',
      setTransportMode: vi.fn(),
      gatewayUrl: options.gatewayUrl ?? 'ws://localhost:8080/ws',
      setGatewayUrl: vi.fn(),
      gatewayAuthToken: '',
      setGatewayAuthToken: vi.fn(),
      gatewayProbeStatus: null,
      setGatewayProbeStatus: vi.fn(),
      handleTestGateway: vi.fn(async () => {})
    },
    account: {
      relaySessionUser: '',
      relayLoginUser: '',
      setRelayLoginUser: vi.fn(),
      relayLoginPass: '',
      setRelayLoginPass: vi.fn(),
      handleRelayLogin: vi.fn(async () => {}),
      handleRelaySignOut: vi.fn()
    },
    guest: {
      turnstileSiteKey: options.turnstileSiteKey ?? '',
      turnstileResetNonce: 0,
      setTurnstileToken: vi.fn()
    },
    session: null,
    onNavigate
  };
  const el = document.createElement('div');
  document.body.appendChild(el);
  render(<WelcomeScreen {...props} />, el);
  const q = <T extends Element = HTMLElement>(selector: string): T | null => el.querySelector<T>(selector);
  return { el, q, setConnectErrorMsg, onNavigate, onCancel, onCopyBrowserKey };
}

afterEach(() => {
  document.body.innerHTML = '';
  delete (globalThis as { turnstile?: unknown }).turnstile;
});

describe('WelcomeScreen field errors', () => {
  const cases: Array<[keyof typeof CONNECT_FIELD_MESSAGES, string]> = [
    ['host', 'welcome-host-input'],
    ['user', 'welcome-user-input'],
    ['port', 'welcome-port-input'],
    ['password', 'welcome-password-input']
  ];

  it.each(cases)('renders the %s message under its field, wired for assistive tech', (field, inputId) => {
    const message = CONNECT_FIELD_MESSAGES[field];
    const { q } = setup({ connectErrorMsg: message });
    const input = q<HTMLInputElement>(`#${inputId}`);
    const error = q(`#welcome-${field}-error`);
    expect(error?.textContent).toBe(message);
    expect(error?.getAttribute('role')).toBe('alert');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.getAttribute('aria-describedby')).toBe(`welcome-${field}-error`);
    expect(q('[data-testid="connect-error-badge"]')).toBeNull();
  });

  it('sends server errors that mention a host or user to the status block, not a field', () => {
    const message = 'SSH_CONNECT_FAILED: authentication failed for user deploy on host example.org';
    const { el, q } = setup({ connectErrorMsg: message });
    expect(q('[data-testid="connect-error-badge"]')?.textContent).toBe(message);
    expect(el.querySelector('.webssh-welcome-field-error')).toBeNull();
    expect(el.querySelector('[aria-invalid="true"]')).toBeNull();
  });

  it('never swallows a message that happens to match an object property name', () => {
    const { q } = setup({ connectErrorMsg: 'constructor' });
    expect(q('[data-testid="connect-error-badge"]')?.textContent).toBe('constructor');
  });

  it('clears the error when the user edits the host', () => {
    const { q, setConnectErrorMsg } = setup({ connectErrorMsg: CONNECT_FIELD_MESSAGES.host });
    const host = q<HTMLInputElement>('#welcome-host-input');
    if (!host) throw new Error('host input missing');
    host.value = 'example.org';
    host.dispatchEvent(new Event('input', { bubbles: true }));
    expect(setConnectErrorMsg).toHaveBeenCalledWith('');
  });
});

describe('WelcomeScreen browser key', () => {
  const BROWSER = 'Argon2id Ed25519 Key' as const;
  const LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK4sG2vGx0r3b9mQe1T8Wc5yZpLh7nUo2dXfVjRqEaBs prod-ed25519-key';

  it('shows no key before one is generated, only the action to create it', () => {
    const { q } = setup({ authMethod: BROWSER });
    expect(q('[data-testid="welcome-browser-key-line"]')).toBeNull();
    expect(q('[data-testid="welcome-generate-key-btn"]')?.textContent).toBe('Generate browser key');
  });

  it('shows the generated public key and fingerprint, with a copy action', () => {
    const { q, onCopyBrowserKey } = setup({ authMethod: BROWSER, browserKeyLine: LINE });
    const line = q<HTMLInputElement>('[data-testid="welcome-browser-key-line"]');
    expect(line?.value).toBe(LINE);
    expect(line?.readOnly).toBe(true);
    expect(q('label[for="welcome-browser-key-line"]')).not.toBeNull();
    expect(q('[data-testid="welcome-browser-key-fingerprint"]')?.textContent).toMatch(/^SHA256:/);
    expect(q('[data-testid="welcome-generate-key-btn"]')?.textContent).toBe('Generate a new key');
    const copy = q<HTMLButtonElement>('[data-testid="welcome-copy-browser-key-btn"]');
    expect(copy?.textContent).toBe('Copy');
    copy?.click();
    expect(onCopyBrowserKey).toHaveBeenCalledTimes(1);
  });

  it('says Copied only when the app reports the copy succeeded', () => {
    const { q } = setup({ authMethod: BROWSER, browserKeyLine: LINE, browserKeyCopied: true });
    expect(q('[data-testid="welcome-copy-browser-key-btn"]')?.textContent).toBe('Copied');
  });

  it('renders the missing-key message under the key controls, not in the status block', () => {
    const { q } = setup({ authMethod: BROWSER, connectErrorMsg: CONNECT_FIELD_MESSAGES.browserKey });
    const error = q('#welcome-browserKey-error');
    expect(error?.textContent).toBe(CONNECT_FIELD_MESSAGES.browserKey);
    expect(error?.getAttribute('role')).toBe('alert');
    expect(q('[data-testid="connect-error-badge"]')).toBeNull();
  });

  it('does not claim the key is protected by a passphrase', () => {
    const text = setup({ authMethod: BROWSER }).el.textContent ?? '';
    expect(text).not.toMatch(/wrapped|Argon2id/i);
    expect(text).toContain('cannot be exported');
  });
});

// Chromium breaks between consecutive dashes, so dash runs need help to stay on one line on phones.
describe('WelcomeScreen dash runs', () => {
  it('keeps a symbolic mode in an error on one line without changing the copied text', () => {
    const message = 'Permissions 0644 for private key are too open! OpenSSH requires chmod 0400 (-r--------) or 0600.';
    const { q } = setup({ connectErrorMsg: message });
    const badge = q('[data-testid="connect-error-badge"]');
    expect(badge?.textContent).toBe(message);
    expect(badge?.querySelector('.webssh-welcome-nowrap')?.textContent).toBe('(-r--------)');
  });

  it('joins every dash pair in the key placeholder, which still reads as the PEM header', () => {
    const { q } = setup({ authMethod: 'Private Key (.pem / id_rsa)' });
    const placeholder = q<HTMLTextAreaElement>('[data-testid="private-key-textarea"]')?.placeholder ?? '';
    expect(placeholder.replace(/\u2060/g, '')).toBe('-----BEGIN OPENSSH PRIVATE KEY-----');
    expect(placeholder).not.toMatch(/--/);
  });
});

describe('WelcomeScreen route panel', () => {
  it('says the relay only forwards, and the browser runs SSH', () => {
    const { q } = setup({ transportMode: 'cloudflare-relay', gatewayUrl: 'wss://relay.example.com/ws' });
    const hop = q('[data-testid="welcome-route-hop"]')?.textContent ?? '';
    expect(hop).toContain('Relay');
    expect(hop).toContain('relay.example.com');
    expect(hop).toContain('Forwards the encrypted SSH stream');
    expect(q('[data-testid="welcome-route"]')?.textContent).toContain('the host-key check and key signing happen in this tab');
  });

  it.each<[AuthMethod, string]>([
    ['Password', 'receives the password you enter'],
    ['Private Key (.pem / id_rsa)', 'receives the key file and its passphrase'],
    ['Argon2id Ed25519 Key', 'The browser key never leaves it']
  ])('states what the gateway receives with %s auth', (authMethod, expected) => {
    const { q } = setup({ authMethod });
    expect(q('[data-testid="welcome-route-hop"]')?.textContent).toContain(expected);
  });

  it('never claims secrets stay in the browser when the gateway receives them', () => {
    for (const authMethod of ['Password', 'Private Key (.pem / id_rsa)'] as const) {
      const { el } = setup({ authMethod });
      const text = el.textContent ?? '';
      expect(text).not.toMatch(/stays? in (this|your) (tab|browser)|never leaves/i);
      document.body.innerHTML = '';
    }
  });

  it('marks an unparseable endpoint as not configured', () => {
    const { q } = setup({ gatewayUrl: 'not a url' });
    expect(q('[data-testid="welcome-route-hop"] .webssh-welcome-route-missing')?.textContent).toBe('not configured');
  });

  it('shows the target from the form, with placeholders until it is filled', () => {
    const empty = setup().q('[data-testid="welcome-route-target"]');
    expect(empty?.textContent).toBe('user@host:22');
    expect(empty?.classList.contains('webssh-welcome-route-host--empty')).toBe(true);
    document.body.innerHTML = '';
    const filled = setup({ connectHost: ' build-01 ', connectUser: 'deploy', connectPort: '2222' }).q('[data-testid="welcome-route-target"]');
    expect(filled?.textContent).toBe('deploy@build-01:2222');
    expect(filled?.classList.contains('webssh-welcome-route-host--empty')).toBe(false);
  });
});

describe('WelcomeScreen guest check and actions', () => {
  it('renders the guest check only in relay mode with a site key', () => {
    (globalThis as { turnstile?: unknown }).turnstile = { render: vi.fn(() => 'w1'), reset: vi.fn(), remove: vi.fn() };
    expect(setup({ transportMode: 'cloudflare-relay' }).q('[data-testid="guest-challenge"]')).toBeNull();
    document.body.innerHTML = '';
    expect(setup({ transportMode: 'go-gateway', turnstileSiteKey: 'site-key' }).q('[data-testid="guest-challenge"]')).toBeNull();
    document.body.innerHTML = '';
    expect(setup({ transportMode: 'cloudflare-relay', turnstileSiteKey: 'site-key' }).q('[data-testid="guest-challenge"]')).not.toBeNull();
  });

  it('offers Saved hosts at rest and Cancel while connecting', () => {
    const idle = setup();
    idle.q<HTMLButtonElement>('[data-testid="welcome-saved-hosts-btn"]')?.click();
    expect(idle.onNavigate).toHaveBeenCalledWith('hosts');
    expect(idle.q('[data-testid="welcome-cancel-btn"]')).toBeNull();
    document.body.innerHTML = '';

    const busy = setup({ isConnecting: true });
    const submit = busy.q<HTMLButtonElement>('[data-testid="welcome-connect-submit-btn"]');
    expect(submit?.textContent).toBe('Connecting…');
    expect(submit?.disabled).toBe(true);
    expect(busy.q('[data-testid="welcome-connect-form"]')?.getAttribute('aria-busy')).toBe('true');
    busy.q<HTMLButtonElement>('[data-testid="welcome-cancel-btn"]')?.click();
    expect(busy.onCancel).toHaveBeenCalledTimes(1);
    expect(busy.q('[data-testid="welcome-saved-hosts-btn"]')).toBeNull();
  });
});

describe('route helpers', () => {
  it('endpointHost returns host:port, or null for anything that is not a URL', () => {
    expect(endpointHost(' wss://relay.example.com:8443/ws ')).toBe('relay.example.com:8443');
    expect(endpointHost('')).toBeNull();
    expect(endpointHost('not a url')).toBeNull();
    expect(endpointHost('gw.example.com/ws')).toBe('gw.example.com');
  });

  it('describeRoute gives relay mode the same copy for every auth method', () => {
    const relay = describeRoute('cloudflare-relay', 'Password');
    expect(describeRoute('cloudflare-relay', 'Private Key (.pem / id_rsa)')).toEqual(relay);
    expect(describeRoute('cloudflare-relay', 'Argon2id Ed25519 Key')).toEqual(relay);
  });
});
