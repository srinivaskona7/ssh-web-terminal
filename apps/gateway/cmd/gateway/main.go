package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/sftp"
	"github.com/webssh-studio/gateway/internal/audit"
	"github.com/webssh-studio/gateway/internal/auth"
	"github.com/webssh-studio/gateway/internal/policy"
	"github.com/webssh-studio/gateway/internal/protocol"
	"github.com/webssh-studio/gateway/internal/session"
	"github.com/webssh-studio/gateway/internal/sshbridge"
	"github.com/webssh-studio/gateway/internal/testsshd"
	"golang.org/x/crypto/ssh"
)

var httpCRLF = string([]byte{13, 10})

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type ServerConfig struct {
	ListenAddr         string
	AllowedOrigins     []string
	OIDCIssuer         string
	OIDCClientID       string
	DestAllowlist      []string
	DestDenylist       []string
	SessionGrace       time.Duration
	RingBufferBytes    int
	MaxSessionsPerUser int
	RateLimitPerSec    float64
	TestSSHDInfo       map[string]any
}

func loadConfigFromEnv() ServerConfig {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	origins := strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",")
	if len(origins) == 1 && origins[0] == "" {
		origins = []string{"*"}
	}
	allowlistEnv := strings.TrimSpace(os.Getenv("DEST_ALLOWLIST"))
	var allowlist []string
	if allowlistEnv == "" {
		allowlist = []string{"127.0.0.0/8", "::1/128", "localhost", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}
	} else {
		allowlist = strings.Split(allowlistEnv, ",")
	}
	denylist := strings.Split(os.Getenv("DEST_DENYLIST"), ",")

	grace := 15 * time.Minute
	if d, err := time.ParseDuration(os.Getenv("SESSION_GRACE")); err == nil && d > 0 {
		grace = d
	}
	ringBytes := 4 * 1024 * 1024
	if b, err := strconv.Atoi(os.Getenv("RING_BUFFER_BYTES")); err == nil && b > 0 {
		ringBytes = b
	}
	maxSess := 10
	if m, err := strconv.Atoi(os.Getenv("MAX_SESSIONS_PER_USER")); err == nil && m > 0 {
		maxSess = m
	}
	rate := 100.0
	if r, err := strconv.ParseFloat(os.Getenv("RATE_LIMITS"), 64); err == nil && r > 0 {
		rate = r
	}

	return ServerConfig{
		ListenAddr:         addr,
		AllowedOrigins:     origins,
		OIDCIssuer:         os.Getenv("OIDC_ISSUER"),
		OIDCClientID:       os.Getenv("OIDC_CLIENT_ID"),
		DestAllowlist:      allowlist,
		DestDenylist:       denylist,
		SessionGrace:       grace,
		RingBufferBytes:    ringBytes,
		MaxSessionsPerUser: maxSess,
		RateLimitPerSec:    rate,
	}
}

type wsConn struct {
	conn    net.Conn
	bufrw   *bufio.ReadWriter
	writeMu sync.Mutex
	seq     atomic.Uint64
	closed  atomic.Bool
}

func upgradeWebSocket(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		return nil, errors.New("missing Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("webserver does not support hijacking")
	}
	conn, bufrw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}

	sum := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(sum[:])

	resp := "HTTP/1.1 101 Switching Protocols" + httpCRLF +
		"Upgrade: websocket" + httpCRLF +
		"Connection: Upgrade" + httpCRLF +
		"Sec-WebSocket-Accept: " + accept + httpCRLF + httpCRLF

	if _, err := bufrw.WriteString(resp); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := bufrw.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}

	return &wsConn{
		conn:  conn,
		bufrw: bufrw,
	}, nil
}

func (ws *wsConn) Close() error {
	if ws.closed.Swap(true) {
		return nil
	}
	return ws.conn.Close()
}

func (ws *wsConn) writeRawFrame(opcode byte, payload []byte) error {
	if ws.closed.Load() {
		return net.ErrClosed
	}
	ws.writeMu.Lock()
	defer ws.writeMu.Unlock()

	header := make([]byte, 0, 10)
	header = append(header, 0x80|opcode)
	length := len(payload)
	if length < 126 {
		header = append(header, byte(length))
	} else if length <= 65535 {
		header = append(header, 126, byte(length>>8), byte(length))
	} else {
		header = append(header, 127)
		lenBytes := make([]byte, 8)
		binary.BigEndian.PutUint64(lenBytes, uint64(length))
		header = append(header, lenBytes...)
	}

	if _, err := ws.bufrw.Write(header); err != nil {
		return err
	}
	if length > 0 {
		if _, err := ws.bufrw.Write(payload); err != nil {
			return err
		}
	}
	return ws.bufrw.Flush()
}

func (ws *wsConn) sendBinaryFrame(f protocol.BinaryFrame) error {
	if f.Seq == 0 {
		f.Seq = ws.seq.Add(1)
	}
	encoded, err := protocol.EncodeFrame(f)
	if err != nil {
		return err
	}
	return ws.writeRawFrame(0x02, encoded)
}

func (ws *wsConn) sendControl(msg protocol.ControlMessage) error {
	seq := ws.seq.Add(1)
	encoded, err := protocol.EncodeControlFrame(seq, msg)
	if err != nil {
		return err
	}
	return ws.writeRawFrame(0x02, encoded)
}

func (ws *wsConn) readMessage() ([]byte, error) {
	var messageBuf []byte
	for {
		b0, err := ws.bufrw.ReadByte()
		if err != nil {
			return nil, err
		}
		b1, err := ws.bufrw.ReadByte()
		if err != nil {
			return nil, err
		}

		fin := (b0 & 0x80) != 0
		opcode := b0 & 0x0f
		masked := (b1 & 0x80) != 0
		payloadLen := uint64(b1 & 0x7f)

		if payloadLen == 126 {
			ext := make([]byte, 2)
			if _, err := io.ReadFull(ws.bufrw, ext); err != nil {
				return nil, err
			}
			payloadLen = uint64(binary.BigEndian.Uint16(ext))
		} else if payloadLen == 127 {
			ext := make([]byte, 8)
			if _, err := io.ReadFull(ws.bufrw, ext); err != nil {
				return nil, err
			}
			payloadLen = binary.BigEndian.Uint64(ext)
		}

		if payloadLen > protocol.MaxFramePayloadBytes+1024 {
			return nil, protocol.ErrPayloadTooLarge
		}

		var maskKey [4]byte
		if masked {
			if _, err := io.ReadFull(ws.bufrw, maskKey[:]); err != nil {
				return nil, err
			}
		}

		chunk := make([]byte, payloadLen)
		if payloadLen > 0 {
			if _, err := io.ReadFull(ws.bufrw, chunk); err != nil {
				return nil, err
			}
		}
		if masked {
			for i := range chunk {
				chunk[i] ^= maskKey[i%4]
			}
		}

		switch opcode {
		case 0x08: // Close
			_ = ws.writeRawFrame(0x08, nil)
			return nil, io.EOF
		case 0x09: // Ping
			_ = ws.writeRawFrame(0x0A, chunk)
			continue
		case 0x0A: // Pong
			continue
		case 0x00, 0x01, 0x02: // Continuation, Text, Binary
			messageBuf = append(messageBuf, chunk...)
			if fin {
				return messageBuf, nil
			}
		default:
			if fin {
				return messageBuf, nil
			}
		}
	}
}

type ptyChannelHandle struct {
	channelID uint16
	session   *ssh.Session
	stdin     io.WriteCloser
}

func (p *ptyChannelHandle) Close() {
	if p.stdin != nil {
		_ = p.stdin.Close()
	}
	if p.session != nil {
		_ = p.session.Close()
	}
}

func NewMux(cfg ServerConfig) (http.Handler, error) {
	guard, err := policy.NewGuard(policy.Config{
		Allowlist: cfg.DestAllowlist,
		Denylist:  cfg.DestDenylist,
	})
	if err != nil {
		return nil, err
	}
	origins := auth.NewOriginValidator(cfg.AllowedOrigins)
	limiter := auth.NewRateLimiter(cfg.RateLimitPerSec, int(cfg.RateLimitPerSec*2)+20)
	sessions := session.NewManager(cfg.RingBufferBytes, cfg.SessionGrace, cfg.MaxSessionsPerUser)
	auditor := audit.NewLogger(os.Stdout, 1000)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
		payload := map[string]any{
			"status":         "ok",
			"activeSessions": sessions.ActiveCount(),
		}
		for k, v := range cfg.TestSSHDInfo {
			payload[k] = v
		}
		_ = json.NewEncoder(w).Encode(payload)
	})

	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = fmt.Fprintln(w, "webssh_gateway_active_sessions", sessions.ActiveCount())
		_, _ = fmt.Fprintln(w, "webssh_gateway_audit_events_total", len(auditor.Recent()))
	})

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if err := origins.Check(origin); err != nil {
				http.Error(w, err.Error(), http.StatusForbidden)
				return
			}
		} else {
			if err := origins.Check(origin); err != nil {
				http.Error(w, err.Error(), http.StatusForbidden)
				return
			}
		}
		if err := limiter.Allow(r.RemoteAddr); err != nil {
			http.Error(w, err.Error(), http.StatusTooManyRequests)
			return
		}
		targetHost := r.URL.Query().Get("host")
		if targetHost != "" {
			targetPort := 22
			if pStr := r.URL.Query().Get("port"); pStr != "" {
				if pVal, pErr := strconv.Atoi(pStr); pErr == nil && pVal > 0 {
					targetPort = pVal
				}
			}
			if _, err := guard.Check(r.Context(), targetHost, targetPort); err != nil {
				auditor.Record(audit.Entry{
					Event:      audit.EventPolicyDenied,
					UserID:     "ws-precheck",
					TargetHost: targetHost,
					TargetPort: targetPort,
					Reason:     err.Error(),
				})
				http.Error(w, err.Error(), http.StatusForbidden)
				return
			}
		}

		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || r.Header.Get("Sec-WebSocket-Key") == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUpgradeRequired)
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "upgrade_required"})
			return
		}

		ws, err := upgradeWebSocket(w, r)
		if err != nil {
			return
		}
		handleWebSocketSession(r.Context(), ws, guard, sessions, auditor)
	})

	return mux, nil
}

func handleWebSocketSession(
	parentCtx context.Context,
	ws *wsConn,
	guard *policy.Guard,
	sessions *session.Manager,
	auditor *audit.Logger,
) {
	ctx, cancel := context.WithCancel(parentCtx)
	defer cancel()
	defer ws.Close()

	var (
		stateMu     sync.Mutex
		sshClient   *ssh.Client
		sftpClient  *sftp.Client
		sftpBridge  *sshbridge.SFTPBridge
		tunnelMgr   *sshbridge.TunnelManager
		gwSession   *session.Session
		ptyChannels = make(map[uint16]*ptyChannelHandle)
		nextChanID  uint16 = protocol.FirstPtyChannelID
		hostKeyCh          = make(chan bool, 1)
		signMu      sync.Mutex
		signWaiters = make(map[string]chan string)
		reqSeq      atomic.Uint64
	)

	defer func() {
		stateMu.Lock()
		for _, ch := range ptyChannels {
			ch.Close()
		}
		if tunnelMgr != nil {
			tunnelMgr.CloseAll()
		}
		if sftpClient != nil {
			_ = sftpClient.Close()
		}
		if sshClient != nil {
			_ = sshClient.Close()
		}
		if gwSession != nil {
			sessions.Close(gwSession.ID)
			auditor.Record(audit.Entry{
				Event:      audit.EventDisconnect,
				SessionID:  gwSession.ID,
				UserID:     gwSession.UserID,
				TargetHost: gwSession.Host,
				TargetPort: gwSession.Port,
				TargetUser: gwSession.TargetUser,
			})
		}
		stateMu.Unlock()
	}()

	openPtyChannel := func(client *ssh.Client, requestedID uint16, cols, rows int) (uint16, error) {
		if cols <= 0 {
			cols = 80
		}
		if rows <= 0 {
			rows = 24
		}
		sess, err := client.NewSession()
		if err != nil {
			return 0, err
		}
		modes := ssh.TerminalModes{
			ssh.ECHO:          1,
			ssh.TTY_OP_ISPEED: 14400,
			ssh.TTY_OP_OSPEED: 14400,
		}
		if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
			_ = sess.Close()
			return 0, err
		}
		stdin, err := sess.StdinPipe()
		if err != nil {
			_ = sess.Close()
			return 0, err
		}
		stdout, err := sess.StdoutPipe()
		if err != nil {
			_ = sess.Close()
			return 0, err
		}
		stderr, err := sess.StderrPipe()
		if err != nil {
			_ = sess.Close()
			return 0, err
		}
		if err := sess.Shell(); err != nil {
			_ = sess.Close()
			return 0, err
		}

		stateMu.Lock()
		chID := requestedID
		if chID == 0 || ptyChannels[chID] != nil {
			for ptyChannels[nextChanID] != nil {
				nextChanID++
			}
			chID = nextChanID
			nextChanID++
		} else if chID >= nextChanID {
			nextChanID = chID + 1
		}
		handle := &ptyChannelHandle{
			channelID: chID,
			session:   sess,
			stdin:     stdin,
		}
		ptyChannels[chID] = handle
		currSess := gwSession
		stateMu.Unlock()

		streamPipe := func(r io.Reader) {
			buf := make([]byte, 16384)
			for {
				n, readErr := r.Read(buf)
				if n > 0 {
					chunk := make([]byte, n)
					copy(chunk, buf[:n])
					var seq uint64
					if currSess != nil && currSess.Buffer != nil {
						seq = currSess.Buffer.Append(chID, chunk)
					}
					_ = ws.sendBinaryFrame(protocol.BinaryFrame{
						Type:    protocol.FrameTypePtyData,
						Channel: chID,
						Seq:     seq,
						Payload: chunk,
					})
				}
				if readErr != nil {
					return
				}
			}
		}

		go streamPipe(stdout)
		go streamPipe(stderr)
		go func() {
			waitErr := sess.Wait()
			exitCode := 0
			if waitErr != nil {
				var exitErr *ssh.ExitError
				if errors.As(waitErr, &exitErr) {
					exitCode = exitErr.ExitStatus()
				} else {
					exitCode = 1
				}
			}
			stateMu.Lock()
			delete(ptyChannels, chID)
			stateMu.Unlock()
			_ = ws.sendControl(protocol.ControlMessage{
				Type:     "channel_closed",
				Channel:  chID,
				ExitCode: exitCode,
			})
		}()

		return chID, nil
	}

	for {
		rawMsg, err := ws.readMessage()
		if err != nil {
			return
		}
		frame, err := protocol.DecodeFrame(rawMsg)
		if err != nil {
			_ = ws.sendControl(protocol.ControlMessage{
				Type:    "error",
				Code:    "PROTOCOL_ERROR",
				Message: err.Error(),
			})
			continue
		}

		switch frame.Type {
		case protocol.FrameTypePing:
			_ = ws.sendBinaryFrame(protocol.BinaryFrame{
				Type:    protocol.FrameTypePong,
				Channel: frame.Channel,
				Seq:     frame.Seq,
				Payload: frame.Payload,
			})

		case protocol.FrameTypePtyData:
			chID := frame.Channel
			if chID == 0 {
				chID = protocol.FirstPtyChannelID
			}
			stateMu.Lock()
			handle := ptyChannels[chID]
			stateMu.Unlock()
			if handle != nil && handle.stdin != nil {
				_, _ = handle.stdin.Write(frame.Payload)
			}

		case protocol.FrameTypeControl:
			ctrl, err := protocol.DecodeControlPayload(frame.Payload)
			if err != nil {
				_ = ws.sendControl(protocol.ControlMessage{
					Type:    "error",
					Code:    "INVALID_CONTROL",
					Message: err.Error(),
				})
				continue
			}

			switch ctrl.Type {
			case "hello":
				// Client hello received; ready for connect or resume
			case "hostkey_decision":
				select {
				case hostKeyCh <- ctrl.Trusted:
				default:
				}
			case "sign_response":
				signMu.Lock()
				ch, ok := signWaiters[ctrl.RequestID]
				signMu.Unlock()
				if ok {
					select {
					case ch <- ctrl.SignatureBase64:
					default:
					}
				}
			case "connect":
				go func(msg protocol.ControlMessage) {
					port := msg.Port
					if port <= 0 {
						port = 22
					}
					verifiedIP, err := guard.Check(ctx, msg.Host, port)
					if err != nil {
						auditor.Record(audit.Entry{
							Event:      audit.EventPolicyDenied,
							UserID:     msg.User,
							TargetHost: msg.Host,
							TargetPort: port,
							TargetUser: msg.User,
							Reason:     err.Error(),
						})
						_ = ws.sendControl(protocol.ControlMessage{
							Type:    "error",
							Code:    "POLICY_DENIED",
							Message: err.Error(),
							Fatal:   true,
						})
						return
					}

					dialAddr := net.JoinHostPort(verifiedIP.String(), strconv.Itoa(port))
					targetHop := sshbridge.HopConfig{
						Addr:     dialAddr,
						Host:     msg.Host,
						Port:     port,
						User:     msg.User,
						Password: msg.Password,
					}
					authUsed := "password"

					if strings.TrimSpace(msg.PrivateKeyPem) != "" {
						signer, parseErr := sshbridge.ParsePrivateKeySigner(msg.PrivateKeyPem, msg.PrivateKeyPassphrase)
						if parseErr != nil {
							_ = ws.sendControl(protocol.ControlMessage{
								Type:    "error",
								Code:    "INVALID_PRIVATE_KEY",
								Message: fmt.Sprintf("Private key parse failed: %v", parseErr),
								Fatal:   true,
							})
							return
						}
						targetHop.Signer = signer
						authUsed = "private_key (" + signer.PublicKey().Type() + ")"
					} else if strings.TrimSpace(msg.PublicKey) != "" {
						pubKey, _, _, _, parseErr := ssh.ParseAuthorizedKey([]byte(strings.TrimSpace(msg.PublicKey)))
						if parseErr != nil {
							_ = ws.sendControl(protocol.ControlMessage{
								Type:    "error",
								Code:    "INVALID_PUBLIC_KEY",
								Message: fmt.Sprintf("Public key parse failed: %v", parseErr),
								Fatal:   true,
							})
							return
						}
						targetHop.Signer = sshbridge.NewRemoteSigner(pubKey, func(signCtx context.Context, alg string, data []byte) ([]byte, error) {
							reqID := fmt.Sprintf("sig_%d", reqSeq.Add(1))
							waitCh := make(chan string, 1)
							signMu.Lock()
							signWaiters[reqID] = waitCh
							signMu.Unlock()
							defer func() {
								signMu.Lock()
								delete(signWaiters, reqID)
								signMu.Unlock()
							}()

							if err := ws.sendControl(protocol.ControlMessage{
								Type:           "sign_request",
								RequestID:      reqID,
								DataBase64:     base64.StdEncoding.EncodeToString(data),
								Algorithm:      alg,
								KeyFingerprint: msg.KeyFingerprint,
							}); err != nil {
								return nil, err
							}

							select {
							case <-signCtx.Done():
								return nil, signCtx.Err()
							case <-ctx.Done():
								return nil, ctx.Err()
							case sigB64 := <-waitCh:
								if sigB64 == "" {
									return nil, errors.New("empty signature response from client")
								}
								return base64.StdEncoding.DecodeString(sigB64)
							}
						})
						authUsed = "remote_signer (" + pubKey.Type() + ")"
					}

					hkCb := func(hkCtx context.Context, host string, p int, key ssh.PublicKey) error {
						// Drain any stale decision
						select {
						case <-hostKeyCh:
						default:
						}
						fp := sshbridge.FormatHostKeyFingerprint(key)
						pubB64 := base64.StdEncoding.EncodeToString(key.Marshal())
						if err := ws.sendControl(protocol.ControlMessage{
							Type:            "hostkey_prompt",
							Host:            host,
							Port:            p,
							Algorithm:       key.Type(),
							Fingerprint:     fp,
							PublicKeyBase64: pubB64,
						}); err != nil {
							return err
						}
						select {
						case <-hkCtx.Done():
							return hkCtx.Err()
						case <-ctx.Done():
							return ctx.Err()
						case trusted := <-hostKeyCh:
							if !trusted {
								return sshbridge.ErrHostKeyRejected
							}
							return nil
						}
					}

					client, err := sshbridge.DialChain(ctx, nil, targetHop, hkCb)
					if err != nil {
						code := "SSH_CONNECT_FAILED"
						if errors.Is(err, sshbridge.ErrHostKeyRejected) {
							code = "HOSTKEY_REJECTED"
						}
						auditor.Record(audit.Entry{
							Event:      audit.EventAuthFailure,
							UserID:     msg.User,
							TargetHost: msg.Host,
							TargetPort: port,
							TargetUser: msg.User,
							Reason:     err.Error(),
						})
						_ = ws.sendControl(protocol.ControlMessage{
							Type:    "error",
							Code:    code,
							Message: err.Error(),
							Fatal:   true,
						})
						return
					}

					sessObj, err := sessions.Create(msg.User, msg.Host, port, msg.User)
					if err != nil {
						_ = client.Close()
						_ = ws.sendControl(protocol.ControlMessage{
							Type:    "error",
							Code:    "SESSION_LIMIT",
							Message: err.Error(),
							Fatal:   true,
						})
						return
					}

					var sfClient *sftp.Client
					var sfBridge *sshbridge.SFTPBridge
					sftpReady := false
					sftpErrStr := ""
					if sc, sfErr := sftp.NewClient(client); sfErr == nil {
						sfClient = sc
						sfBridge = sshbridge.NewSFTPBridge(sc)
						sftpReady = true
					} else {
						sftpErrStr = sfErr.Error()
					}

					tMgr := sshbridge.NewTunnelManager(client)

					stateMu.Lock()
					sshClient = client
					sftpClient = sfClient
					sftpBridge = sfBridge
					tunnelMgr = tMgr
					gwSession = sessObj
					stateMu.Unlock()

					ptyChanID, err := openPtyChannel(client, protocol.FirstPtyChannelID, msg.Cols, msg.Rows)
					if err != nil {
						_ = ws.sendControl(protocol.ControlMessage{
							Type:    "error",
							Code:    "PTY_OPEN_FAILED",
							Message: err.Error(),
							Fatal:   true,
						})
						return
					}

					serverVer := string(client.ServerVersion())
					if serverVer == "" {
						serverVer = "SSH-2.0-OpenSSH"
					}

					auditor.Record(audit.Entry{
						Event:          audit.EventAuthSuccess,
						SessionID:      sessObj.ID,
						UserID:         msg.User,
						TargetHost:     msg.Host,
						TargetPort:     port,
						TargetUser:     msg.User,
						KeyFingerprint: msg.KeyFingerprint,
					})

					_ = ws.sendControl(protocol.ControlMessage{
						Type:           "connected",
						SessionID:      sessObj.ID,
						ResumeToken:    sessObj.ResumeToken,
						PtyChannel:     ptyChanID,
						Cipher:         "chacha20-poly1305@openssh.com",
						Kex:            "curve25519-sha256",
						ServerVersion:  serverVer,
						AuthMethodUsed: authUsed,
						SftpReady:      sftpReady,
						SftpError:      sftpErrStr,
					})
				}(ctrl)

			case "open_channel":
				go func(msg protocol.ControlMessage) {
					stateMu.Lock()
					client := sshClient
					stateMu.Unlock()
					if client == nil {
						_ = ws.sendControl(protocol.ControlMessage{
							Type:  "channel_opened",
							OpID:  msg.OpID,
							OK:    false,
							Error: "SSH session not connected",
						})
						return
					}
					chID, err := openPtyChannel(client, msg.Channel, msg.Cols, msg.Rows)
					if err != nil {
						_ = ws.sendControl(protocol.ControlMessage{
							Type:  "channel_opened",
							OpID:  msg.OpID,
							OK:    false,
							Error: err.Error(),
						})
						return
					}
					_ = ws.sendControl(protocol.ControlMessage{
						Type:    "channel_opened",
						OpID:    msg.OpID,
						Channel: chID,
						OK:      true,
					})
				}(ctrl)

			case "close_channel":
				stateMu.Lock()
				handle := ptyChannels[ctrl.Channel]
				delete(ptyChannels, ctrl.Channel)
				stateMu.Unlock()
				if handle != nil {
					handle.Close()
				}

			case "resize":
				chID := ctrl.Channel
				if chID == 0 {
					chID = protocol.FirstPtyChannelID
				}
				stateMu.Lock()
				handle := ptyChannels[chID]
				stateMu.Unlock()
				if handle != nil && handle.session != nil && ctrl.Cols > 0 && ctrl.Rows > 0 {
					_ = handle.session.WindowChange(ctrl.Rows, ctrl.Cols)
				}

			case "exec_command":
				go func(msg protocol.ControlMessage) {
					stateMu.Lock()
					client := sshClient
					stateMu.Unlock()
					if client == nil {
						_ = ws.sendControl(protocol.ControlMessage{
							Type:     "exec_result",
							OpID:     msg.OpID,
							OK:       false,
							ExitCode: 1,
							Error:    "SSH session not connected",
						})
						return
					}
					timeout := 15 * time.Second
					if msg.TimeoutMs > 0 {
						timeout = time.Duration(msg.TimeoutMs) * time.Millisecond
					}
					stdout, stderr, exitCode, dur, err := sshbridge.ExecCommand(ctx, client, msg.Command, timeout)
					errStr := ""
					if err != nil {
						errStr = err.Error()
					}
					_ = ws.sendControl(protocol.ControlMessage{
						Type:       "exec_result",
						OpID:       msg.OpID,
						OK:         err == nil && exitCode == 0,
						Stdout:     stdout,
						Stderr:     stderr,
						ExitCode:   exitCode,
						DurationMs: dur,
						Error:      errStr,
					})
				}(ctrl)

			case "sftp_op":
				go func(msg protocol.ControlMessage) {
					stateMu.Lock()
					bridge := sftpBridge
					stateMu.Unlock()
					res := bridge.HandleOp(msg)
					_ = ws.sendControl(res)
				}(ctrl)

			case "tunnel_op":
				go func(msg protocol.ControlMessage) {
					stateMu.Lock()
					tm := tunnelMgr
					stateMu.Unlock()
					res := tm.HandleOp(msg)
					_ = ws.sendControl(res)
				}(ctrl)

			case "deploy_key":
				go func(msg protocol.ControlMessage) {
					stateMu.Lock()
					sess := gwSession
					stateMu.Unlock()
					if sess == nil {
						_ = ws.sendControl(protocol.ControlMessage{
							Type:    "error",
							Code:    "DEPLOY_KEY_FAILED",
							Message: "no active session for deploy_key",
						})
						return
					}
					addr := net.JoinHostPort(sess.Host, strconv.Itoa(sess.Port))
					if err := sshbridge.DeployAuthorizedKey(ctx, addr, sess.Host, sess.Port, sess.TargetUser, msg.Password, msg.PublicKey, nil); err != nil {
						_ = ws.sendControl(protocol.ControlMessage{
							Type:    "error",
							Code:    "DEPLOY_KEY_FAILED",
							Message: err.Error(),
						})
					}
				}(ctrl)
			}
		}
	}
}

func main() {
	cfg := loadConfigFromEnv()

	if os.Getenv("ENABLE_TESTSSHD") == "1" {
		rootDir := os.Getenv("TESTSSHD_ROOT")
		if rootDir == "" {
			tmp, err := os.MkdirTemp("", "webssh-testsshd-*")
			if err == nil {
				rootDir = tmp
			}
		}
		// Seed initial files in rootDir so SFTP and shell ls/cat have real files to inspect
		_ = os.WriteFile(rootDir+"/README.md", []byte(`# WebSSH Test Server
Real filesystem backed by testsshd.
`), 0644)
		_ = os.MkdirAll(rootDir+"/config", 0755)
		_ = os.WriteFile(rootDir+"/config/app.yaml", []byte(`server:
  port: 8080
  env: production
`), 0644)

		pass := os.Getenv("TESTSSHD_PASSWORD")
		if pass == "" {
			pass = "testpass123"
		}
		pub, priv, _ := ed25519.GenerateKey(rand.Reader)
		sshPub, _ := ssh.NewPublicKey(pub)
		_ = priv
		sshd, err := testsshd.NewServer(rootDir, pass, []ssh.PublicKey{sshPub})
		if err != nil {
			log.Fatalf("failed to start embedded testsshd: %v", err)
		}
		defer sshd.Close()
		host, port := sshd.HostPort()
		cfg.TestSSHDInfo = map[string]any{
			"testSshdHost":        host,
			"testSshdPort":        port,
			"testSshdFingerprint": sshbridge.FormatHostKeyFingerprint(sshd.HostKey()),
			"testSshdRoot":        rootDir,
		}
		log.Printf("Embedded testsshd listening on %s:%d (root=%s)", host, port, rootDir)
	}

	handler, err := NewMux(cfg)
	if err != nil {
		log.Fatalf("gateway init failed: %v", err)
	}
	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("WebSSH Studio Gateway listening on %s", cfg.ListenAddr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}
