import type { JSX } from 'preact';
import { Badge, Button } from '@webssh/ui-kit';
import type { HostProfile } from '../../hosts';
import { validateGatewayWsUrl, type TransportBackendMode } from '../../transport';
import type { AuthMethod, KeyPermissionMode, PendingJump } from '../App';
import type { WorkspaceRemoteSession } from '../../session/adapters';
import { TurnstileWidget } from './TurnstileWidget';
import type { Setter } from './types';
import './welcome-screen.css';

export interface WelcomeQuickConnect {
  connectHost: string;
  setConnectHost: Setter<string>;
  connectUser: string;
  setConnectUser: Setter<string>;
  connectPort: string;
  setConnectPort: Setter<string>;
  authMethod: AuthMethod;
  setAuthMethod: Setter<AuthMethod>;
  connectPassword: string;
  setConnectPassword: Setter<string>;
  keyPermissionMode: KeyPermissionMode;
  setKeyPermissionMode: Setter<KeyPermissionMode>;
  uploadedKeyContent: string;
  setUploadedKeyContent: Setter<string>;
  keyPassphrase: string;
  setKeyPassphrase: Setter<string>;
  connectErrorMsg: string;
  setConnectErrorMsg: Setter<string>;
  handleConnectSubmit: (e?: Event) => void;
  handlePrivateKeyFileUpload: (e: Event) => Promise<void>;
  handleGenerateKey: () => Promise<void>;
  /** authorized_keys line of the browser key generated in this session; empty until one exists. */
  browserKeyLine: string;
  browserKeyFingerprint: string;
  onCopyBrowserKey: () => void;
  browserKeyCopied: boolean;
  isConnecting?: boolean;
  onCancel?: () => void;
}

export interface WelcomeTransport {
  transportMode: TransportBackendMode;
  setTransportMode: Setter<TransportBackendMode>;
  gatewayUrl: string;
  setGatewayUrl: Setter<string>;
  gatewayAuthToken: string;
  setGatewayAuthToken: Setter<string>;
  gatewayProbeStatus: { ok: boolean; message: string } | null;
  setGatewayProbeStatus: Setter<{ ok: boolean; message: string } | null>;
  handleTestGateway: (rawUrl?: string) => Promise<void>;
}

export interface WelcomeAccount {
  relaySessionUser: string;
  relayLoginUser: string;
  setRelayLoginUser: Setter<string>;
  relayLoginPass: string;
  setRelayLoginPass: Setter<string>;
  handleRelayLogin: () => Promise<void>;
  handleRelaySignOut: () => void;
}

export interface WelcomeGuest {
  turnstileSiteKey: string;
  turnstileResetNonce: number;
  setTurnstileToken: Setter<string>;
}

export interface WelcomeScreenProps {
  recentHosts: HostProfile[];
  setPendingJump: Setter<PendingJump | null>;
  setConnectModalOpen: Setter<boolean>;
  quickConnect: WelcomeQuickConnect;
  transport: WelcomeTransport;
  account: WelcomeAccount;
  guest: WelcomeGuest;
  session: WorkspaceRemoteSession | null;
  onNavigate: (screen: string) => void;
}

/**
 * Validation messages App's connect handler sets for a single field. They render under that
 * field; every other message (including server errors that merely mention a host or user)
 * goes to the status area, so no error is ever swallowed.
 */
export const CONNECT_FIELD_MESSAGES = {
  host: 'Host is required.',
  user: 'Username is required.',
  port: 'Port must be 1–65535.',
  password: 'Password is required for Password authentication.',
  browserKey: 'Generate a browser key first.'
} as const;

type ConnectField = keyof typeof CONNECT_FIELD_MESSAGES;

const FIELD_BY_MESSAGE = new Map<string, ConnectField>(
  (Object.entries(CONNECT_FIELD_MESSAGES) as Array<[ConnectField, string]>).map(([field, message]) => [message, field])
);

// Chromium wraps between consecutive dashes, splitting "KEY-----" and "(-r--------)" on phones. Word
// joiners (U+2060, invisible and unread) hold the placeholder's dash runs together; a symbolic mode in
// a message gets a nowrap span instead, so copying the message still yields plain text.
const KEY_PLACEHOLDER = '-----BEGIN OPENSSH PRIVATE KEY-----'.replace(/-(?=-)/g, '-\u2060');
const SYMBOLIC_MODE = /(\(-[rwx-]{9}\))/;

function keepModesWhole(message: string): Array<string | JSX.Element> {
  return message.split(SYMBOLIC_MODE).map((part, i) => (i % 2 === 1 ? <span key={i} className="webssh-welcome-nowrap">{part}</span> : part));
}

/** Host of the configured relay or gateway URL, or null when it does not parse. */
export function endpointHost(url: string): string | null {
  // Same normalisation Connect applies, so a schemeless URL it accepts is not shown as unset.
  const checked = validateGatewayWsUrl(url);
  if (!checked.valid) return null;
  try {
    return new URL(checked.normalizedUrl).host || null;
  } catch {
    return null;
  }
}

/**
 * What each hop does with this connection. Relay mode runs the SSH client in the browser
 * (browser-ssh-client.ts); gateway mode sends the password or imported PEM key in the
 * `connect` message and only browser keys stay behind the remote signer.
 */
export function describeRoute(mode: TransportBackendMode, authMethod: AuthMethod): { browser: string; hop: string } {
  if (mode === 'cloudflare-relay') {
    return {
      browser: 'Runs the SSH client: encryption, the host-key check and key signing happen in this tab.',
      hop: 'Forwards the encrypted SSH stream between this tab and your server.'
    };
  }
  const browser = 'Shows the terminal, files and tools. The gateway holds the SSH connection.';
  if (authMethod === 'Password') {
    return { browser, hop: 'Runs the SSH client for you, so it receives the password you enter.' };
  }
  if (authMethod === 'Private Key (.pem / id_rsa)') {
    return { browser, hop: 'Runs the SSH client for you, so it receives the key file and its passphrase.' };
  }
  return { browser, hop: 'Runs the SSH client for you and asks this tab to sign. The browser key never leaves it.' };
}

export function WelcomeScreen(props: WelcomeScreenProps): JSX.Element {
  const { quickConnect, transport, guest, onNavigate } = props;
  const {
    connectHost, setConnectHost, connectUser, setConnectUser, connectPort, setConnectPort,
    authMethod, setAuthMethod, connectPassword, setConnectPassword,
    keyPermissionMode, setKeyPermissionMode, uploadedKeyContent, setUploadedKeyContent,
    keyPassphrase, setKeyPassphrase,
    connectErrorMsg, setConnectErrorMsg, handleConnectSubmit,
    handlePrivateKeyFileUpload, handleGenerateKey, browserKeyLine, browserKeyFingerprint,
    onCopyBrowserKey, browserKeyCopied, isConnecting, onCancel,
  } = quickConnect;
  const { transportMode, gatewayUrl, gatewayProbeStatus } = transport;
  const { turnstileSiteKey, turnstileResetNonce, setTurnstileToken } = guest;

  const errorField = connectErrorMsg ? FIELD_BY_MESSAGE.get(connectErrorMsg) ?? null : null;
  const fieldError = (field: ConnectField): string | null => (errorField === field ? connectErrorMsg : null);
  const statusError = connectErrorMsg && !errorField ? connectErrorMsg : null;

  const isRelay = transportMode === 'cloudflare-relay';
  const hopHost = endpointHost(gatewayUrl);
  const route = describeRoute(transportMode, authMethod);
  const targetHost = connectHost.trim();
  const target = `${connectUser.trim() || 'user'}@${targetHost || 'host'}:${connectPort.trim() || '22'}`;

  return (
    <div className="webssh-panel-content webssh-welcome webssh-welcome-container" data-testid="screen-welcome">
      <div className="webssh-welcome-landing" data-testid="welcome-quick-connect-card">
        <div className="webssh-welcome-intro">
          <h1 className="webssh-welcome-heading">Open your server workspace</h1>
          <p className="webssh-welcome-lede">Connect to a server over SSH and get its terminal, files and tools in this tab.</p>
        </div>

        <section className="webssh-welcome-connect-card" aria-labelledby="welcome-new-connection-title">
          <h2 id="welcome-new-connection-title" className="webssh-welcome-card-title">New connection</h2>
          <form onSubmit={handleConnectSubmit} className="webssh-welcome-connect-form" data-testid="welcome-connect-form" aria-busy={isConnecting ? 'true' : undefined} noValidate>
            <div className="webssh-welcome-field">
              <label htmlFor="welcome-host-input">Host</label>
              <input id="welcome-host-input" type="text" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellcheck={false} className="ui-input webssh-welcome-mono" placeholder="server.example.com" value={connectHost} aria-invalid={fieldError('host') ? 'true' : undefined} aria-describedby={fieldError('host') ? 'welcome-host-error' : undefined} onInput={(e) => { setConnectHost((e.target as HTMLInputElement).value); setConnectErrorMsg(''); }} data-testid="welcome-host-input" />
              {fieldError('host') ? <p id="welcome-host-error" className="webssh-welcome-field-error" role="alert">{connectErrorMsg}</p> : null}
            </div>
            <div className="webssh-welcome-user-port-row">
              <div className="webssh-welcome-field">
                <label htmlFor="welcome-user-input">Username</label>
                <input id="welcome-user-input" type="text" autoComplete="username" autoCapitalize="off" autoCorrect="off" spellcheck={false} className="ui-input webssh-welcome-mono" placeholder="ubuntu" value={connectUser} aria-invalid={fieldError('user') ? 'true' : undefined} aria-describedby={fieldError('user') ? 'welcome-user-error' : undefined} onInput={(e) => { setConnectUser((e.target as HTMLInputElement).value); setConnectErrorMsg(''); }} data-testid="welcome-user-input" />
              </div>
              <div className="webssh-welcome-field">
                <label htmlFor="welcome-port-input">Port</label>
                <input id="welcome-port-input" type="number" min={1} max={65535} className="ui-input webssh-welcome-mono" value={connectPort} aria-invalid={fieldError('port') ? 'true' : undefined} aria-describedby={fieldError('port') ? 'welcome-port-error' : undefined} onInput={(e) => { setConnectPort((e.target as HTMLInputElement).value); if (fieldError('port')) setConnectErrorMsg(''); }} data-testid="welcome-port-input" />
              </div>
              {/* Row-level so a long message spans both columns instead of squeezing into the port column. */}
              {fieldError('user') ? <p id="welcome-user-error" className="webssh-welcome-field-error webssh-welcome-row-error" role="alert">{connectErrorMsg}</p> : null}
              {fieldError('port') ? <p id="welcome-port-error" className="webssh-welcome-field-error webssh-welcome-row-error" role="alert">{connectErrorMsg}</p> : null}
            </div>

            <div className="webssh-welcome-field">
              <label htmlFor="welcome-auth-method-select">Authentication</label>
              <select id="welcome-auth-method-select" className="ui-input" value={authMethod} onChange={(e) => { setAuthMethod((e.currentTarget as HTMLSelectElement).value as AuthMethod); setConnectErrorMsg(''); }} data-testid="welcome-auth-method-select">
                <option value="Password">Password</option>
                <option value="Private Key (.pem / id_rsa)">Private key</option>
                <option value="Argon2id Ed25519 Key">Browser key (generated)</option>
              </select>
            </div>

            {authMethod === 'Password' ? (
              <div className="webssh-welcome-field">
                <label htmlFor="welcome-password-input">Password</label>
                <input id="welcome-password-input" type="password" autoComplete="current-password" className="ui-input" placeholder="SSH password" value={connectPassword} aria-invalid={fieldError('password') ? 'true' : undefined} aria-describedby={fieldError('password') ? 'welcome-password-error' : undefined} onInput={(e) => { setConnectPassword((e.target as HTMLInputElement).value); if (fieldError('password')) setConnectErrorMsg(''); }} data-testid="welcome-password-input" />
                {fieldError('password') ? <p id="welcome-password-error" className="webssh-welcome-field-error" role="alert">{connectErrorMsg}</p> : null}
              </div>
            ) : null}

            {authMethod === 'Private Key (.pem / id_rsa)' ? (
              <div className="webssh-welcome-key-group">
                <div className="webssh-welcome-field">
                  <label htmlFor="welcome-key-file-input">Private key file</label>
                  <input id="welcome-key-file-input" type="file" accept=".pem,.key,.pub,*" onChange={(e) => void handlePrivateKeyFileUpload(e)} data-testid="private-key-file-input" className="webssh-welcome-key-file-input" />
                </div>
                <details className="webssh-welcome-paste">
                  <summary>Paste key instead</summary>
                  <textarea className="ui-input webssh-welcome-mono" rows={4} placeholder={KEY_PLACEHOLDER} aria-label="Private key content" spellcheck={false} value={uploadedKeyContent} onInput={(e) => { setUploadedKeyContent((e.target as HTMLTextAreaElement).value); setKeyPermissionMode('0400'); setConnectErrorMsg(''); }} data-testid="private-key-textarea" />
                </details>
                <div className="webssh-welcome-key-perms">
                  <select aria-label="Private key chmod" className="ui-select webssh-welcome-mono" value={keyPermissionMode} onChange={(e) => setKeyPermissionMode((e.currentTarget as HTMLSelectElement).value as KeyPermissionMode)} data-testid="private-key-chmod-select">
                    <option value="0400">chmod 0400</option>
                    <option value="0600">chmod 0600</option>
                    <option value="0644">chmod 0644</option>
                  </select>
                  <Button variant="default" testId="apply-key-chmod-400-btn" onClick={() => setKeyPermissionMode('0400')}>Set 400</Button>
                  <Badge tone={keyPermissionMode === '0644' ? 'danger' : 'success'} testId="private-key-chmod-badge">{keyPermissionMode === '0644' ? 'UNPROTECTED KEY (0644)' : `chmod ${keyPermissionMode} — Enforced`}</Badge>
                </div>
                <div className="webssh-welcome-field">
                  <label htmlFor="welcome-key-passphrase-input">Key passphrase</label>
                  <input id="welcome-key-passphrase-input" type="password" autoComplete="off" className="ui-input" placeholder="Leave blank if the key is not encrypted" value={keyPassphrase} onInput={(e) => setKeyPassphrase((e.target as HTMLInputElement).value)} data-testid="welcome-key-passphrase-input" />
                </div>
              </div>
            ) : null}

            {authMethod === 'Argon2id Ed25519 Key' ? (
              <div className="webssh-welcome-browser-key">
                <p className="webssh-welcome-hint">A key created in this browser. The private key cannot be exported and never leaves it; add the public key to the server's ~/.ssh/authorized_keys before you connect.</p>
                {browserKeyLine ? (
                  <div className="webssh-welcome-field webssh-welcome-key-generated">
                    <label htmlFor="welcome-browser-key-line">Public key</label>
                    <div className="webssh-welcome-key-line">
                      <input id="welcome-browser-key-line" type="text" readOnly className="ui-input webssh-welcome-mono" value={browserKeyLine} data-testid="welcome-browser-key-line" />
                      <Button variant="default" onClick={onCopyBrowserKey} testId="welcome-copy-browser-key-btn">{browserKeyCopied ? 'Copied' : 'Copy'}</Button>
                    </div>
                    <p className="webssh-welcome-hint webssh-welcome-mono" data-testid="welcome-browser-key-fingerprint">{browserKeyFingerprint}</p>
                  </div>
                ) : null}
                <Button variant="default" onClick={() => void handleGenerateKey()} testId="welcome-generate-key-btn">{browserKeyLine ? 'Generate a new key' : 'Generate browser key'}</Button>
                {fieldError('browserKey') ? <p id="welcome-browserKey-error" className="webssh-welcome-field-error" role="alert">{connectErrorMsg}</p> : null}
              </div>
            ) : null}

            {isRelay && turnstileSiteKey ? (
              <div data-testid="guest-challenge" className="webssh-welcome-guest-challenge">
                <p className="webssh-welcome-hint">Complete the human check, then connect. A short-lived ticket is issued for this host and port.</p>
                <div className="webssh-welcome-turnstile">
                  <TurnstileWidget siteKey={turnstileSiteKey} resetNonce={turnstileResetNonce} onToken={setTurnstileToken} />
                </div>
              </div>
            ) : null}

            {statusError ? (
              <div className="webssh-welcome-status" role="alert">
                <Badge tone="danger" testId="connect-error-badge">{keepModesWhole(statusError)}</Badge>
              </div>
            ) : null}
            {gatewayProbeStatus ? (
              <div className="webssh-welcome-status" role="status">
                <Badge tone={gatewayProbeStatus.ok ? 'success' : 'danger'} testId="gateway-probe-badge">{gatewayProbeStatus.message}</Badge>
              </div>
            ) : null}

            <div className="webssh-welcome-actions">
              <Button variant="primary" type="submit" testId="welcome-connect-submit-btn" disabled={isConnecting}>{isConnecting ? 'Connecting…' : 'Connect to server'}</Button>
              {isConnecting ? (
                <Button variant="default" type="button" onClick={() => onCancel?.()} testId="welcome-cancel-btn">Cancel</Button>
              ) : (
                <Button variant="default" type="button" onClick={() => onNavigate('hosts')} testId="welcome-saved-hosts-btn">Saved hosts</Button>
              )}
            </div>
          </form>
        </section>

        <section className="webssh-welcome-route" aria-labelledby="welcome-route-title" data-testid="welcome-route">
          <h2 id="welcome-route-title" className="webssh-welcome-route-title">How this connects</h2>
          <ol className="webssh-welcome-route-steps">
            <li className="webssh-welcome-route-step">
              <p className="webssh-welcome-route-name">This browser</p>
              <p className="webssh-welcome-route-note">{route.browser}</p>
            </li>
            <li className="webssh-welcome-route-step" data-testid="welcome-route-hop">
              <p className="webssh-welcome-route-name">
                {isRelay ? 'Relay' : 'Gateway'}{' '}
                {hopHost ? <span className="webssh-welcome-route-host">{hopHost}</span> : <span className="webssh-welcome-route-missing">not configured</span>}
              </p>
              <p className="webssh-welcome-route-note">{route.hop} Change it under <span className="webssh-welcome-nowrap">Settings → Administrator</span>.</p>
            </li>
            <li className="webssh-welcome-route-step">
              <p className="webssh-welcome-route-name">Your server</p>
              <p className={`webssh-welcome-route-host${targetHost ? '' : ' webssh-welcome-route-host--empty'}`} data-testid="welcome-route-target">{target}</p>
            </li>
          </ol>
        </section>
      </div>
    </div>
  );
}
