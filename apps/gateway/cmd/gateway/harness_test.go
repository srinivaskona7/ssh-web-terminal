package main

import (
	"encoding/base64"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/webssh-studio/gateway/internal/protocol"
	"github.com/webssh-studio/gateway/internal/testsshd"
	"golang.org/x/crypto/ssh"
)

// newTestGateway serves the gateway over httptest with an audit sink the test
// can read back.
func newTestGateway(t *testing.T) (*httptest.Server, *lockedBuffer) {
	t.Helper()
	auditLog := &lockedBuffer{}
	handler, err := NewMux(ServerConfig{
		ListenAddr:         ":0",
		AllowedOrigins:     []string{"http://localhost:5173"},
		DestAllowlist:      []string{"127.0.0.1"},
		DestDenylist:       []string{},
		SessionGrace:       time.Minute,
		RingBufferBytes:    65536,
		MaxSessionsPerUser: 10,
		RateLimitPerSec:    200,
		AuditWriter:        auditLog,
	})
	if err != nil {
		t.Fatalf("NewMux failed: %v", err)
	}
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv, auditLog
}

func newTestSSHD(t *testing.T, password string, keys ...ssh.PublicKey) *testsshd.Server {
	t.Helper()
	sshd, err := testsshd.NewServer(t.TempDir(), password, keys)
	if err != nil {
		t.Fatalf("testsshd.NewServer failed: %v", err)
	}
	t.Cleanup(func() { _ = sshd.Close() })
	return sshd
}

// nextControl skips PTY data and returns the next control message with its
// raw JSON, so a test can tell an omitted field from a zero one.
func (c *testWSClient) nextControl(t *testing.T, timeout time.Duration) (protocol.ControlMessage, []byte) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("no control message within %s", timeout)
		}
		f, err := c.readFrame(remaining)
		if err != nil {
			t.Fatalf("readFrame failed: %v", err)
		}
		if f.Type != protocol.FrameTypeControl {
			continue
		}
		ctrl, err := protocol.DecodeControlPayload(f.Payload)
		if err != nil {
			t.Fatalf("DecodeControlPayload failed: %v", err)
		}
		return ctrl, f.Payload
	}
}

// readPtyUntil collects PTY output on one channel until it contains want.
func (c *testWSClient) readPtyUntil(t *testing.T, channel uint16, want string, timeout time.Duration) string {
	t.Helper()
	var out strings.Builder
	deadline := time.Now().Add(timeout)
	for !strings.Contains(out.String(), want) {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("PTY channel %d never printed %q; got %q", channel, want, out.String())
		}
		f, err := c.readFrame(remaining)
		if err != nil {
			t.Fatalf("readFrame on PTY channel %d failed after %q: %v", channel, out.String(), err)
		}
		if f.Type == protocol.FrameTypePtyData && f.Channel == channel {
			out.Write(f.Payload)
		}
	}
	return out.String()
}

type connectOutcome struct {
	connected    protocol.ControlMessage
	raw          []byte
	prompts      []protocol.ControlMessage
	signRequests []protocol.ControlMessage
	signRaw      [][]byte
	failure      *protocol.ControlMessage
}

// connect sends msg, trusts every host key, answers each sign_request with
// sign (nil answers with an empty signature), and stops at connected or error.
func (c *testWSClient) connect(t *testing.T, msg protocol.ControlMessage, sign func(protocol.ControlMessage) []byte) connectOutcome {
	t.Helper()
	if err := c.sendControl(msg); err != nil {
		t.Fatalf("send connect failed: %v", err)
	}
	var out connectOutcome
	for {
		ctrl, raw := c.nextControl(t, 15*time.Second)
		switch ctrl.Type {
		case "hostkey_prompt":
			out.prompts = append(out.prompts, ctrl)
			if err := c.sendControl(protocol.ControlMessage{Type: "hostkey_decision", Trusted: true}); err != nil {
				t.Fatalf("send hostkey_decision failed: %v", err)
			}
		case "sign_request":
			out.signRequests = append(out.signRequests, ctrl)
			out.signRaw = append(out.signRaw, raw)
			var sig []byte
			if sign != nil {
				sig = sign(ctrl)
			}
			if err := c.sendControl(protocol.ControlMessage{
				Type:            "sign_response",
				RequestID:       ctrl.RequestID,
				SignatureBase64: base64.StdEncoding.EncodeToString(sig),
			}); err != nil {
				t.Fatalf("send sign_response failed: %v", err)
			}
		case "connected":
			out.connected, out.raw = ctrl, raw
			return out
		case "error":
			out.failure = &ctrl
			return out
		}
	}
}

func (o connectOutcome) mustConnect(t *testing.T) protocol.ControlMessage {
	t.Helper()
	if o.failure != nil {
		t.Fatalf("connect failed: %s %s", o.failure.Code, o.failure.Message)
	}
	return o.connected
}

// passwordConnect is the plain single-host connect most tests start from.
func passwordConnect(sshd *testsshd.Server, password string) protocol.ControlMessage {
	host, port := sshd.HostPort()
	return protocol.ControlMessage{
		Type:       "connect",
		Host:       host,
		Port:       port,
		User:       "ubuntu",
		AuthMethod: "password",
		Password:   password,
		Cols:       80,
		Rows:       24,
	}
}

func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", timeout, what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// execStreamGoroutines counts goroutines whose stack is inside the exec-stream
// code. It reads every live stack, so a forgotten goroutine cannot hide behind
// a counter that was decremented by mistake.
func execStreamGoroutines() int {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]byte, 2*len(buf))
	}
	count := 0
	for _, g := range strings.Split(string(buf), "\n\n") {
		if strings.Contains(g, "/cmd/gateway/execstream.go:") {
			count++
		}
	}
	return count
}
