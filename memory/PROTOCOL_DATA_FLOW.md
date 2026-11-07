# Protocol & Data Flow

## Binary Framing (gateway mode)

```
[type:u8][channel:u16][seq:u64][len:u32][payload]  BE, 15-byte header
```

- Max frame: 4 MiB. Credit-based flow control per data channel (`credit{channel, bytes}`).
- Sequence numbers per channel; sequence replay helpers on both TS and Go sides.
- Channel 0: JSON control. PTY: 1..1023. SFTP streams: 1024..65535.

Reference: `packages/protocol/src/index.ts`, `apps/gateway/internal/protocol/`, ADR-004.

## Control Messages (channel 0)

| Message | Direction | Purpose |
|---------|-----------|---------|
| `hello` | C→S | Negotiate, identity |
| `connect` | C→S | Host/port/user, auth, `jump` chain |
| `hostkey_prompt` | S→C | SHA-256 fingerprint, needs decision |
| `hostkey_decision` | C→S | Accept / reject / pin |
| `sign_request` | S→C | SSH auth challenge blob |
| `sign_response` | C→S | Browser WebCrypto signature (IEEE-P1363 → `mpint`) |
| `open_channel` | C→S | Open PTY / SFTP / exec channel |
| `pty-req` / `shell` | S→C ack | PTY setup. Relay mode must wait for both acks before `channel_opened` |
| `resize` | C→S | `cols`×`rows` for xterm `window-change` |
| `PtyData` | both | Terminal bytes |
| `exec_command` / `exec_result` | both | Single command, exit code |
| `list` / `stat` / `read_file` / `write_file` / `chmod` / `upload_*` / `download_read` | both | SFTP ops via gateway |
| `tunnel_op` / `tunnel_result` | both | `direct-tcpip` forwarding |
| `resume` | C→S | Re-attach with stored session id/token + last seq |
| `ack` / `resync` / `credit` / `error` | both | Flow control, error codes (`ERR_D...`, `HOST_KEY_MISMATCH`, `SSH_AUTH_FAILED`) |

## Relay Mode (raw SSH-2.0)

Worker bridges binary WebSocket ↔ raw TCP bytes via `cloudflare:sockets`. No custom framing — browser speaks SSH directly:

1. KEX: `ecdh-sha2-nistp256` (RFC 5656)
2. Host key: `ssh-ed25519` / `ecdsa-sha2-nistp256` / `rsa-sha2-256` + TOFU
3. Cipher: `aes128-ctr` + `hmac-sha2-256` (and `aes128-gcm@openssh.com` path)
4. Auth: `password` (RFC 4252) + `publickey` (PEM / OpenSSH / WebCrypto signer)
5. Channels: `session` → `pty-req`, `shell`, `exec`, `window-change`, `signal`

Client: `apps/web/src/transport/browser-ssh-client.ts`. Banner verified by Worker before bridging.

## PTY Lifecycle

```
open_channel  (C picks free channel id)
  → server allocs sshd channel
  → pty-req (term type, cols, rows, modes)
  → shell  (or exec for single command)
  → server ACK both
  → channel_opened (only now mark tab `ready`)
  → PtyData ↔ (seq, credit)
  → resize on xterm fit changes
  → close_channel
```

- `connected`/`channel_opened` must NOT be reported before both acks (see Invariants).
- Each tab/split = independent channel. `connection-registry.ts` routes channel → pane.
- Global status bar reports active connection only.

## Session Resume & Reliability

- Gateway: 4 MiB per-session ring buffer, `SESSION_GRACE=15m`. Client sends `resume` + last seq, server replays.
- Relay: no server session. Client keeps 4 MiB ring buffer, `reconnect()` starts a **new shell** and replays buffer — UI says so.
- Client pending input: 64 KiB queue. Backoff: 500 ms → 30 s, ±25% jitter.
- `xterm` input never echoed locally; output only from PTY. Local commands appear in Inspector only.

## SFTP / File Transfer

- 256 KiB chunks, incremental SHA-256, `.part` / `.webssh-part` atomic rename, offset resume.
- `~` expansion everywhere (`resolvePath`).
- Upload queue + bounded concurrency, `StorageGuard` 32 MiB in-flight / 256 MiB local cap.
- Relay `sftpOp` is shell-based (`ls`/`cat` + fixture `write-file`) — not production SFTP. Gateway is canonical for binary transfers and editor saves.
- Editor pages reads until gateway-reported size met; refuses short/partial and non-UTF-8; >3 MiB chunked write; CRLF preserved via `detectEol`.

## Workspace Session Contract

`session/adapters.ts` normalizes both transports into:

```ts
WorkspaceRemoteSession {
  exec(cmd): Promise<...>
  execStream(cmd): AsyncIterable<...>
  readFile(path): Promise<Buffer>
  writeFile(path, data): Promise<void>
}
```

All workspace modules (control, containers, k8s, git, projects, recipes/jobs, diagrams) consume this — never direct WS. Remote-signed `sudo -n` actions gated by inline confirm; power actions need typed hostname.

## Jobs (durable detached)

- `remote-job-runner.ts`: `setsid` + markers, base64 script via `sh -c` argv (leak caveat — see Threat Model §3 for `sensitive:true`)
- `job-manager.ts`: monitor/cancel/reattach, post-install `verifyJob` from markers, `startCommandJob` for deploys
- Store: IndexedDB. Needs streaming exec on transport.
