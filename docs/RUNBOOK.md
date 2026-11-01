# WebSSH Studio — Operations Runbook

## 1. Environment Variables (`apps/gateway`)

| Variable | Default | Description |
|---|---|---|
| `LISTEN_ADDR` | `:8080` | TCP address and port for the HTTP/WebSocket server |
| `ALLOWED_ORIGINS` | `http://localhost:4173` | Comma-separated list of allowed browser `Origin` headers |
| `OIDC_ISSUER` | *(empty — dev mode)* | OIDC issuer URL (when set, requires valid Bearer JWT) |
| `OIDC_CLIENT_ID` | *(empty)* | Expected OIDC audience (`aud`) claim |
| `DEST_ALLOWLIST` | *(empty)* | Comma-separated CIDRs permitted even if in RFC1918 |
| `DEST_DENYLIST` | *(empty)* | Additional comma-separated CIDRs to block |
| `SESSION_GRACE` | `15m` | Duration to keep detached sessions alive for browser resume |
| `RING_BUFFER_BYTES` | `4194304` (4 MiB) | Per-session output replay ring buffer size |
| `MAX_SESSIONS_PER_USER` | `10` | Maximum concurrent SSH sessions per authenticated user |
| `RATE_LIMITS` | `30` | Token-bucket connection rate limit per user per minute |

## 2. Health & Metrics Endpoints
- `GET /healthz`: Returns `200 OK` with `{"status":"ok","active_sessions":N}`.
- `GET /metrics`: Prometheus-compatible text metrics (`webssh_gateway_active_sessions`, `webssh_gateway_ audit_events_total`).

## 3. Incident Response Procedures
1. **Revoking Compromised User Sessions**: Restart or signal the gateway pod, or block the user subject at the OIDC identity provider. Detached sessions expire automatically after `SESSION_GRACE`.
2. **Investigating SSRF Policy Blocks**: Filter structured JSON stdout logs for `"event":"policy_denied"` to inspect the requesting `user_id` and `target_host`.
3. **Deploying Gateway Updates**: Tag `gateway-vX.Y.Z` to trigger `.github/workflows/gateway-release.yml`, which builds the multi-arch distroless image, generates a Syft SBOM, signs with Cosign, deploys to Fly.io, and runs post-deploy `/healthz` smoke checks.
