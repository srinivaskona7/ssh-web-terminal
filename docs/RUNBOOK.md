# WebSSH Studio — Operations & EC2 Deployment Runbook

## 1. Environment Variables (`apps/gateway`)

| Variable | Default | Description |
|---|---|---|
| `LISTEN_ADDR` | `:8080` | TCP address and port for the HTTP/WebSocket server |
| `ALLOWED_ORIGINS` | `*` (dev) | Comma-separated allowed browser `Origin` headers (e.g. `https://srinivaskona7.github.io`) |
| `GATEWAY_AUTH_TOKEN` | *(empty — dev mode)* | Shared bearer/query/control token required for authenticated WSS connections |
| `REQUIRE_TLS` | `false` | When `1`/`true`, rejects `/ws` unless TLS is active or `X-Forwarded-Proto: https` is set |
| `TLS_CERT_FILE` | *(empty)* | Path to TLS X.509 fullchain PEM for native `wss://` termination (TLS 1.2+) |
| `TLS_KEY_FILE` | *(empty)* | Path to TLS private key PEM for native `wss://` termination |
| `OIDC_ISSUER` | *(empty)* | OIDC issuer URL (when set, verifies Bearer/query JWT) |
| `OIDC_CLIENT_ID` | *(empty)* | Expected OIDC audience (`aud`) claim |
| `DEST_ALLOWLIST` | RFC1918 + loopback | Comma-separated CIDRs/hosts permitted by destination guard |
| `DEST_DENYLIST` | *(empty)* | Additional comma-separated CIDRs to block (cloud metadata `169.254.169.254/32` is always blocked) |
| `SESSION_GRACE` | `15m` | Duration to keep detached sessions alive for browser resume |
| `RING_BUFFER_BYTES` | `4194304` (4 MiB) | Per-session output replay ring buffer size |
| `MAX_SESSIONS_PER_USER` | `10` | Maximum concurrent SSH sessions per authenticated user |
| `RATE_LIMITS` | `100` | Token-bucket connection rate limit per client IP |

---

## 2. Step-by-Step EC2 Production Deployment (Valid TLS + Authenticated WSS + Restricted Origins)

Because GitHub Pages (`https://srinivaskona7.github.io/ssh-web-terminal/`) is a static file CDN, it cannot terminate WebSocket-to-SSH connections itself. Deploy `apps/gateway` on an AWS EC2 instance (e.g., `t4g.small` or `t3.small` running Ubuntu 24.04 LTS) with a DNS A-record pointing to the EC2 Elastic IP.

### Step 2.1 — EC2 Security Group & DNS Prerequisite
1. Allocate an AWS Elastic IP and associate it with your EC2 instance.
2. Create a DNS `A` record (e.g., `ssh-gateway.yourdomain.com` → `<EC2-Elastic-IP>`).
3. Configure the EC2 Security Group:
   - **Inbound TCP 443**: `0.0.0.0/0` (HTTPS / `wss://` for browser clients)
   - **Inbound TCP 80**: `0.0.0.0/0` (ACME HTTP-01 Let's Encrypt certificate challenge)
   - **Inbound TCP 22**: Restricted to admin IP CIDR
   - **Outbound TCP 22**: Permitted to target SSH hosts (`10.0.0.0/8`, VPC subnets, or public servers)

### Step 2.2 — Build & Install the Gateway Binary on EC2
```bash
# On EC2 (Ubuntu 24.04 LTS)
sudo useradd --system --no-create-home --shell /usr/sbin/nologin webssh || true
sudo mkdir -p /etc/webssh-gateway

# Build static Linux binary from repository root
cd apps/gateway
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o webssh-gateway ./cmd/gateway
sudo install -m 0755 webssh-gateway /usr/local/bin/webssh-gateway
```

### Step 2.3 — Configure Restricted Origins, TLS Requirement & Gateway Auth Token
Create `/etc/webssh-gateway/gateway.env` (mode `0600`, owned by `webssh:webssh`):
```bash
sudo tee /etc/webssh-gateway/gateway.env >/dev/null <<'EOF'
LISTEN_ADDR=127.0.0.1:8080
REQUIRE_TLS=1
ALLOWED_ORIGINS=https://srinivaskona7.github.io
GATEWAY_AUTH_TOKEN=your-strong-32-byte-secret-token
DEST_ALLOWLIST=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1/32
DEST_DENYLIST=169.254.169.254/32
SESSION_GRACE=15m
RING_BUFFER_BYTES=4194304
MAX_SESSIONS_PER_USER=10
RATE_LIMITS=30
EOF
sudo chown webssh:webssh /etc/webssh-gateway/gateway.env
sudo chmod 0600 /etc/webssh-gateway/gateway.env
```

*(Alternative Native TLS without Reverse Proxy)*: Set `LISTEN_ADDR=:443`, `TLS_CERT_FILE=/etc/letsencrypt/live/ssh-gateway.yourdomain.com/fullchain.pem`, and `TLS_KEY_FILE=/etc/letsencrypt/live/ssh-gateway.yourdomain.com/privkey.pem`.

### Step 2.4 — Enable the `systemd` Service & Caddy TLS Reverse Proxy
```bash
sudo cp deploy/ec2/systemd/webssh-gateway.service /etc/systemd/system/webssh-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now webssh-gateway

# Install Caddy for automatic Let's Encrypt TLS 1.3 + WSS termination
sudo apt-get update && sudo apt-get install -y caddy
sudo cp deploy/ec2/Caddyfile /etc/caddy/Caddyfile
# Edit /etc/caddy/Caddyfile to set your domain name, then reload:
sudo systemctl reload caddy
```

### Step 2.5 — Verify EC2 Gateway Health, Origin Restriction & Auth Token
```bash
# 1. Verify /healthz over HTTPS
curl -i https://ssh-gateway.yourdomain.com/healthz
# Expected: HTTP/2 200 {"status":"ok","activeSessions":0,"tlsEnabled":true,"authRequired":true}

# 2. Verify unauthorized origin is blocked (403 Forbidden)
curl -i -H "Origin: https://evil.example.com" https://ssh-gateway.yourdomain.com/ws

# 3. Verify missing token is blocked (401 Unauthorized)
curl -i -H "Origin: https://srinivaskona7.github.io" https://ssh-gateway.yourdomain.com/ws
```

### Step 2.6 — Connect WebSSH Studio Frontend to the EC2 Gateway
1. **Runtime UI Configuration**: Open `https://srinivaskona7.github.io/ssh-web-terminal/`, enter `wss://ssh-gateway.yourdomain.com/ws` in **SSH Gateway WebSocket URL**, enter your **Gateway Auth Token**, and click **Test Gateway** (or pass `?gateway=wss://ssh-gateway.yourdomain.com/ws`).
2. **Build-Time GitHub Actions Variable**: In GitHub repo **Settings → Secrets and variables → Actions → Variables**, set `GATEWAY_URL` = `wss://ssh-gateway.yourdomain.com/ws` so `.github/workflows/pages.yml` bakes the default endpoint into the bundle.

---

## 3. Health & Metrics Endpoints
- `GET /healthz`: Returns `200 OK` with `{"status":"ok","activeSessions":N,"tlsEnabled":bool,"authRequired":bool}`.
- `GET /metrics`: Prometheus-compatible text metrics (`webssh_gateway_active_sessions`, `webssh_gateway_audit_events_total`).

---

## 4. Cloudflare Worker SSH Relay (`apps/relay`) — GitHub Pages → Cloudflare Worker → SSH Servers

When you want to connect from the static **GitHub Pages** frontend (`https://srinivaskona7.github.io/ssh-web-terminal/`) to remote SSH servers **without installing `apps/gateway` on each target server**, select **`Cloudflare Worker SSH Relay`** in the Transport Mode dropdown.

In this mode:
- **Browser (`apps/web/src/transport/browser-ssh-client.ts`)** executes the full RFC 4251–4254 SSH-2.0 protocol (`ecdh-sha2-nistp256` key exchange, `ssh-ed25519` / `ecdsa-sha2-nistp256` / `rsa-sha2-256` host-key verification with TOFU pinning, `aes128-ctr` + `hmac-sha2-256` encryption, password / PEM private key / WebCrypto KeyVault authentication, and multiplexed PTY & `exec` channels). **Private keys never leave the browser.**
- **Cloudflare Worker (`apps/relay`)** authenticates the WebSocket request using a short-lived relay session JWT and strict Origin checks, enforces `DESTINATION_MODE` and `ALLOWED_SSH_PORTS` with an SSRF guard, verifies the remote server's `SSH-2.0-` banner, and bridges encrypted SSH packets over `cloudflare:sockets` `connect()`.

### 4.1 Exact Cloudflare Workers Builds (Git Integration) Settings

Configure in **Cloudflare Dashboard → Compute (Workers) → Create Application → Connect to Git (`srinivaskona7/ssh-web-terminal`)**:

| Setting | Exact Value |
|---|---|
| **Project / Worker Name** | `webssh-studio-relay` |
| **Production Branch** | `main` |
| **Root Directory** | `apps/relay` |
| **Build Command** | `npm ci --include=dev && npm run build` |
| **Deploy Command** | `npx wrangler deploy` |

### 4.2 Required Cloudflare Worker Secrets, Variables & Durable Object Bindings

In **Cloudflare Dashboard → Workers & Pages → `webssh-studio-relay` → Settings → Variables and Secrets**:

1. **Secrets (Encrypted — NEVER commit to Git or embed in GitHub Pages)**:
   - `SESSION_SIGNING_SECRET`: A strong 32-byte random secret (`openssl rand -hex 32`) used to sign and verify short-lived (`15m`) HS256 user session JWTs (`iss`, `aud`, `sub`, `iat`, `exp`, `jti`).
   - `AUTH_USERS_JSON`: JSON map of authorized relay users and passphrases for `POST /auth/session` (e.g. `{"alice":"your-strong-passphrase"}`).
   - `RELAY_AUTH_TOKEN` *(optional admin/CI test secret)*: Only active when `ENABLE_ADMIN_SHARED_TOKEN="1"` is explicitly set.
2. **Environment Variables (`apps/relay/wrangler.jsonc`)**:
   - `DESTINATION_MODE`: `"public"` (permits validated globally routable IPv4/IPv6 SSH targets on `ALLOWED_SSH_PORTS` while rejecting all private, loopback, link-local, metadata, CGNAT, multicast, reserved, IPv4-mapped IPv6, alternative encodings, and DNS rebinding answers; set to `"allowlist"` to restrict strictly to `ALLOWED_SSH_TARGETS`).
   - `ALLOWED_ORIGINS`: `https://srinivaskona7.github.io`
   - `ALLOWED_SSH_PORTS`: `22,2222`
   - `ALLOWED_SSH_TARGETS`: `""` *(optional in `public` mode; required in `allowlist` mode — never `*`)*
   - `MAX_CONCURRENT_SESSIONS_PER_USER`: `5` *(centrally enforced across all Worker isolates via the `USER_QUOTA_DO` Durable Object)*
   - `MAX_CONNECTION_ATTEMPTS_PER_MIN`: `20` *(centrally enforced per-user rate limit via `USER_QUOTA_DO`)*

### 4.3 EC2 Firewall Requirements & Outbound IP Architecture

Unlike a single EC2 bastion with an Elastic IP, **Cloudflare Workers using `cloudflare:sockets` `connect()` do not have a single fixed outbound IPv4 address** on standard Workers plans (TCP egress uses a prefix outside Cloudflare's published HTTP proxy IP ranges).

- **Do NOT blindly open TCP 22 to `0.0.0.0/0` with password authentication enabled.**
- Use one of the following hardened EC2 Security Group patterns:
  1. **Key-Only OpenSSH**: Disable password authentication in `/etc/ssh/sshd_config` (`PasswordAuthentication no`, `PermitRootLogin no`), optionally run `sshd` on port `2222`. Do not use Cloudflare's published HTTP proxy ranges as a TCP Worker egress allowlist; see https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/. Use a gateway with a fixed egress IP when strict source-IP restrictions are required.
  2. **Dedicated Bastion Go Gateway (`apps/gateway`)**: If your EC2 Security Group requires a single `/32` source IP, deploy `apps/gateway` on a single micro EC2 bastion with an Elastic IP and use **Go SSH/SFTP Gateway** mode.

### 4.4 Transport Mode Feature Matrix (`Go Gateway` vs `Cloudflare Worker Relay`)

| Feature / Subsystem | Go SSH/SFTP Gateway (`apps/gateway`) | Cloudflare Worker SSH Relay (`apps/relay`) |
|---|---|---|
| Interactive PTY Shell (`@xterm/xterm`) | Supported (Tested) | Supported (Tested) |
| Remote Command Execution (`uname -s`, `pwd`, `printf`, exit codes) | Supported (Tested) | Supported (Tested) |
| Multi-Tab & Split-Pane Independent SSH Channels | Supported (Tested) | Supported (Tested) |
| Dynamic Terminal Resize (`window-change` `cols`×`rows`) | Supported (Tested) | Supported (Tested) |
| Host-Key Verification (TOFU Pinning & Mismatch Blocker) | Supported (Tested) | Supported (Tested) |
| Password, RSA/Ed25519 PEM & In-Browser WebCrypto KeyVault Auth | Supported (Tested) | Supported (Tested) |
| Private Keys Kept Strictly in Browser | Supported (Tested) | Supported (Tested) |
| Dual-Pane SFTP Browser, Chmod & 256 KiB Chunked Transfers | Supported (Tested) | Supported (Tested via SSH-2.0 Channels) |
| Remote File Editor (Atomic SFTP Save) | Supported (Tested) | Supported (Tested via SSH-2.0 Channels) |
| Server-Side TCP Tunnel HTTP Preview | Supported (Tested) | Supported (Tested via RFC 4254 `direct-tcpip`) |
| 4 MiB Ring-Buffer Session Replay & Resume | Supported (Tested) | Supported (Tested via 4 MiB Client Ring Buffer) |


## 5. Current Pages and Relay Connection Setup

- GitHub Pages Source: **GitHub Actions**. The Pages workflow defaults to `wss://webssh-studio-relay.life-magic.workers.dev/ws`. Repository Actions variable `GATEWAY_URL` overrides it; `TRANSPORT_MODE` optionally selects `cloudflare-relay` or `go-gateway` (needed for custom relay domains). Worker endpoints select relay mode automatically for new users. Existing explicit browser preferences are preserved.
- Cloudflare Git build root: `apps/relay`; build: `npm ci --include=dev && npm run build`; deploy: `npx wrangler deploy`. Wrangler is pinned in the root lockfile. `SKIP_DEPENDENCY_INSTALL=1` is supported because the build command installs dependencies explicitly.
- Runtime secrets must be entered directly in Cloudflare: `SESSION_SIGNING_SECRET` and `AUTH_USERS_JSON`. These are separate from the EC2 SSH credentials. No secret belongs in Pages variables or source control.
- `USER_QUOTA_DO` and migration `v1` are defined in `apps/relay/wrangler.jsonc`. Missing binding blocks SSH connections. `/healthz` lists missing configuration names without exposing secret values.
- Target for this setup: host `13.238.115.195`, user `ec2-user`, port `22`. Select Cloudflare relay mode, use **Relay Login** first, then supply the EC2 key directly in the browser's SSH form. Successful relay login alone does not establish SSH authentication.
- Verify HTTPS `/healthz`, CORS from `https://srinivaskona7.github.io`, rejected foreign Origins and unauthenticated requests, relay login, host-key verification, then PTY and SFTP on the EC2 target. A successful static deployment or health check alone does not prove an authenticated SSH connection.
