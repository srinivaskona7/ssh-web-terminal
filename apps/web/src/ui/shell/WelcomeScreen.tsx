import type { JSX } from 'preact';
import { Badge, Button, Card, Icon } from '@webssh/ui-kit';
import type { HostProfile } from '../../hosts';
import type { TransportBackendMode } from '../../transport';
import type { AuthMethod, KeyPermissionMode, PendingJump } from '../App';
import type { WorkspaceRemoteSession } from '../../session/adapters';
import { WelcomeDashboard, type WelcomeDashboardProps } from '../WelcomeDashboard';
import { TurnstileWidget } from './TurnstileWidget';
import type { Setter } from './types';

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
  onNavigate: WelcomeDashboardProps['onNavigate'];
}

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

      {/* 1. Quick Connect — above the fold */}
      <div className="webssh-welcome-quick-connect">
        <h2 className="webssh-welcome-heading">Connect to a server.</h2>
        <p className="webssh-welcome-subheading">
          Enter the host, username, and authentication method. Recent hosts appear below.
        </p>

        {transportMode === 'cloudflare-relay' && turnstileSiteKey ? (
          <div data-testid="guest-challenge" className="webssh-welcome-guest-challenge">
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

        <form
          onSubmit={handleConnectSubmit}
          className="webssh-welcome-connect-form"
          data-testid="welcome-connect-form"
        >
          <div className="webssh-welcome-field-row">
            <div className="webssh-welcome-field">
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
            <div className="webssh-welcome-field">
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
            <div className="webssh-welcome-field">
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

          <div className="webssh-welcome-field">
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
                Upload Private Key
              </Button>
              <Button
                variant={authMethod === 'Argon2id Ed25519 Key' ? 'primary' : 'default'}
                onClick={() => {
                  setAuthMethod('Argon2id Ed25519 Key');
                  setConnectErrorMsg('');
                }}
                testId="welcome-auth-argon-btn"
              >
                Browser Key
              </Button>
            </div>
          </div>

          {authMethod === 'Password' ? (
            <div className="webssh-welcome-field">
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
            <div className="webssh-welcome-field" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                <label htmlFor="welcome-key-file-input">
                  Upload Private Key (.pem, .key, id_ed25519, id_rsa)
                </label>
                <Badge
                  tone={keyPermissionMode === '0644' ? 'danger' : 'success'}
                  testId="private-key-chmod-badge"
                >
                  {keyPermissionMode === '0400'
                    ? 'chmod 0400 — Enforced'
                    : keyPermissionMode === '0600'
                      ? 'chmod 0600 — Enforced'
                      : 'UNPROTECTED KEY (0644)'}
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
                  <option value="0400">chmod 0400 — Read-Only</option>
                  <option value="0600">chmod 0600 — Owner R/W</option>
                  <option value="0644">chmod 0644 — Too Open</option>
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
                placeholder="Or paste -----BEGIN OPENSSH PRIVATE KEY----- content here…"
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

          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-3)' }}>
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
      </div>

      {/* 2. Recent hosts */}
      {recentHosts.length > 0 ? (
        <Card testId="welcome-recent-hosts" className="webssh-welcome-recent-card">
          <h2 className="webssh-welcome-section-title">Recent hosts</h2>
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

      {/* 3. Administrator transport settings — collapsed, plain explanations */}
      <details className="webssh-welcome-admin-settings" data-testid="admin-transport-settings">
        <summary>Administrator settings</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
          {relaySessionUser ? (
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
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
                Cloudflare Worker SSH Relay (Terminal, tabs, splits; no SFTP/Editor)
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
          {gatewayProbeStatus ? (
            <Badge
              tone={gatewayProbeStatus.ok ? 'success' : 'danger'}
              testId="gateway-probe-badge"
            >
              {gatewayProbeStatus.message}
            </Badge>
          ) : null}
        </div>
      </details>

      <WelcomeDashboard session={session} onNavigate={onNavigate} />
    </div>
  );
}
