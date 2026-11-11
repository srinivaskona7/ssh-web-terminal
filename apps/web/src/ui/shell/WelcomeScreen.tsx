import type { JSX } from 'preact';
import { Badge, Button } from '@webssh/ui-kit';
import type { HostProfile } from '../../hosts';
import type { TransportBackendMode } from '../../transport';
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

export function WelcomeScreen(props: WelcomeScreenProps): JSX.Element {
  const { quickConnect, transport, guest, onNavigate } = props;
  const {
    connectHost, setConnectHost, connectUser, setConnectUser, connectPort, setConnectPort,
    authMethod, setAuthMethod, connectPassword, setConnectPassword,
    keyPermissionMode, setKeyPermissionMode, uploadedKeyContent, setUploadedKeyContent,
    keyPassphrase, setKeyPassphrase,
    connectErrorMsg, setConnectErrorMsg, handleConnectSubmit,
    handlePrivateKeyFileUpload, handleGenerateKey, isConnecting, onCancel,
  } = quickConnect;
  const { transportMode, gatewayProbeStatus } = transport;
  const { turnstileSiteKey, turnstileResetNonce, setTurnstileToken } = guest;

  const fieldError = (part: string): string | null =>
    connectErrorMsg && connectErrorMsg.toLowerCase().includes(part) ? connectErrorMsg : null;

  return (
    <div className="webssh-panel-content webssh-welcome webssh-welcome-container" data-testid="screen-welcome">
      <div className="webssh-landing webssh-welcome-landing" data-testid="welcome-quick-connect-card">
        <section aria-label="Introduction">
          <h1 className="webssh-welcome-heading webssh-welcome-heading">Open your server workspace</h1>
          <p className="webssh-welcome-subheading">Connect over SSH and open a terminal, files, and tools — keys stay in your browser.</p>
        </section>
        <div className="webssh-welcome-connect-card webssh-welcome-new-connection">
          <h2>New connection</h2>
          <form onSubmit={handleConnectSubmit} className="webssh-welcome-connect-form" data-testid="welcome-connect-form" noValidate>
            <div className="webssh-welcome-field">
              <label htmlFor="welcome-host-input">Host</label>
              <input id="welcome-host-input" type="text" autoComplete="off" className="ui-input" placeholder="server.example.com or 203.0.113.10" value={connectHost} aria-invalid={fieldError('host') ? 'true' : undefined} onInput={(e) => { setConnectHost((e.target as HTMLInputElement).value); setConnectErrorMsg(''); }} data-testid="welcome-host-input" />
              {fieldError('host') ? <p role="alert">{connectErrorMsg}</p> : null}
            </div>
            <div className="webssh-welcome-user-port-row">
              <div className="webssh-welcome-field">
                <label htmlFor="welcome-user-input">Username</label>
                <input id="welcome-user-input" type="text" autoComplete="username" className="ui-input" placeholder="ubuntu" value={connectUser} aria-invalid={fieldError('user') ? 'true' : undefined} onInput={(e) => { setConnectUser((e.target as HTMLInputElement).value); setConnectErrorMsg(''); }} data-testid="welcome-user-input" />
              </div>
              <div className="webssh-welcome-field">
                <label htmlFor="welcome-port-input">Port</label>
                <input id="welcome-port-input" type="number" min={1} max={65535} className="ui-input" value={connectPort} onInput={(e) => setConnectPort((e.target as HTMLInputElement).value)} data-testid="welcome-port-input" />
              </div>
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
                <input id="welcome-password-input" type="password" autoComplete="current-password" className="ui-input" placeholder="SSH password" value={connectPassword} onInput={(e) => setConnectPassword((e.target as HTMLInputElement).value)} data-testid="welcome-password-input" />
              </div>
            ) : null}

            {authMethod === 'Private Key (.pem / id_rsa)' ? (
              <div className="webssh-welcome-field webssh-welcome-key-field">
                <label htmlFor="welcome-key-file-input">Private key</label>
                <div className="webssh-welcome-key-row">
                  <input id="welcome-key-file-input" type="file" accept=".pem,.key,.pub,*" onChange={(e) => void handlePrivateKeyFileUpload(e)} data-testid="private-key-file-input" className="webssh-welcome-key-file-input" />
                  <Badge tone={keyPermissionMode === '0644' ? 'danger' : 'success'} testId="private-key-chmod-badge">{keyPermissionMode === '0644' ? 'UNPROTECTED KEY (0644)' : `chmod ${keyPermissionMode} — Enforced`}</Badge>
                  <select aria-label="Private key chmod" className="ui-select" value={keyPermissionMode} onChange={(e) => setKeyPermissionMode((e.currentTarget as HTMLSelectElement).value as KeyPermissionMode)} data-testid="private-key-chmod-select">
                    <option value="0400">chmod 0400</option>
                    <option value="0600">chmod 0600</option>
                    <option value="0644">chmod 0644</option>
                  </select>
                  <Button variant="default" testId="apply-key-chmod-400-btn" onClick={() => setKeyPermissionMode('0400')}>Set 400</Button>
                </div>
                <details>
                  <summary>Paste key instead</summary>
                  <textarea className="ui-input" rows={3} placeholder="Paste -----BEGIN OPENSSH PRIVATE KEY----- content" aria-label="Private key content" value={uploadedKeyContent} onInput={(e) => { setUploadedKeyContent((e.target as HTMLTextAreaElement).value); setKeyPermissionMode('0400'); setConnectErrorMsg(''); }} data-testid="private-key-textarea" />
                </details>
                <input id="welcome-key-passphrase-input" type="password" autoComplete="off" className="ui-input webssh-welcome-passphrase" placeholder="Key passphrase (leave blank if unencrypted)" value={keyPassphrase} onInput={(e) => setKeyPassphrase((e.target as HTMLInputElement).value)} data-testid="welcome-key-passphrase-input" />
              </div>
            ) : null}

            {authMethod === 'Argon2id Ed25519 Key' ? (
              <div className="webssh-welcome-field">
                <p className="ws-mod-muted">Browser-held Ed25519 key (Argon2id-wrapped, never leaves the browser).</p>
                <Button variant="default" onClick={() => void handleGenerateKey()} testId="welcome-generate-key-btn">Generate or select Browser Key</Button>
              </div>
            ) : null}

            <div className="webssh-welcome-challenge-spacer" aria-live="polite">
              {transportMode === 'cloudflare-relay' && turnstileSiteKey ? (
                <div data-testid="guest-challenge" className="webssh-welcome-guest-challenge">
                  <p className="ws-mod-muted webssh-welcome-challenge-text">Complete the human check, then connect. A short-lived ticket is issued for this host and port.</p>
                  <TurnstileWidget siteKey={turnstileSiteKey} resetNonce={turnstileResetNonce} onToken={setTurnstileToken} />
                </div>
              ) : (
                <p className="ws-mod-muted webssh-welcome-challenge-text webssh-welcome-challenge-placeholder">Human check placeholder — keeps layout stable.</p>
              )}
            </div>

            {connectErrorMsg && !(fieldError('host') || fieldError('user')) ? <Badge tone="danger" testId="connect-error-badge">{connectErrorMsg}</Badge> : null}
            {gatewayProbeStatus ? <Badge tone={gatewayProbeStatus.ok ? 'success' : 'danger'} testId="gateway-probe-badge">{gatewayProbeStatus.message}</Badge> : null}

            <div className="webssh-welcome-actions-column">
              <div className="webssh-welcome-submit-wrapper"><Button variant="primary" type="submit" testId="welcome-connect-submit-btn" disabled={isConnecting}>Connect to server</Button></div>
              {isConnecting ? <Button variant="ghost" type="button" onClick={() => onCancel?.()} testId="welcome-cancel-btn">Cancel</Button> : null}
              <div className="webssh-welcome-saved-hosts-row">
                <Button variant="ghost" type="button" onClick={() => onNavigate('hosts')} testId="welcome-saved-hosts-btn">Saved Hosts</Button>
              </div>
            </div>
            <p className="ws-mod-muted webssh-welcome-footer-note">Relay and gateway configuration lives under Settings → Administrator.</p>
          </form>
        </div>
      </div>
    </div>
  );
}
