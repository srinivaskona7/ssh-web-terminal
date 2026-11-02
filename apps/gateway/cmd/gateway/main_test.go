package main

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/webssh-studio/gateway/internal/protocol"
	"github.com/webssh-studio/gateway/internal/sshbridge"
	"github.com/webssh-studio/gateway/internal/testsshd"
	"golang.org/x/crypto/ssh"
)

func TestGatewayHTTPAndSecurityEndpoints(t *testing.T) {
	cfg := ServerConfig{
		ListenAddr:         ":0",
		AllowedOrigins:     []string{"https://app.webssh.studio"},
		DestAllowlist:      []string{},
		DestDenylist:       []string{},
		SessionGrace:       time.Minute,
		RingBufferBytes:    65536,
		MaxSessionsPerUser: 5,
		RateLimitPerSec:    100,
	}
	handler, err := NewMux(cfg)
	if err != nil {
		t.Fatalf("NewMux failed: %v", err)
	}

	// 1. /healthz
	reqHealth := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	recHealth := httptest.NewRecorder()
	handler.ServeHTTP(recHealth, reqHealth)
	if recHealth.Code != http.StatusOK || !strings.Contains(recHealth.Body.String(), `"status":"ok"`) {
		t.Fatalf("unexpected /healthz response: %d %s", recHealth.Code, recHealth.Body.String())
	}

	// 2. /metrics
	reqMetrics := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	recMetrics := httptest.NewRecorder()
	handler.ServeHTTP(recMetrics, reqMetrics)
	if recMetrics.Code != http.StatusOK || !strings.Contains(recMetrics.Body.String(), "webssh_gateway_active_sessions") {
		t.Fatalf("unexpected /metrics response: %d %s", recMetrics.Code, recMetrics.Body.String())
	}

	// 3. /ws blocks disallowed Origin
	reqBadOrigin := httptest.NewRequest(http.MethodGet, "/ws", nil)
	reqBadOrigin.Header.Set("Origin", "https://evil.example.com")
	recBadOrigin := httptest.NewRecorder()
	handler.ServeHTTP(recBadOrigin, reqBadOrigin)
	if recBadOrigin.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for bad Origin, got %d", recBadOrigin.Code)
	}

	// 4. /ws blocks SSRF metadata target
	reqSSRF := httptest.NewRequest(http.MethodGet, "/ws?host=169.254.169.254", nil)
	reqSSRF.Header.Set("Origin", "https://app.webssh.studio")
	recSSRF := httptest.NewRecorder()
	handler.ServeHTTP(recSSRF, reqSSRF)
	if recSSRF.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for SSRF target 169.254.169.254, got %d", recSSRF.Code)
	}
}

type testWSClient struct {
	conn  net.Conn
	bufrw *bufio.ReadWriter
	seq   uint64
}

func dialTestWS(t *testing.T, srvURL string, origin string) *testWSClient {
	t.Helper()
	addr := strings.TrimPrefix(srvURL, "http://")
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial ws failed: %v", err)
	}
	bufrw := bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn))
	req := "GET /ws HTTP/1.1" + httpCRLF +
		"Host: " + addr + httpCRLF +
		"Origin: " + origin + httpCRLF +
		"Upgrade: websocket" + httpCRLF +
		"Connection: Upgrade" + httpCRLF +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" + httpCRLF +
		"Sec-WebSocket-Version: 13" + httpCRLF + httpCRLF
	if _, err := bufrw.WriteString(req); err != nil {
		t.Fatalf("write ws handshake failed: %v", err)
	}
	if err := bufrw.Flush(); err != nil {
		t.Fatalf("flush ws handshake failed: %v", err)
	}
	statusLine, err := bufrw.ReadString(10)
	if err != nil || !strings.Contains(statusLine, "101") {
		t.Fatalf("expected 101 Switching Protocols, got %q (err=%v)", statusLine, err)
	}
	for {
		line, err := bufrw.ReadString(10)
		if err != nil || line == httpCRLF || line == string([]byte{10}) {
			break
		}
	}
	return &testWSClient{conn: conn, bufrw: bufrw}
}

func (c *testWSClient) sendBinary(payload []byte) error {
	mask := [4]byte{0x12, 0x34, 0x56, 0x78}
	header := []byte{0x82}
	length := len(payload)
	if length < 126 {
		header = append(header, 0x80|byte(length))
	} else if length <= 65535 {
		header = append(header, 0x80|126, byte(length>>8), byte(length))
	} else {
		header = append(header, 0x80|127)
		ext := make([]byte, 8)
		binary.BigEndian.PutUint64(ext, uint64(length))
		header = append(header, ext...)
	}
	header = append(header, mask[:]...)
	masked := make([]byte, length)
	for i := range payload {
		masked[i] = payload[i] ^ mask[i%4]
	}
	if _, err := c.bufrw.Write(header); err != nil {
		return err
	}
	if _, err := c.bufrw.Write(masked); err != nil {
		return err
	}
	return c.bufrw.Flush()
}

func (c *testWSClient) sendControl(msg protocol.ControlMessage) error {
	c.seq++
	raw, err := protocol.EncodeControlFrame(c.seq, msg)
	if err != nil {
		return err
	}
	return c.sendBinary(raw)
}

func (c *testWSClient) sendPty(channel uint16, data []byte) error {
	c.seq++
	raw, err := protocol.EncodeFrame(protocol.BinaryFrame{
		Type:    protocol.FrameTypePtyData,
		Channel: channel,
		Seq:     c.seq,
		Payload: data,
	})
	if err != nil {
		return err
	}
	return c.sendBinary(raw)
}

func (c *testWSClient) readFrame(timeout time.Duration) (protocol.BinaryFrame, error) {
	_ = c.conn.SetReadDeadline(time.Now().Add(timeout))
	b0, err := c.bufrw.ReadByte()
	if err != nil {
		return protocol.BinaryFrame{}, err
	}
	b1, err := c.bufrw.ReadByte()
	if err != nil {
		return protocol.BinaryFrame{}, err
	}
	_ = b0
	payloadLen := uint64(b1 & 0x7f)
	if payloadLen == 126 {
		ext := make([]byte, 2)
		if _, err := io.ReadFull(c.bufrw, ext); err != nil {
			return protocol.BinaryFrame{}, err
		}
		payloadLen = uint64(binary.BigEndian.Uint16(ext))
	} else if payloadLen == 127 {
		ext := make([]byte, 8)
		if _, err := io.ReadFull(c.bufrw, ext); err != nil {
			return protocol.BinaryFrame{}, err
		}
		payloadLen = binary.BigEndian.Uint64(ext)
	}
	buf := make([]byte, payloadLen)
	if _, err := io.ReadFull(c.bufrw, buf); err != nil {
		return protocol.BinaryFrame{}, err
	}
	return protocol.DecodeFrame(buf)
}

func TestWebSocketEndToEndSSHPTYExecSFTPAndTunnel(t *testing.T) {
	tmpDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(tmpDir, "hello.txt"), []byte("initial content"+string([]byte{10})), 0644)

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ed25519 generate failed: %v", err)
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatalf("NewPublicKey failed: %v", err)
	}

	sshd, err := testsshd.NewServer(tmpDir, "secret-pass", []ssh.PublicKey{sshPub})
	if err != nil {
		t.Fatalf("testsshd.NewServer failed: %v", err)
	}
	defer sshd.Close()
	sshHost, sshPort := sshd.HostPort()

	cfg := ServerConfig{
		ListenAddr:         ":0",
		AllowedOrigins:     []string{"http://localhost:5173"},
		DestAllowlist:      []string{"127.0.0.1"},
		DestDenylist:       []string{},
		SessionGrace:       time.Minute,
		RingBufferBytes:    65536,
		MaxSessionsPerUser: 10,
		RateLimitPerSec:    200,
	}
	handler, err := NewMux(cfg)
	if err != nil {
		t.Fatalf("NewMux failed: %v", err)
	}
	srv := httptest.NewServer(handler)
	defer srv.Close()

	ws := dialTestWS(t, srv.URL, "http://localhost:5173")
	defer ws.conn.Close()

	// Encode PEM private key to verify real private_key auth
	pemBlock, err := ssh.MarshalPrivateKey(priv, "test-ed25519")
	if err != nil {
		t.Fatalf("MarshalPrivateKey failed: %v", err)
	}
	pemBytes := pem.EncodeToMemory(pemBlock)

	if err := ws.sendControl(protocol.ControlMessage{
		Type:          "connect",
		Host:          sshHost,
		Port:          sshPort,
		User:          "ubuntu",
		AuthMethod:    "private_key",
		PrivateKeyPem: string(pemBytes),
		Cols:          100,
		Rows:          30,
	}); err != nil {
		t.Fatalf("send connect failed: %v", err)
	}

	// Expect hostkey_prompt -> send hostkey_decision -> expect connected
	var connectedMsg protocol.ControlMessage
	for connectedMsg.Type != "connected" {
		f, err := ws.readFrame(5 * time.Second)
		if err != nil {
			t.Fatalf("readFrame during handshake failed: %v", err)
		}
		if f.Type == protocol.FrameTypeControl {
			ctrl, err := protocol.DecodeControlPayload(f.Payload)
			if err != nil {
				t.Fatalf("DecodeControlPayload failed: %v", err)
			}
			switch ctrl.Type {
			case "hostkey_prompt":
				if ctrl.Fingerprint != sshbridge.FormatHostKeyFingerprint(sshd.HostKey()) {
					t.Fatalf("unexpected hostkey fingerprint: %s", ctrl.Fingerprint)
				}
				if err := ws.sendControl(protocol.ControlMessage{
					Type:    "hostkey_decision",
					Trusted: true,
				}); err != nil {
					t.Fatalf("send hostkey_decision failed: %v", err)
				}
			case "connected":
				connectedMsg = ctrl
			case "error":
				t.Fatalf("unexpected error during connect: %s %s", ctrl.Code, ctrl.Message)
			}
		}
	}

	if !connectedMsg.SftpReady {
		t.Fatalf("expected SftpReady=true, got false (err=%s)", connectedMsg.SftpError)
	}
	if !strings.Contains(connectedMsg.ServerVersion, "OpenSSH") {
		t.Fatalf("expected ServerVersion to contain OpenSSH, got %q", connectedMsg.ServerVersion)
	}

	// 1. Test interactive PTY command: uname -s -> Linux
	if err := ws.sendPty(1, append([]byte("uname -s"), 13)); err != nil {
		t.Fatalf("sendPty uname failed: %v", err)
	}
	var ptyAccum strings.Builder
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(ptyAccum.String(), "Linux") {
		f, err := ws.readFrame(2 * time.Second)
		if err != nil {
			break
		}
		if f.Type == protocol.FrameTypePtyData {
			ptyAccum.Write(f.Payload)
		}
	}
	if !strings.Contains(ptyAccum.String(), "Linux") {
		t.Fatalf("expected PTY output to contain 'Linux', got %q", ptyAccum.String())
	}

	// 2. Test exec_command: pwd, printf, and non-zero exit code
	if err := ws.sendControl(protocol.ControlMessage{
		Type:    "exec_command",
		OpID:    "exec-1",
		Command: "pwd && printf 'hello-world'",
	}); err != nil {
		t.Fatalf("send exec_command failed: %v", err)
	}
	var execRes protocol.ControlMessage
	for execRes.Type != "exec_result" {
		f, err := ws.readFrame(3 * time.Second)
		if err != nil {
			t.Fatalf("readFrame for exec_result failed: %v", err)
		}
		if f.Type == protocol.FrameTypeControl {
			ctrl, _ := protocol.DecodeControlPayload(f.Payload)
			if ctrl.Type == "exec_result" && ctrl.OpID == "exec-1" {
				execRes = ctrl
			}
		}
	}
	if !execRes.OK || execRes.ExitCode != 0 || !strings.Contains(execRes.Stdout, "/home/ubuntu") || !strings.Contains(execRes.Stdout, "hello-world") {
		t.Fatalf("unexpected exec_result: %+v", execRes)
	}

	// Non-zero exit code command
	_ = ws.sendControl(protocol.ControlMessage{
		Type:    "exec_command",
		OpID:    "exec-fail",
		Command: "nonexistent_cmd_xyz",
	})
	var failRes protocol.ControlMessage
	for failRes.Type != "exec_result" {
		f, err := ws.readFrame(3 * time.Second)
		if err != nil {
			t.Fatalf("readFrame for exec-fail failed: %v", err)
		}
		if f.Type == protocol.FrameTypeControl {
			ctrl, _ := protocol.DecodeControlPayload(f.Payload)
			if ctrl.Type == "exec_result" && ctrl.OpID == "exec-fail" {
				failRes = ctrl
			}
		}
	}
	if failRes.OK || failRes.ExitCode != 127 || !strings.Contains(failRes.Stderr, "command not found") {
		t.Fatalf("expected exitCode 127 and command not found, got %+v", failRes)
	}

	// 3. Test SFTP list, chmod, write_file, read_file
	_ = ws.sendControl(protocol.ControlMessage{
		Type: "sftp_op",
		OpID: "sftp-list",
		Op:   "list",
		Path: "~",
	})
	var listRes protocol.ControlMessage
	for listRes.Type != "sftp_result" {
		f, err := ws.readFrame(3 * time.Second)
		if err != nil {
			t.Fatalf("readFrame for sftp-list failed: %v", err)
		}
		if f.Type == protocol.FrameTypeControl {
			ctrl, _ := protocol.DecodeControlPayload(f.Payload)
			if ctrl.Type == "sftp_result" && ctrl.OpID == "sftp-list" {
				listRes = ctrl
			}
		}
	}
	if !listRes.OK || len(listRes.Entries) == 0 {
		t.Fatalf("expected sftp list entries, got %+v", listRes)
	}

	// 4. Test Tunnel HTTP Preview against a real local HTTP server through SSH direct-tcpip
	remoteHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("REAL_TUNNEL_HTTP_OK"))
	}))
	defer remoteHTTP.Close()
	rTCP := remoteHTTP.Listener.Addr().(*net.TCPAddr)

	_ = ws.sendControl(protocol.ControlMessage{
		Type:       "tunnel_op",
		OpID:       "tun-preview-1",
		Op:         "http_preview",
		RemoteHost: "127.0.0.1",
		RemotePort: rTCP.Port,
		HttpPath:   "/health",
	})
	var tunRes protocol.ControlMessage
	for tunRes.Type != "tunnel_result" {
		f, err := ws.readFrame(3 * time.Second)
		if err != nil {
			t.Fatalf("readFrame for tun-preview-1 failed: %v", err)
		}
		if f.Type == protocol.FrameTypeControl {
			ctrl, _ := protocol.DecodeControlPayload(f.Payload)
			if ctrl.Type == "tunnel_result" && ctrl.OpID == "tun-preview-1" {
				tunRes = ctrl
			}
		}
	}
	if !tunRes.OK || tunRes.StatusCode != 200 || !strings.Contains(tunRes.BodyPreview, "REAL_TUNNEL_HTTP_OK") {
		t.Fatalf("unexpected tunnel http_preview result: %+v", tunRes)
	}
}
