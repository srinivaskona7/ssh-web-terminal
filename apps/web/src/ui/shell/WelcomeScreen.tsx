import type { JSX } from 'preact';
import { Badge, Button, Card, Icon } from '@webssh/ui-kit';
import type { HostProfile } from '../../hosts';
import type { TransportBackendMode } from '../../transport';
import type { AuthMethod, KeyPermissionMode, PendingJump } from '../App';
import { ProfileCard } from '../ProfileCard';
import type { WorkspaceRemoteSession } from '../../session/adapters';
import { WelcomeDashboard, type WelcomeDashboardProps } from '../WelcomeDashboard';
import { TurnstileWidget } from './TurnstileWidget';
import type { Setter } from './types';

/** Quick Connect form state; the connect modal edits the same values. */
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
  connectErrorMsg: string;
  setConnectErrorMsg: Setter<string>;
  handleConnectSubmit: (e?: Event) => void;
  handlePrivateKeyFileUpload: (e: Event) => Promise<void>;
  handleGenerateKey: () => Promise<void>;
}

export interface GatewayProbeStatus {
  ok: boolean;
  message: string;
}

/** Administrator transport settings: backend, endpoint and gateway token. */
export interface WelcomeTransport {
  transportMode: TransportBackendMode;
  setTransportMode: Setter<TransportBackendMode>;
  gatewayUrl: string;
  setGatewayUrl: Setter<string>;
  gatewayAuthToken: string;
  setGatewayAuthToken: Setter<string>;
  gatewayProbeStatus: GatewayProbeStatus | null;
  setGatewayProbeStatus: Setter<GatewayProbeStatus | null>;
  handleTestGateway: (rawUrl?: string) => Promise<void>;
}

/** Optional administrator account sign-in. */
export interface WelcomeAccount {
  relaySessionUser: string;
  relayLoginUser: string;
  setRelayLoginUser: Setter<string>;
  relayLoginPass: string;
  setRelayLoginPass: Setter<string>;
  handleRelayLogin: () => Promise<void>;
  handleRelaySignOut: () => void;
}

/** Guest human check, shown on the relay when a Turnstile site key is configured. */
export interface WelcomeGuest {
  turnstileSiteKey: string;
  turnstileResetNonce: number;
  setTurnstileToken: Setter<string>;
}

export interface WelcomeScreenProps {
  /** A recent host prefills the form and opens the connect modal with its jump hops. */
  recentHosts: HostProfile[];
  setPendingJump: Setter<PendingJump | null>;
  setConnectModalOpen: Setter<boolean>;
  quickConnect: WelcomeQuickConnect;
  transport: WelcomeTransport;
  account: WelcomeAccount;
  guest: WelcomeGuest;
  /** The connected session, if any; drives the live Kubernetes tiles. */
  session: WorkspaceRemoteSession | null;
  onNavigate: WelcomeDashboardProps['onNavigate'];
}

/**
 * Welcome: recent hosts and Quick Connect. App owns every value, so what the
 * user typed survives leaving the screen and coming back.
 */
export function WelcomeScreen({
  recentHosts,
  setPendingJump,
  setConnectModalOpen,
  quickConnect,
  transport,
  account,
  guest,
  session,
  onNavigate
}: WelcomeScreenProps): JSX.Element {
  const {
    connectHost,
    setConnectHost,
    connectUser,
    setConnectUser,
    connectPort,
    setConnectPort,
    authMethod,
    setAuthMethod,
    connectPassword,
    setConnectPassword,
    keyPermissionMode,
    setKeyPermissionMode,
    uploadedKeyContent,
    setUploadedKeyContent,
    connectErrorMsg,
    setConnectErrorMsg,
    handleConnectSubmit,
    handlePrivateKeyFileUpload,
    handleGenerateKey
  } = quickConnect;
  const {
    transportMode,
    setTransportMode,
    gatewayUrl,
    setGatewayUrl,
    gatewayAuthToken,
    setGatewayAuthToken,
    gatewayProbeStatus,
    setGatewayProbeStatus,
    handleTestGateway
  } = transport;
  const {
    relaySessionUser,
    relayLoginUser,
    setRelayLoginUser,
    relayLoginPass,
    setRelayLoginPass,
    handleRelayLogin,
    handleRelaySignOut
  } = account;
  const { turnstileSiteKey, turnstileResetNonce, setTurnstileToken } = guest;

  return (
    <div className="webssh-panel-content webssh-welcome" data-testid="screen-welcome">
      <div className="webssh-aurora" aria-hidden="true" />
      <div className="webssh-welcome-hero">
        <div className="webssh-welcome-copy">
          <span className="webssh-welcome-eyebrow">Browser SSH workspace</span>
          <h1>Welcome to WebSSH Studio</h1>
          <p style={{ color: 'var(--color-fg-secondary)' }}>
            Clean, minimal SSH workspace — connect with Username & Password or upload a Private Key (<code>chmod 0400</code>).
          </p>
        </div>
        <ProfileCard />
      </div>
      {recentHosts.length > 0 ? (
        <Card testId="welcome-recent-hosts">
          <h2>Recent hosts</h2>
          <div className="webssh-recent-hosts">
            {recentHosts.map((h) => (
              <Button
                key={h.id}
                variant="ghost"
                testId={`recent-host-${h.alias}`}
                onClick={() => {
                  setConnectUser(h.user);
                  setConnectHost(h.host);
                  setConnectPort(String(h.port));
                  setPendingJump({
                    targetHost: h.host,
                    targetPort: h.port,
                    hops: h.jumpHops.map((j) => ({ host: j.host, port: j.port, user: j.user }))
                  });
                  setConnectModalOpen(true);
                }}
              >
                <Icon name="terminal" /> {h.alias} · {h.user}@{h.host}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}

      <Card testId="welcome-quick-connect-card">
        <h2>Quick SSH Connect</h2>
        <form
          onSubmit={handleConnectSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
        >
          {transportMode === 'cloudflare-relay' && turnstileSiteKey ? (
            <div data-testid="guest-challenge">
              <p className="ws-mod-muted" style={{ margin: 0 }}>
                No account needed: complete the human check, then connect. A short-lived
                ticket is issued for this host and port only.
              </p>
              <TurnstileWidget
                siteKey={turnstileSiteKey}
                resetNonce={turnstileResetNonce}
                onToken={setTurnstileToken}
              />
            </div>
          ) : null}
          {relaySessionUser ? (
            <Badge tone="success" testId="product-signed-in">
              Signed in as {relaySessionUser}
            </Badge>
          ) : null}
          <details data-testid="admin-transport-settings">
            <summary>Administrator settings</summary>
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}
            >
              <div data-testid="admin-sign-in">
                <h4>Account sign-in (optional)</h4>
                <p className="ws-mod-muted" style={{ margin: 0 }}>
                  Accounts are for administrators. Guest connections use the human check
                  and need no account.
                </p>
                {relaySessionUser ? (
                  <div
                    style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}
                    data-testid="product-signed-in-actions"
                  >
                    <Badge tone="success">Signed in as {relaySessionUser}</Badge>
                    <Button
                      variant="ghost"
                      type="button"
                      testId="product-sign-out-btn"
                      onClick={() => handleRelaySignOut()}
                    >
                      Sign out
                    </Button>
                  </div>
                ) : (
                  <div
                    style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end' }}
                    data-testid="product-sign-in"
                  >
                    <div style={{ flex: 1, minWidth: '160px' }}>
                      <label htmlFor="product-sign-in-user">Username</label>
                      <input
                        id="product-sign-in-user"
                        type="text"
                        autoComplete="username"
                        className="ui-input"
                        placeholder="Your account"
                        value={relayLoginUser}
                        onInput={(e) => setRelayLoginUser((e.target as HTMLInputElement).value)}
                        data-testid="product-sign-in-user"
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: '160px' }}>
                      <label htmlFor="product-sign-in-pass">Password</label>
                      <input
                        id="product-sign-in-pass"
                        type="password"
                        autoComplete="current-password"
                        className="ui-input"
                        placeholder="Account password"
                        value={relayLoginPass}
                        onInput={(e) => setRelayLoginPass((e.target as HTMLInputElement).value)}
                        data-testid="product-sign-in-pass"
                      />
                    </div>
                    <Button
                      variant="default"
                      type="button"
                      testId="product-sign-in-submit"
                      onClick={() => void handleRelayLogin()}
                    >
                      Sign in
                    </Button>
                  </div>
                )}
              </div>
              <div>
                <label htmlFor="welcome-transport-mode-select">SSH Transport Mode</label>
                <select
                  id="welcome-transport-mode-select"
                  className="ui-input"
                  value={transportMode}
                  onChange={(e) => {
                    const mode = (e.target as HTMLSelectElement).value as TransportBackendMode;
                    setTransportMode(mode);
                    try {
                      globalThis.localStorage?.setItem('webssh.transport.mode', mode);
                    } catch {
                      // ignore
                    }
                  }}
                  data-testid="welcome-transport-mode-select"
                >
                  <option value="go-gateway">
                    Go SSH/SFTP Gateway (Full PTY + SFTP + Editor + Tunnels + 4 MiB Resume)
                  </option>
                  <option value="cloudflare-relay">
                    Cloudflare Worker SSH Relay (Browser SSH-2.0 over cloudflare:sockets — Zero Target Agent)
                  </option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: 2, minWidth: '220px' }}>
                  <label htmlFor="welcome-gateway-url-input">
                    {transportMode === 'cloudflare-relay'
                      ? 'Cloudflare Worker Relay Endpoint (wss://<worker>.workers.dev/ws)'
                      : 'SSH Gateway WebSocket Endpoint (WSS / WS)'}
                  </label>
                  <input
                    id="welcome-gateway-url-input"
                    type="text"
                    className="ui-input"
                    placeholder="wss://ssh-gateway.yourdomain.com/ws or ws://127.0.0.1:8080/ws"
                    value={gatewayUrl}
                    onInput={(e) => {
                      const val = (e.target as HTMLInputElement).value;
                      setGatewayUrl(val);
                      setGatewayProbeStatus(null);
                      try {
                        globalThis.localStorage?.setItem('webssh.gateway.wsUrl', val);
                      } catch {
                        // ignore
                      }
                    }}
                    data-testid="welcome-gateway-url-input"
                  />
                </div>
                <div style={{ flex: 1, minWidth: '160px' }}>
                  <label htmlFor="welcome-gateway-token-input">Gateway Auth Token (Optional)</label>
                  <input
                    id="welcome-gateway-token-input"
                    type="password"
                    className="ui-input"
                    placeholder="Bearer / EC2 gateway token"
                    value={gatewayAuthToken}
                    onInput={(e) => {
                      const val = (e.target as HTMLInputElement).value;
                      setGatewayAuthToken(val);
                      try {
                        globalThis.sessionStorage?.setItem('webssh.gateway.authToken', val);
                      } catch {
                        // ignore
                      }
                    }}
                    data-testid="welcome-gateway-token-input"
                  />
                </div>
                <Button
                  variant="default"
                  type="button"
                  testId="test-gateway-btn"
                  onClick={() => void handleTestGateway(gatewayUrl)}
                >
                  Test Gateway
                </Button>
              </div>
            </div>
          </details>
          {gatewayProbeStatus ? (
            <Badge
              tone={gatewayProbeStatus.ok ? 'success' : 'danger'}
              testId="gateway-probe-badge"
            >
              {gatewayProbeStatus.message}
            </Badge>
          ) : null}
          <div className="webssh-quick-connect-row">
            <div>
              <label htmlFor="welcome-host-input">Host / IP</label>
              <input
                id="welcome-host-input"
                type="text"
                className="ui-input"
                placeholder="e.g. 192.168.1.10 or server.example.com"
                value={connectHost}
                onInput={(e) => setConnectHost((e.target as HTMLInputElement).value)}
                data-testid="welcome-host-input"
              />
            </div>
            <div>
              <label htmlFor="welcome-user-input">Username</label>
              <input
                id="welcome-user-input"
                type="text"
                className="ui-input"
                placeholder="ubuntu / root"
                value={connectUser}
                onInput={(e) => setConnectUser((e.target as HTMLInputElement).value)}
                data-testid="welcome-user-input"
              />
            </div>
            <div>
              <label htmlFor="welcome-port-input">Port</label>
              <input
                id="welcome-port-input"
                type="number"
                className="ui-input"
                value={connectPort}
                onInput={(e) => setConnectPort((e.target as HTMLInputElement).value)}
                data-testid="welcome-port-input"
              />
            </div>
          </div>

          <div>
            <label>Authentication Method</label>
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-1)', flexWrap: 'wrap' }}>
              <Button
                variant={authMethod === 'Password' ? 'primary' : 'default'}
                onClick={() => {
                  setAuthMethod('Password');
                  setConnectErrorMsg('');
                }}
                testId="welcome-auth-password-btn"
              >
                Username & Password
              </Button>
              <Button
                variant={authMethod === 'Private Key (.pem / id_rsa)' ? 'primary' : 'default'}
                onClick={() => {
                  setAuthMethod('Private Key (.pem / id_rsa)');
                  setConnectErrorMsg('');
                }}
                testId="welcome-auth-keyfile-btn"
              >
                Upload Private Key (.pem / chmod 400)
              </Button>
              <Button
                variant={authMethod === 'Argon2id Ed25519 Key' ? 'primary' : 'default'}
                onClick={() => {
                  setAuthMethod('Argon2id Ed25519 Key');
                  setConnectErrorMsg('');
                }}
                testId="welcome-auth-argon-btn"
              >
                Browser Ed25519 Key
              </Button>
            </div>
          </div>

          {authMethod === 'Password' ? (
            <div>
              <label htmlFor="welcome-password-input">Password</label>
              <input
                id="welcome-password-input"
                type="password"
                className="ui-input"
                placeholder="Enter SSH password…"
                value={connectPassword}
                onInput={(e) => setConnectPassword((e.target as HTMLInputElement).value)}
                data-testid="welcome-password-input"
              />
            </div>
          ) : null}

          {authMethod === 'Private Key (.pem / id_rsa)' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                <label htmlFor="welcome-key-file-input">
                  Upload Private Key (<code>.pem</code>, <code>.key</code>, <code>id_ed25519</code>, <code>id_rsa</code>)
                </label>
                <Badge
                  tone={keyPermissionMode === '0644' ? 'danger' : 'success'}
                  testId="private-key-chmod-badge"
                >
                  {keyPermissionMode === '0400'
                    ? 'chmod 0400 (-r--------) Enforced'
                    : keyPermissionMode === '0600'
                      ? 'chmod 0600 (-rw-------) Enforced'
                      : 'UNPROTECTED KEY (0644) — Set chmod 400'}
                </Badge>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  id="welcome-key-file-input"
                  type="file"
                  className="ui-input"
                  accept=".pem,.key,.pub,*"
                  onChange={(e) => void handlePrivateKeyFileUpload(e)}
                  data-testid="private-key-file-input"
                  style={{ flex: 1 }}
                />
                <select
                  aria-label="Private key chmod permission"
                  className="ui-select"
                  value={keyPermissionMode}
                  onChange={(e) => {
                    setKeyPermissionMode((e.currentTarget as HTMLSelectElement).value as KeyPermissionMode);
                    setConnectErrorMsg('');
                  }}
                  data-testid="private-key-chmod-select"
                  style={{ width: 'auto' }}
                >
                  <option value="0400">chmod 0400 (-r--------) Read-Only</option>
                  <option value="0600">chmod 0600 (-rw-------) Owner R/W</option>
                  <option value="0644">chmod 0644 (-rw-r--r--) Too Open</option>
                </select>
                <Button
                  variant="default"
                  testId="apply-key-chmod-400-btn"
                  onClick={() => {
                    setKeyPermissionMode('0400');
                    setConnectErrorMsg('');
                  }}
                >
                  Set chmod 400
                </Button>
              </div>
              <textarea
                className="ui-input"
                rows={3}
                placeholder="Or paste -----BEGIN OPENSSH PRIVATE KEY----- / .pem content here…"
                aria-label="Private key content"
                value={uploadedKeyContent}
                onInput={(e) => setUploadedKeyContent((e.target as HTMLTextAreaElement).value)}
                data-testid="private-key-textarea"
              />
            </div>
          ) : null}

          {connectErrorMsg ? (
            <Badge tone="danger" testId="connect-error-badge">
              {connectErrorMsg}
            </Badge>
          ) : null}

          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <Button variant="primary" type="submit" testId="welcome-connect-submit-btn">
              Connect to Server
            </Button>
            <Button
              variant="default"
              onClick={() => void handleGenerateKey()}
              testId="welcome-generate-key-btn"
            >
              Generate SSH key
            </Button>
          </div>
        </form>
      </Card>
      <WelcomeDashboard session={session} onNavigate={onNavigate} />
    </div>
  );
}
