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
