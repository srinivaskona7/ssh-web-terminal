package main

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/webssh-studio/gateway/internal/protocol"
)

func TestValidateEnv(t *testing.T) {
	tooMany := map[string]string{}
	for i := 0; i < 33; i++ {
		tooMany[fmt.Sprintf("VAR_%02d", i)] = "x"
	}
	limit := map[string]string{}
	for i := 0; i < 32; i++ {
		limit[fmt.Sprintf("VAR_%02d", i)] = "x"
	}
	cases := []struct {
		name    string
		env     map[string]string
		wantErr string // substring; "" means valid
	}{
		{"empty", nil, ""},
		{"locale", map[string]string{"LANG": "C.UTF-8", "LC_ALL": "C"}, ""},
		{"underscore start", map[string]string{"_PRIVATE": "1"}, ""},
		{"64-char name", map[string]string{"A" + strings.Repeat("b", 63): "x"}, ""},
		{"32 variables", limit, ""},
		{"4096-byte value", map[string]string{"BIG": strings.Repeat("v", 4096)}, ""},
		{"empty value", map[string]string{"EMPTY": ""}, ""},
		{"leading digit", map[string]string{"1BAD": "x"}, `"1BAD"`},
		{"hyphen", map[string]string{"BAD-NAME": "x"}, `"BAD-NAME"`},
		{"equals sign", map[string]string{"A=B": "x"}, `"A=B"`},
		{"empty name", map[string]string{"": "x"}, `""`},
		{"65-char name", map[string]string{"A" + strings.Repeat("b", 64): "x"}, "invalid name"},
		{"33 variables", tooMany, "33"},
		{"4097-byte value", map[string]string{"BIG": strings.Repeat("v", 4097)}, `"BIG"`},
		{"NUL in value", map[string]string{"NULLY": "a\x00b"}, `"NULLY"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateEnv(tc.env)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("expected valid, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected an error naming %s", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error %q does not name %s", err, tc.wantErr)
			}
		})
	}
}

func TestConnectAppliesEnvToEveryPtyAndReportsNamesOnly(t *testing.T) {
	sshd := newTestSSHD(t, "secret-pass")
	srv, auditLog := newTestGateway(t)
	ws := dialTestWS(t, srv.URL, "http://localhost:5173")
	defer ws.conn.Close()

	msg := passwordConnect(sshd, "secret-pass")
	msg.Env = map[string]string{
		"LANG":         "C.UTF-8",
		"LC_TIME":      "en_GB.UTF-8",
		"DEPLOY_TOKEN": "tok-never-logged",
	}
	connected := ws.connect(t, msg, nil).mustConnect(t)
	wantAccepted, wantRejected := []string{"LANG", "LC_TIME"}, []string{"DEPLOY_TOKEN"}
	if !slices.Equal(connected.EnvAccepted, wantAccepted) || !slices.Equal(connected.EnvRejected, wantRejected) {
		t.Fatalf("connected env = accepted %v rejected %v, want %v %v", connected.EnvAccepted, connected.EnvRejected, wantAccepted, wantRejected)
	}
	if err := ws.sendPty(connected.PtyChannel, []byte("printenv LANG\r")); err != nil {
		t.Fatalf("sendPty failed: %v", err)
	}
	ws.readPtyUntil(t, connected.PtyChannel, "C.UTF-8", 5*time.Second)

	// Every later PTY gets the same variables and its own report.
	if err := ws.sendControl(protocol.ControlMessage{Type: "open_channel", OpID: "second", Cols: 80, Rows: 24}); err != nil {
		t.Fatalf("send open_channel failed: %v", err)
	}
	var opened protocol.ControlMessage
	for opened.Type != "channel_opened" {
		opened, _ = ws.nextControl(t, 5*time.Second)
	}
	if !opened.OK || !slices.Equal(opened.EnvAccepted, wantAccepted) || !slices.Equal(opened.EnvRejected, wantRejected) {
		t.Fatalf("channel_opened = %+v", opened)
	}
	if err := ws.sendPty(opened.Channel, []byte("printenv LC_TIME\r")); err != nil {
		t.Fatalf("sendPty on the second channel failed: %v", err)
	}
	ws.readPtyUntil(t, opened.Channel, "en_GB.UTF-8", 5*time.Second)

	// Commands and streams never get the variables.
	if err := ws.sendControl(protocol.ControlMessage{Type: "exec_command", OpID: "env-exec", Command: "printenv LANG"}); err != nil {
		t.Fatalf("send exec_command failed: %v", err)
	}
	var execRes protocol.ControlMessage
	for execRes.Type != "exec_result" {
		execRes, _ = ws.nextControl(t, 5*time.Second)
	}
	if execRes.ExitCode != 1 || execRes.Stdout != "" {
		t.Fatalf("expected LANG to be unset for exec_command, got %+v", execRes)
	}
	startStream(t, ws, "env-stream", "printenv")
	events, _ := collectUntilEnd(t, ws, "env-stream", 5*time.Second)
	if out := streamText(events, "stdout"); out != "" {
		t.Fatalf("expected no environment in exec_stream, got %q", out)
	}

	// On the wire: env requests precede pty-req on PTY sessions and never
	// appear on exec or SFTP sessions.
	ptySessions := 0
	for i, reqs := range sshd.RequestLog() {
		envCount := 0
		for _, r := range reqs {
			if r == "env" {
				envCount++
			}
		}
		pty := slices.Index(reqs, "pty-req")
		switch {
		case pty >= 0:
			ptySessions++
			if envCount != 3 || slices.Index(reqs, "env") > pty || slices.Contains(reqs[pty:], "env") {
				t.Fatalf("session %d: expected 3 env requests before pty-req, got %v", i, reqs)
			}
		case envCount > 0:
			t.Fatalf("session %d without a PTY received env requests: %v", i, reqs)
		}
	}
	if ptySessions != 2 {
		t.Fatalf("expected two PTY sessions, got %d in %v", ptySessions, sshd.RequestLog())
	}

	logged := auditLog.String()
	if !strings.Contains(logged, `"envAccepted":["LANG","LC_TIME"]`) || !strings.Contains(logged, `"envRejected":["DEPLOY_TOKEN"]`) {
		t.Fatalf("expected the audit record to name the variables, got %s", logged)
	}
	for _, value := range []string{"tok-never-logged", "C.UTF-8", "en_GB.UTF-8"} {
		if strings.Contains(logged, value) {
			t.Fatalf("audit log leaked env value %q: %s", value, logged)
		}
	}
}

func TestConnectRejectsInvalidEnvBeforeDialling(t *testing.T) {
	sshd := newTestSSHD(t, "secret-pass")
	srv, _ := newTestGateway(t)

	for name, env := range map[string]map[string]string{
		"BAD-NAME": {"LANG": "C", "BAD-NAME": "x"},
		"NULLY":    {"NULLY": "a\x00b"},
	} {
		ws := dialTestWS(t, srv.URL, "http://localhost:5173")
		msg := passwordConnect(sshd, "secret-pass")
		msg.Env = env
		out := ws.connect(t, msg, nil)
		_ = ws.conn.Close()
		if out.failure == nil || out.failure.Code != "invalid_env" || !out.failure.Fatal || !strings.Contains(out.failure.Message, name) {
			t.Fatalf("expected a fatal invalid_env naming %s, got %+v", name, out.failure)
		}
		if len(out.prompts) != 0 {
			t.Fatalf("invalid env must fail before any SSH handshake, got %d host-key prompts", len(out.prompts))
		}
	}
	if log := sshd.RequestLog(); len(log) != 0 {
		t.Fatalf("expected no session on the server, got %v", log)
	}
}
